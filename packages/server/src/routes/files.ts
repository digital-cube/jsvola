import fastifyMultipart from "@fastify/multipart";
import {
  errorResponse,
  type FileInfo,
  type FileList,
  FORCE_DOWNLOAD_QUERY,
  type PurgeResult,
  UPLOAD_FILE_FIELD,
  UPLOAD_METADATA_FIELD,
} from "@vola/core";
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import type { FileRow } from "../db/schema.js";
import { VolaError } from "../errors.js";
import {
  contentRange,
  parseByteRange,
  RangeNotSatisfiableError,
  rangeLength,
} from "../files/byte-range.js";
import { contentDisposition, dispositionFor } from "../files/content-disposition.js";
import type { LastUsedThrottle } from "../services/apikeys.js";
import {
  type FilesDeps,
  finalizeUpload,
  findFile,
  findFileBySlug,
  listFiles,
  openFile,
  parseInstance,
  parseMetadata,
  parseSlug,
  purgeFile,
  type StagedUpload,
  serializeFile,
  softDeleteFile,
  stageUpload,
  touchLastAccessed,
} from "../services/files.js";
import type { StorageBackend } from "../storage/index.js";

export interface FileRoutesDeps {
  db: Database;
  storage: StorageBackend;
  /** `VOLA_MAX_UPLOAD_BYTES`. */
  maxUploadBytes: number;
  accessThrottle?: LastUsedThrottle | undefined;
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
}

const READ = { scope: "files:read" } as const;
const WRITE = { scope: "files:write" } as const;

/** Multipart fields of a later ticket (folders, versions — 2.2): refused for now, not ignored. */
const NOT_YET_SUPPORTED = ["folder_path", "parent_id"];

interface InstanceParams {
  type: string;
  id: string;
}
interface FileParams extends InstanceParams {
  fileId: string;
}
interface SlugParams extends InstanceParams {
  slug: string;
}
interface DownloadQuery {
  [FORCE_DOWNLOAD_QUERY]?: string;
}
interface ListQuery {
  cursor?: string;
  limit?: string;
  include_deleted?: string;
}
interface InfoQuery {
  include_deleted?: string;
}

const flag = (value: string | undefined): boolean => value === "1" || value === "true";

/** `If-None-Match` matches `etag` (strong or weak form of it, or `*`). */
export function ifNoneMatchMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  return value.split(",").some((tag) => {
    const trimmed = tag.trim().replace(/^W\//, "");
    return trimmed === "*" || trimmed === etag;
  });
}

/**
 * Files of an instance (`/files/:type/:id…`). Everything is tenant-scoped through
 * `requireTenant()`: another tenant's file is `404 file_not_found`, never 403.
 *
 * - `POST /files/:type/:id` (multipart, streamed into storage) and
 *   `PUT /files/:type/:id/slug/:slug` (upsert of a named file) — `files:write`;
 * - `GET|HEAD …/:fileId`, `…/slug/:slug` — `files:read`: `Range`/`206`, `ETag`/`304`,
 *   `Content-Disposition` (inline for media and PDF), `X-Content-Type-Options: nosniff`;
 * - `GET …/:fileId/info`, `GET /files/:type/:id` (cursor list) — `files:read`;
 * - `DELETE …/:fileId` (soft), `DELETE …/:fileId/purge` — `files:write`.
 */
export const fileRoutes: FastifyPluginAsync<FileRoutesDeps> = async (app, deps) => {
  const service: FilesDeps = {
    db: deps.db,
    storage: deps.storage,
    accessThrottle: deps.accessThrottle,
    logger: deps.logger ?? app.log,
    now: deps.now,
  };

  await app.register(fastifyMultipart, {
    // At the limit busboy truncates the part (and flags it) instead of throwing: the handler
    // answers `413 file_too_large` itself, after dropping the staged bytes.
    throwFileSizeLimit: false,
    limits: {
      fileSize: deps.maxUploadBytes,
      fields: 20,
      fieldSize: 64 * 1024,
      parts: 30,
    },
  });

  const scopeOf = (request: FastifyRequest<{ Params: InstanceParams }>) =>
    parseInstance(requireTenant().tenantId, request.params.type, request.params.id);

  /** Streams the one `file` part into storage while collecting the text fields, then records the row. */
  async function handleUpload(
    request: FastifyRequest<{ Params: InstanceParams }>,
    reply: FastifyReply,
    slug: string | null,
  ): Promise<FileInfo> {
    const tenant = requireTenant();
    const scope = scopeOf(request);
    if (!request.isMultipart()) {
      throw new VolaError("unsupported_media_type", 415, "the body must be multipart/form-data");
    }

    let upload: StagedUpload | undefined;
    let filename: string | undefined;
    let declaredMime: string | undefined;
    const fields: Record<string, string> = {};
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== UPLOAD_FILE_FIELD) {
            throw new VolaError(
              "bad_request",
              400,
              `unexpected file field "${part.fieldname}"; use "${UPLOAD_FILE_FIELD}"`,
            );
          }
          if (upload) throw new VolaError("bad_request", 400, "exactly one file part is allowed");
          upload = await stageUpload(service, part.file, { maxBytes: deps.maxUploadBytes });
          if (part.file.truncated) {
            throw new VolaError(
              "file_too_large",
              413,
              `the file exceeds the upload limit of ${deps.maxUploadBytes} bytes`,
            );
          }
          filename = part.filename;
          declaredMime = part.mimetype;
        } else {
          fields[part.fieldname] = typeof part.value === "string" ? part.value : String(part.value);
        }
      }
      if (!upload)
        throw new VolaError("file_required", 400, `a "${UPLOAD_FILE_FIELD}" part is required`);
      const unsupported = NOT_YET_SUPPORTED.filter((name) => fields[name] !== undefined);
      if (unsupported.length > 0) {
        throw new VolaError(
          "not_supported",
          400,
          `${unsupported.join(", ")}: not supported yet (folders and versions arrive with 2.2)`,
        );
      }
      const metadata = parseMetadata(fields[UPLOAD_METADATA_FIELD]);
      const info = await finalizeUpload(service, {
        scope,
        upload,
        filename,
        declaredMime,
        metadata,
        slug,
        userId: tenant.userId,
      });
      upload = undefined; // finalizeUpload owns the staged blob from here (committed or discarded)
      request.log.info(
        {
          file: info.id,
          hash: info.hash,
          size: info.size,
          slug: info.slug,
          instance: `${scope.instanceType}/${scope.instanceId}`,
        },
        "file uploaded",
      );
      reply.status(201);
      return info;
    } catch (error) {
      if (upload) await service.storage.discard(upload.staged).catch(() => undefined);
      throw error;
    }
  }

  app.post<{ Params: InstanceParams }>("/files/:type/:id", { config: WRITE }, (request, reply) =>
    handleUpload(request, reply, null),
  );

  app.put<{ Params: SlugParams }>(
    "/files/:type/:id/slug/:slug",
    { config: WRITE },
    (request, reply) => handleUpload(request, reply, parseSlug(request.params.slug)),
  );

  /** The body (or, for HEAD, only the headers) of `row`, honouring Range and If-None-Match. */
  async function sendFile(
    request: FastifyRequest<{ Querystring: DownloadQuery }>,
    reply: FastifyReply,
    row: FileRow,
  ): Promise<FastifyReply> {
    const isHead = request.method === "HEAD";
    const size = Number(row.size);
    const etag = `"${row.hash}"`;
    reply
      .header("etag", etag)
      .header("accept-ranges", "bytes")
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-cache")
      .header("last-modified", row.createdAt.toUTCString())
      .header(
        "content-disposition",
        contentDisposition(
          row.filename,
          dispositionFor(row.mimeType, flag(request.query[FORCE_DOWNLOAD_QUERY])),
        ),
      );
    if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
      return reply.status(304).send();
    }

    let range: ReturnType<typeof parseByteRange>;
    try {
      range = parseByteRange(request.headers.range, size);
    } catch (error) {
      if (!(error instanceof RangeNotSatisfiableError)) throw error;
      reply.status(416).header("content-range", `bytes */${size}`);
      if (isHead) return reply.send();
      return reply.send(
        errorResponse(
          "range_not_satisfiable",
          `the requested range is outside the file of ${size} bytes`,
        ),
      );
    }

    if (!isHead) touchLastAccessed(service, row.id, requireTenant().userId);
    reply.type(row.mimeType);
    if (range) {
      reply
        .status(206)
        .header("content-range", contentRange(range, size))
        .header("content-length", String(rangeLength(range)));
    } else {
      reply.header("content-length", String(size));
    }
    if (isHead) return reply.send();
    return reply.send(await openFile(service, row, range ?? undefined));
  }

  app.route<{ Params: FileParams; Querystring: DownloadQuery }>({
    method: ["GET", "HEAD"],
    url: "/files/:type/:id/:fileId",
    config: READ,
    handler: async (request, reply) => {
      const row = await findFile(service, scopeOf(request), request.params.fileId);
      return sendFile(request, reply, row);
    },
  });

  app.route<{ Params: SlugParams; Querystring: DownloadQuery }>({
    method: ["GET", "HEAD"],
    url: "/files/:type/:id/slug/:slug",
    config: READ,
    handler: async (request, reply) => {
      const row = await findFileBySlug(service, scopeOf(request), parseSlug(request.params.slug));
      return sendFile(request, reply, row);
    },
  });

  /** Metadata without the bytes (and never `fk_ct` / `meta_ct`). `?include_deleted=1` sees a soft-deleted file. */
  app.get<{ Params: FileParams; Querystring: InfoQuery }>(
    "/files/:type/:id/:fileId/info",
    { config: READ },
    async (request): Promise<FileInfo> => {
      const row = await findFile(service, scopeOf(request), request.params.fileId, {
        includeDeleted: flag(request.query.include_deleted),
      });
      return serializeFile(row);
    },
  );

  /** The instance's files, newest first; `?cursor`, `?limit` (≤ 200), `?include_deleted=1`. */
  app.get<{ Params: InstanceParams; Querystring: ListQuery }>(
    "/files/:type/:id",
    { config: READ },
    async (request): Promise<FileList> =>
      listFiles(service, scopeOf(request), {
        cursor: request.query.cursor,
        limit: request.query.limit,
        includeDeleted: flag(request.query.include_deleted),
      }),
  );

  /** Soft delete; idempotent; the bytes stay. */
  app.delete<{ Params: FileParams }>(
    "/files/:type/:id/:fileId",
    { config: WRITE },
    async (request): Promise<FileInfo> => {
      const info = await softDeleteFile(
        service,
        scopeOf(request),
        request.params.fileId,
        requireTenant().userId,
      );
      request.log.info({ file: info.id }, "file soft-deleted");
      return info;
    },
  );

  /** Permanent delete of the row (and its version chain) and of blobs nothing references any more. */
  app.delete<{ Params: FileParams }>(
    "/files/:type/:id/:fileId/purge",
    { config: WRITE },
    async (request): Promise<PurgeResult> => {
      const result = await purgeFile(service, scopeOf(request), request.params.fileId);
      request.log.info({ file: request.params.fileId, ...result }, "file purged");
      return result;
    },
  );
};

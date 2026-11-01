import fastifyMultipart from "@fastify/multipart";
import {
  ENCRYPTION_HEADER,
  type FileDetail,
  type FileEncryption,
  type FileInfo,
  type FileList,
  FilePatchSchema,
  type FileVersions,
  OCR_QUERY_FULL,
  type PurgeResult,
  splitFilePath,
  UPLOAD_ENCRYPTION_FIELD,
  UPLOAD_FILE_FIELD,
  UPLOAD_FOLDER_ID_FIELD,
  UPLOAD_FOLDER_PATH_FIELD,
  UPLOAD_METADATA_FIELD,
  UPLOAD_PARENT_ID_FIELD,
} from "@vola/core";
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { AuditLog } from "../audit/log.js";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import { VolaError } from "../errors.js";
import type { FileEventBus } from "../events/bus.js";
import type { JobDispatcher } from "../jobs/dispatcher.js";
import type { Lookups } from "../lookups.js";
import type { LastUsedThrottle } from "../services/apikeys.js";
import type { EncryptionService } from "../services/encryption.js";
import {
  type FilesDeps,
  finalizeUpload,
  findFile,
  findFileBySlug,
  findFileInFolder,
  findReadableFile,
  listFiles,
  listVersions,
  parseInstance,
  parseMetadata,
  parseSlug,
  patchFile,
  purgeFile,
  type StagedUpload,
  softDeleteFile,
  stageUpload,
  withProcessingStatus,
} from "../services/files.js";
import {
  type FoldersDeps,
  findFolder,
  findFolderById,
  parsePath,
  resolveFolderId,
} from "../services/folders.js";
import { ocrInfoOf } from "../services/ocr.js";
import type { StorageBackend } from "../storage/index.js";
import { type DownloadQuery, flag, sendFile } from "./send-file.js";

export { ifNoneMatchMatches } from "./send-file.js";

export interface FileRoutesDeps {
  db: Database;
  storage: StorageBackend;
  /** `VOLA_MAX_UPLOAD_BYTES`. */
  maxUploadBytes: number;
  accessThrottle?: LastUsedThrottle | undefined;
  logger?: FastifyBaseLogger | undefined;
  /** The vocabulary unknown `kind` / `encryption` values are recorded against. */
  lookups?: Lookups | undefined;
  /** Where every change is announced after its commit (real-time `subscribe`). */
  events?: FileEventBus | undefined;
  /** Background jobs of a new file (`async` mode); absent in `sync` mode. */
  jobs?: JobDispatcher | undefined;
  /** The audit trail: soft delete, purge, visibility change. */
  audit?: AuditLog | undefined;
  /** Encryption (plan 6.1): providers and the row-level open; absent → encrypted files are `503`. */
  crypto?: EncryptionService | undefined;
  now?: (() => Date) | undefined;
}

const READ = { scope: "files:read" } as const;
const WRITE = { scope: "files:write" } as const;

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
interface PathParams extends InstanceParams {
  "*": string;
}
interface ListQuery {
  cursor?: string;
  limit?: string;
  include_deleted?: string;
}
interface InfoQuery {
  include_deleted?: string;
  /** `full`: the whole OCR text under `ocr.text` (the preview is always there). */
  ocr?: string;
}

/**
 * Files of an instance (`/files/:type/:id…`). Everything is tenant-scoped through
 * `requireTenant()`: another tenant's file is `404 file_not_found`, never 403 — except a
 * file its owner marked `is_public`, which any authenticated tenant may download by id.
 *
 * - `POST /files/:type/:id` (multipart, streamed into storage; `folder_path` or `folder_id`
 *   places it, `parent_id` makes it a new version) and `PUT /files/:type/:id/slug/:slug`
 *   (upsert of a named file) — `files:write`;
 * - `GET|HEAD …/:fileId`, `…/slug/:slug`, `…/path/*` — `files:read`: `Range`/`206`,
 *   `ETag`/`304`, `Content-Disposition` (inline for media and PDF), `nosniff`;
 * - `GET …/:fileId/info` (with the aggregate `processing_status` of its jobs and the `ocr`
 *   block: status, language, pages, the first 500 characters; `?ocr=full` the whole text),
 *   `…/:fileId/versions`, `GET /files/:type/:id` (cursor list) — `files:read`;
 * - `GET|HEAD …/:fileId/thumb/:size` lives in `thumbnailRoutes`;
 * - `PATCH …/:fileId` (move, rename, visibility) — `files:write`;
 * - `DELETE …/:fileId` (soft), `DELETE …/:fileId/purge` — `files:write`.
 */
export const fileRoutes: FastifyPluginAsync<FileRoutesDeps> = async (app, deps) => {
  const service: FilesDeps = {
    db: deps.db,
    storage: deps.storage,
    accessThrottle: deps.accessThrottle,
    logger: deps.logger ?? app.log,
    lookups: deps.lookups,
    events: deps.events,
    jobs: deps.jobs,
    audit: deps.audit,
    crypto: deps.crypto,
    now: deps.now,
  };
  const folderService: FoldersDeps = {
    db: deps.db,
    logger: service.logger,
    events: deps.events,
    audit: deps.audit,
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

  /** The `encryption` an upload names, from a text field or the header; `undefined`: the tenant default. */
  const requestedEncryption = (raw: string | undefined): FileEncryption | undefined => {
    if (raw === undefined) return undefined;
    if (!deps.crypto)
      throw new VolaError("encryption_unavailable", 503, "encryption is not configured");
    return deps.crypto.parseMode(raw);
  };
  const headerValue = (request: FastifyRequest, name: string): string | undefined => {
    const raw = request.headers[name];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  /**
   * Streams the one `file` part into storage while collecting the text fields, then records
   * the row. The encryption mode must be known when the file part STARTS (it decides what is
   * written to disk), so it comes from `X-Vola-Encryption`, from an `encryption` field sent
   * before the file part, or from the tenant's default — a field after the file part is
   * accepted only when it agrees (`422` otherwise).
   */
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
    let encryption: FileEncryption | undefined = requestedEncryption(
      headerValue(request, ENCRYPTION_HEADER),
    );
    let usedEncryption: FileEncryption | undefined;
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
          usedEncryption = deps.crypto
            ? await deps.crypto.resolveMode(scope.tenantId, encryption)
            : "none";
          upload = await stageUpload(service, part.file, {
            maxBytes: deps.maxUploadBytes,
            encryption: usedEncryption,
          });
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
          const value = typeof part.value === "string" ? part.value : String(part.value);
          fields[part.fieldname] = value;
          if (part.fieldname === UPLOAD_ENCRYPTION_FIELD) {
            const named = requestedEncryption(value);
            if (upload && named !== undefined && named !== usedEncryption) {
              throw new VolaError(
                "validation_error",
                422,
                `${UPLOAD_ENCRYPTION_FIELD}: send it before the file part (or as ${ENCRYPTION_HEADER}); the file was already stored as "${usedEncryption}"`,
              );
            }
            encryption = named ?? encryption;
          }
        }
      }
      if (!upload)
        throw new VolaError("file_required", 400, `a "${UPLOAD_FILE_FIELD}" part is required`);
      const metadata = parseMetadata(fields[UPLOAD_METADATA_FIELD]);
      const parentId = fields[UPLOAD_PARENT_ID_FIELD];
      const parent = parentId ? await findFile(service, scope, parentId) : null;
      const folderPath = fields[UPLOAD_FOLDER_PATH_FIELD];
      const folderIdField = fields[UPLOAD_FOLDER_ID_FIELD];
      if (folderPath !== undefined && folderIdField !== undefined) {
        throw new VolaError(
          "validation_error",
          422,
          `${UPLOAD_FOLDER_PATH_FIELD} and ${UPLOAD_FOLDER_ID_FIELD} exclude each other`,
        );
      }
      // undefined: the parent's folder for a version, the root otherwise.
      let folderId: string | null | undefined;
      if (folderPath !== undefined) {
        folderId = await resolveFolderId(
          folderService,
          scope,
          parsePath(folderPath, UPLOAD_FOLDER_PATH_FIELD),
          tenant.userId,
        );
      } else if (folderIdField !== undefined) {
        folderId =
          folderIdField === ""
            ? null
            : (await findFolderById(folderService, scope, folderIdField)).id;
      }
      const info = await finalizeUpload(service, {
        scope,
        upload,
        filename,
        declaredMime,
        metadata,
        slug,
        folderId,
        parent,
        userId: tenant.userId,
      });
      upload = undefined; // finalizeUpload owns the staged blob from here (committed or discarded)
      request.log.info(
        {
          file: info.id,
          hash: info.hash,
          size: info.size,
          slug: info.slug,
          folder: info.folder_id,
          parent: info.parent_id,
          encryption: info.encryption,
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

  const download = { userId: () => requireTenant().userId };

  app.route<{ Params: FileParams; Querystring: DownloadQuery }>({
    method: ["GET", "HEAD"],
    url: "/files/:type/:id/:fileId",
    config: READ,
    handler: async (request, reply) => {
      const row = await findReadableFile(service, scopeOf(request), request.params.fileId);
      return sendFile(service, request, reply, row, { userId: download.userId() });
    },
  });

  app.route<{ Params: SlugParams; Querystring: DownloadQuery }>({
    method: ["GET", "HEAD"],
    url: "/files/:type/:id/slug/:slug",
    config: READ,
    handler: async (request, reply) => {
      const row = await findFileBySlug(service, scopeOf(request), parseSlug(request.params.slug));
      return sendFile(service, request, reply, row, { userId: download.userId() });
    },
  });

  /** `…/path/docs/q4/report.pdf`: the newest live file of that name in that folder (`…/path/report.pdf` is a root file). */
  app.route<{ Params: PathParams; Querystring: DownloadQuery }>({
    method: ["GET", "HEAD"],
    url: "/files/:type/:id/path/*",
    config: READ,
    handler: async (request, reply) => {
      const scope = scopeOf(request);
      const { folderPath, filename } = splitFilePath(request.params["*"]);
      const path = parsePath(folderPath);
      const folderId = path === "" ? null : (await findFolder(folderService, scope, path)).id;
      const row = await findFileInFolder(service, scope, folderId, filename);
      return sendFile(service, request, reply, row, { userId: download.userId() });
    },
  });

  /**
   * Metadata without the bytes (and never `fk_ct` / `meta_ct`), plus the `ocr` block.
   * `?include_deleted=1` sees a soft-deleted file; `?ocr=full` adds the whole OCR text. For
   * an encrypted file the real name, type and metadata come out of `meta_ct` — `503` when
   * the server has no key material for its mode, `409` when the record does not open.
   */
  app.get<{ Params: FileParams; Querystring: InfoQuery }>(
    "/files/:type/:id/:fileId/info",
    { config: READ },
    async (request, reply): Promise<FileDetail> => {
      const scope = scopeOf(request);
      const row = flag(request.query.include_deleted)
        ? await findFile(service, scope, request.params.fileId, { includeDeleted: true })
        : await findReadableFile(service, scope, request.params.fileId);
      const full = (request.query.ocr ?? "").toLowerCase() === OCR_QUERY_FULL;
      if (row.encryption !== "none") {
        if (!deps.crypto)
          throw new VolaError("encryption_unavailable", 503, "encryption is not configured");
        await deps.crypto.open(row); // 503 / 409 here, loudly, rather than a masked answer
        reply.header("cache-control", "no-store");
      }
      const [info, ocr] = await Promise.all([
        withProcessingStatus(service, row),
        ocrInfoOf(deps.db, row.id, { full }),
      ]);
      return { ...info, ocr };
    },
  );

  /** The version chain of the file, newest first; `?include_deleted=1` keeps soft-deleted versions. */
  app.get<{ Params: FileParams; Querystring: InfoQuery }>(
    "/files/:type/:id/:fileId/versions",
    { config: READ },
    async (request): Promise<FileVersions> =>
      listVersions(service, scopeOf(request), request.params.fileId, {
        includeDeleted: flag(request.query.include_deleted),
      }),
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

  /** Move (`folder_path`, `""` = root, created when missing), rename (`filename`) and/or visibility flags. */
  app.patch<{ Params: FileParams; Body: unknown }>(
    "/files/:type/:id/:fileId",
    { config: WRITE },
    async (request): Promise<FileInfo> => {
      const parsed = FilePatchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new VolaError(
          "validation_error",
          422,
          `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
        );
      }
      const tenant = requireTenant();
      const scope = scopeOf(request);
      const patch = parsed.data;
      const info = await patchFile(service, scope, request.params.fileId, {
        folderId:
          patch.folder_path === undefined
            ? undefined
            : await resolveFolderId(folderService, scope, patch.folder_path, tenant.userId),
        filename: patch.filename,
        isPublic: patch.is_public,
        isGlobalPublic: patch.is_global_public,
        userId: tenant.userId,
      });
      return info;
    },
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

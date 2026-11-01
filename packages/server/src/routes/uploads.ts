import type { Readable } from "node:stream";
import {
  decodeTusMetadata,
  ENCRYPTION_HEADER,
  encodeTusMetadata,
  TUS_EXTENSION_HEADER,
  TUS_EXTENSIONS,
  TUS_MAX_SIZE_HEADER,
  TUS_PATCH_CONTENT_TYPE,
  TUS_RESUMABLE_HEADER,
  TUS_VERSION,
  TUS_VERSION_HEADER,
  UPLOAD_DEFER_LENGTH_HEADER,
  UPLOAD_EXPIRES_HEADER,
  UPLOAD_LENGTH_HEADER,
  UPLOAD_META_KEYS,
  UPLOAD_METADATA_HEADER,
  UPLOAD_OFFSET_HEADER,
  VOLA_FILE_ID_HEADER,
} from "@vola/core";
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import type { UploadRow } from "../db/schema.js";
import { VolaError } from "../errors.js";
import type { FileEventBus } from "../events/bus.js";
import type { JobDispatcher } from "../jobs/dispatcher.js";
import type { Lookups } from "../lookups.js";
import type { EncryptionService } from "../services/encryption.js";
import {
  appendUpload,
  createUpload,
  deleteUpload,
  findUpload,
  sweepExpiredUploads,
  type UploadsDeps,
} from "../services/uploads.js";
import type { StorageBackend } from "../storage/index.js";
import { PartStore } from "../uploads/part-store.js";

export interface UploadRoutesDeps {
  db: Database;
  storage: StorageBackend;
  /** Directory of the part files (`<VOLA_STORAGE_PATH>/uploads`). */
  uploadsPath: string;
  /** `VOLA_MAX_UPLOAD_BYTES`. */
  maxUploadBytes: number;
  /** `VOLA_UPLOAD_TTL_HOURS`. */
  uploadTtlHours: number;
  /**
   * How often expired uploads are swept, in milliseconds; `0` disables the periodic sweep
   * (tests call `sweepExpiredUploads` themselves, and in `async` mode the worker runs it as a
   * repeatable BullMQ job). Default: every 15 minutes.
   */
  sweepIntervalMs?: number | undefined;
  /** Background jobs of a file completed by a resumable upload (`async` mode). */
  jobs?: JobDispatcher | undefined;
  logger?: FastifyBaseLogger | undefined;
  /** The vocabulary unknown `kind` / `encryption` values are recorded against. */
  lookups?: Lookups | undefined;
  /** Where the completed file is announced after its commit (real-time `subscribe`). */
  events?: FileEventBus | undefined;
  /** Encryption (plan 6.1): `encryption` in `Upload-Metadata` or `X-Vola-Encryption` at creation. */
  crypto?: EncryptionService | undefined;
  now?: (() => Date) | undefined;
}

const WRITE = { scope: "files:write" } as const;
const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60_000;
const INTEGER_RE = /^\d{1,16}$/;

interface UploadParams {
  uploadId: string;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** `Content-Length` as a number, `undefined` when absent or not a plain integer. */
function contentLength(request: FastifyRequest): number | undefined {
  const raw = header(request, "content-length")?.trim();
  return raw !== undefined && INTEGER_RE.test(raw) ? Number(raw) : undefined;
}

/** A non-negative integer header, `400 bad_request` otherwise. */
function integerHeader(request: FastifyRequest, name: string, label: string): number {
  const raw = header(request, name)?.trim();
  if (raw === undefined || raw === "" || !INTEGER_RE.test(raw)) {
    throw new VolaError("bad_request", 400, `${label}: a non-negative integer is required`);
  }
  return Number(raw);
}

/**
 * `POST|HEAD|PATCH|DELETE /uploads` — resumable uploads, tus 1.0 core + `creation`,
 * `termination`, `expiration`, implemented natively (phase 6.3 cuts this byte stream into
 * encrypted segments, which no external tus server would let us do). `tus-js-client` works
 * unchanged: `Upload-Metadata` carries `instance_type`, `instance_id`, `filename` (required)
 * and optionally `folder_path`, `parent_id`, `slug`, `content_type` (or tus's `filetype`) and
 * `metadata` (a JSON object as text). Every route needs `files:write` except `OPTIONS`;
 * an upload belongs to the tenant, so any `files:write` key of it may resume one. Completion
 * takes the SAME path as `POST /files`: the last PATCH answers with `Vola-File-Id`, and so
 * does every `HEAD` after it.
 */
export const uploadRoutes: FastifyPluginAsync<UploadRoutesDeps> = async (app, deps) => {
  const logger = deps.logger ?? app.log;
  const parts = new PartStore(deps.uploadsPath);
  const service: UploadsDeps = {
    db: deps.db,
    storage: deps.storage,
    parts,
    maxUploadBytes: deps.maxUploadBytes,
    ttlMs: deps.uploadTtlHours * 3_600_000,
    logger,
    lookups: deps.lookups,
    events: deps.events,
    jobs: deps.jobs,
    crypto: deps.crypto,
    now: deps.now,
  };

  // The PATCH body is the raw byte stream; nothing buffers it.
  app.addContentTypeParser(TUS_PATCH_CONTENT_TYPE, (_request, payload, done) =>
    done(null, payload),
  );

  // `Tus-Resumable` on every response of this plugin, error envelopes included.
  app.addHook("onSend", async (_request, reply) => {
    reply.header(TUS_RESUMABLE_HEADER, TUS_VERSION);
  });

  // Every request but OPTIONS must speak our protocol version: `412` with `Tus-Version` otherwise.
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || request.is404) return;
    const version = header(request, TUS_RESUMABLE_HEADER);
    if (version !== TUS_VERSION) {
      reply.header(TUS_VERSION_HEADER, TUS_VERSION);
      throw new VolaError(
        "tus_version_unsupported",
        412,
        `Tus-Resumable: ${TUS_VERSION} is required (got ${version ?? "nothing"})`,
      );
    }
  });

  const location = (row: UploadRow) => `${app.prefix}/uploads/${row.id}`;

  function describe(reply: FastifyReply, row: UploadRow): void {
    reply.header(UPLOAD_OFFSET_HEADER, String(row.offset));
    reply.header(UPLOAD_LENGTH_HEADER, String(row.length));
    reply.header(UPLOAD_EXPIRES_HEADER, row.expiresAt.toUTCString());
    if (row.completedFileId) reply.header(VOLA_FILE_ID_HEADER, row.completedFileId);
  }

  /** The protocol: version, extensions, the size limit. No key needed, it reveals only configuration. */
  app.options("/uploads", { config: { auth: "none" } }, async (_request, reply) => {
    reply
      .status(204)
      .header(TUS_VERSION_HEADER, TUS_VERSION)
      .header(TUS_EXTENSION_HEADER, TUS_EXTENSIONS.join(","))
      .header(TUS_MAX_SIZE_HEADER, String(deps.maxUploadBytes));
    return reply.send();
  });

  /** Creation: `Upload-Length` + `Upload-Metadata` → `201`, `Location`, `Upload-Expires`. */
  app.post("/uploads", { config: WRITE }, async (request, reply) => {
    const tenant = requireTenant();
    if (header(request, UPLOAD_DEFER_LENGTH_HEADER) !== undefined) {
      throw new VolaError(
        "upload_defer_length_unsupported",
        400,
        "Upload-Defer-Length is not supported: send Upload-Length",
      );
    }
    const length = integerHeader(request, UPLOAD_LENGTH_HEADER, "Upload-Length");
    const meta = decodeTusMetadata(header(request, UPLOAD_METADATA_HEADER));
    if (meta === null) {
      throw new VolaError(
        "bad_request",
        400,
        "Upload-Metadata: comma-separated `key base64value` pairs, each key once",
      );
    }
    const required = (key: string): string => {
      const value = meta[key];
      if (value === undefined || value === "") {
        throw new VolaError("validation_error", 422, `Upload-Metadata: ${key} is required`);
      }
      return value;
    };
    const K = UPLOAD_META_KEYS;
    const { upload, file } = await createUpload(service, {
      tenantId: tenant.tenantId,
      apiKeyId: tenant.apiKeyId,
      userId: tenant.userId,
      length,
      instanceType: required(K.instanceType),
      instanceId: required(K.instanceId),
      filename: required(K.filename),
      folderPath: meta[K.folderPath],
      parentId: meta[K.parentId],
      slug: meta[K.slug],
      contentType: meta[K.contentType] ?? meta[K.filetype],
      metadata: meta[K.metadata],
      encryption: meta[K.encryption] ?? header(request, ENCRYPTION_HEADER),
    });
    reply.status(201).header("location", location(upload));
    describe(reply, upload);
    if (file) return file;
    return reply.send();
  });

  /** Where the upload stands: `Upload-Offset`, `Upload-Length`, never cached. */
  app.head<{ Params: UploadParams }>(
    "/uploads/:uploadId",
    { config: WRITE },
    async (request, reply) => {
      const row = await findUpload(service, requireTenant().tenantId, request.params.uploadId);
      reply.status(200).header("cache-control", "no-store");
      describe(reply, row);
      const metadata = encodeTusMetadata({
        [UPLOAD_META_KEYS.instanceType]: row.instanceType,
        [UPLOAD_META_KEYS.instanceId]: row.instanceId,
        [UPLOAD_META_KEYS.filename]: row.filename,
        [UPLOAD_META_KEYS.folderPath]: row.folderPath,
        [UPLOAD_META_KEYS.slug]: row.slug,
        [UPLOAD_META_KEYS.parentId]: row.parentId,
        [UPLOAD_META_KEYS.contentType]: row.declaredMime,
        [UPLOAD_META_KEYS.encryption]: row.encryption,
      });
      reply.header(UPLOAD_METADATA_HEADER, metadata);
      return reply.send();
    },
  );

  /** The bytes from `Upload-Offset` on, streamed to disk; `204` with the new offset (and `Vola-File-Id` when complete). */
  app.patch<{ Params: UploadParams; Body: Readable }>(
    "/uploads/:uploadId",
    { config: WRITE },
    async (request, reply) => {
      const tenant = requireTenant();
      const contentType = header(request, "content-type")?.split(";")[0]?.trim().toLowerCase();
      if (contentType !== TUS_PATCH_CONTENT_TYPE) {
        throw new VolaError(
          "unsupported_media_type",
          415,
          `Content-Type must be ${TUS_PATCH_CONTENT_TYPE}`,
        );
      }
      const offset = integerHeader(request, UPLOAD_OFFSET_HEADER, "Upload-Offset");
      const { upload, file } = await appendUpload(service, {
        tenantId: tenant.tenantId,
        uploadId: request.params.uploadId,
        offset,
        body: request.body ?? request.raw,
        contentLength: contentLength(request),
        userId: tenant.userId,
      });
      reply.status(204);
      describe(reply, upload);
      if (file) {
        request.log.info(
          { upload: upload.id, file: file.id, hash: file.hash, size: file.size },
          "file uploaded (resumable)",
        );
      }
      return reply.send();
    },
  );

  /** Termination: the row and the partial bytes go. */
  app.delete<{ Params: UploadParams }>(
    "/uploads/:uploadId",
    { config: WRITE },
    async (request, reply) => {
      await deleteUpload(service, requireTenant().tenantId, request.params.uploadId);
      return reply.status(204).send();
    },
  );

  // Without a worker, expired uploads are swept from inside the server process; in `async`
  // mode the plugin passes `0` here and schedules the sweep as a repeatable BullMQ job.
  const interval = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  if (interval > 0) {
    const sweep = () =>
      sweepExpiredUploads(service).catch((error: unknown) =>
        logger.error({ err: error }, "upload sweep failed"),
      );
    const timer = setInterval(sweep, interval);
    timer.unref();
    app.addHook("onReady", async () => {
      void sweep();
    });
    app.addHook("onClose", async () => {
      clearInterval(timer);
    });
  }
};

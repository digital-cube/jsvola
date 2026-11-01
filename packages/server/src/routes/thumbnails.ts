import {
  DEFAULT_ENC_INLINE_DERIVE_MAX_BYTES,
  THUMBNAIL_CROP_QUERY,
  THUMBNAIL_MIME,
  THUMBNAIL_STATUS_HEADER,
  type ThumbnailCrop,
  type ThumbnailSize,
  type ThumbnailStatus,
  thumbnailSupported,
} from "@vola/core";
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import type { FileRow } from "../db/schema.js";
import { VolaError } from "../errors.js";
import { type JobDispatcher, thumbnailable } from "../jobs/dispatcher.js";
import {
  type DerivativesDeps,
  DerivativeTooLargeError,
  ensureEncryptedThumbnail,
  openEncryptedThumbnail,
} from "../services/derivatives.js";
import { type EncryptionService, encryptionUnavailable } from "../services/encryption.js";
import { type FilesDeps, findReadableFile, parseInstance } from "../services/files.js";
import {
  generateThumbnail,
  parseThumbnailCrop,
  parseThumbnailSize,
  statThumbnail,
  ThumbnailError,
  thumbnailDerivedName,
  thumbnailPlaceholder,
} from "../services/thumbnails.js";
import type { StorageBackend } from "../storage/index.js";
import { ifNoneMatchMatches } from "./send-file.js";

export interface ThumbnailRoutesDeps {
  db: Database;
  storage: StorageBackend;
  /** The queue side of `async` mode; `null` in `sync` mode (render inline). */
  jobs: JobDispatcher | null;
  logger?: FastifyBaseLogger | undefined;
  /** Wall-clock limit of an inline rendition. Default 30 s. */
  renderTimeoutMs?: number | undefined;
  /** The `pdftoppm` binary. Default: the one on `PATH`. */
  pdftoppm?: string | undefined;
  /** Encryption (plan 6.3): the thumbnails of encrypted files; absent → `404 no_thumbnail` for them. */
  crypto?: EncryptionService | undefined;
  /** `VOLA_ENC_INLINE_DERIVE_MAX_BYTES`. Default 25 MiB. */
  encDeriveMaxBytes?: number | undefined;
}

/** `Cache-Control` of every thumbnail answer of an ENCRYPTED file: decrypted bytes stay nowhere. */
export const ENCRYPTED_THUMBNAIL_CACHE_CONTROL = "no-store";

/** `Cache-Control` of a ready thumbnail: content-addressed bytes, safe to keep a day. */
export const THUMBNAIL_READY_CACHE_CONTROL = "private, max-age=86400";
/** `Cache-Control` of a placeholder: never under a content key, never for long. */
export const THUMBNAIL_PLACEHOLDER_CACHE_CONTROL = "no-cache";

const READ = { scope: "files:read" } as const;

interface ThumbParams {
  type: string;
  id: string;
  fileId: string;
  size: string;
}
interface ThumbQuery {
  [THUMBNAIL_CROP_QUERY]?: string;
}

/** The ETag of a rendition: the blob hash plus the rendition name — one key per bytes. */
export function thumbnailEtag(hash: string, size: ThumbnailSize, crop: ThumbnailCrop): string {
  return `"${hash}.${thumbnailDerivedName(size, crop)}"`;
}

/** `404 no_thumbnail`: the file has no thumbnail by its nature (type, encryption). */
export function noThumbnail(reason: string): VolaError {
  return new VolaError("no_thumbnail", 404, reason);
}

/**
 * `GET|HEAD /files/:type/:id/:fileId/thumb/:size?crop=` (`files:read`). A WebP of the file —
 * `size` one of 64, 128, 256, 512 (`400 invalid_size`), `crop` `cover` (default), `fit` or
 * `attention` (`400 invalid_crop`). The answers a client must tell apart:
 *
 * | status | body | headers |
 * |---|---|---|
 * | `200` | the thumbnail | `X-Thumbnail-Status: ready`, `Cache-Control: private, max-age=86400`, `ETag` (304 on match) |
 * | `202` | a grey placeholder (~90 B) | `X-Thumbnail-Status: generating`, `Cache-Control: no-cache` — the worker has the job; retry |
 * | `200` | a grey placeholder | `X-Thumbnail-Status: failed`, `Cache-Control: no-cache` — the file could not be rendered |
 * | `404 no_thumbnail` | — | not a raster image or PDF, or a `client`-encrypted file, or an encrypted file above the derivative limit |
 *
 * `202` is a SUCCESS status to `fetch` and `raise_for_status()`: branch on the code (or the
 * header), and never cache a `202` body under a key derived from the content. Without a
 * worker (`sync` mode) a miss is rendered inline and answered `200`; the same happens when
 * the queue cannot be reached.
 *
 * An ENCRYPTED file (plan 6.3, `docs/CRYPTO.md` § 11) answers only to a request that holds
 * its key — the key file for `tenant`, `X-Vola-Unlock` for `keyring` (`423` without),
 * `X-Vola-Content-Key` for `caller` — with `Cache-Control: no-store` and an `ETag` of the file
 * id, never of the blob. The sealed sibling is decrypted for the answer; a miss is rendered
 * INLINE for `keyring` and `caller` (never `202`: no worker holds those keys) and queued or
 * rendered inline for `tenant` as for a plain file.
 */
export const thumbnailRoutes: FastifyPluginAsync<ThumbnailRoutesDeps> = async (app, deps) => {
  const service: FilesDeps = { db: deps.db, storage: deps.storage, logger: deps.logger ?? app.log };
  const log = deps.logger ?? app.log;

  async function sendPlaceholder(
    reply: FastifyReply,
    isHead: boolean,
    size: ThumbnailSize,
    status: Extract<ThumbnailStatus, "generating" | "failed">,
    cacheControl: string = THUMBNAIL_PLACEHOLDER_CACHE_CONTROL,
  ): Promise<FastifyReply> {
    const body = await thumbnailPlaceholder(size);
    reply
      .status(status === "generating" ? 202 : 200)
      .type(THUMBNAIL_MIME)
      .header(THUMBNAIL_STATUS_HEADER, status)
      .header("cache-control", cacheControl)
      .header("x-content-type-options", "nosniff")
      .header("content-length", String(body.length));
    return reply.send(isHead ? undefined : body);
  }

  async function sendReady(
    request: FastifyRequest,
    reply: FastifyReply,
    row: FileRow,
    size: ThumbnailSize,
    crop: ThumbnailCrop,
    length: number,
  ): Promise<FastifyReply> {
    const etag = thumbnailEtag(row.hash, size, crop);
    reply
      .header("etag", etag)
      .header(THUMBNAIL_STATUS_HEADER, "ready")
      .header("cache-control", THUMBNAIL_READY_CACHE_CONTROL)
      .header("x-content-type-options", "nosniff");
    if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
      return reply.status(304).send();
    }
    reply.type(THUMBNAIL_MIME).header("content-length", String(length));
    if (request.method === "HEAD") return reply.send();
    return reply.send(await deps.storage.openDerived(row.hash, thumbnailDerivedName(size, crop)));
  }

  const derivatives = (): DerivativesDeps => ({
    storage: deps.storage,
    maxBytes: deps.encDeriveMaxBytes ?? DEFAULT_ENC_INLINE_DERIVE_MAX_BYTES,
    logger: log,
  });

  function sendDecryptedThumbnail(
    request: FastifyRequest,
    reply: FastifyReply,
    row: FileRow,
    size: ThumbnailSize,
    crop: ThumbnailCrop,
    webp: Buffer,
  ): FastifyReply {
    const etag = `"${row.id}.${thumbnailDerivedName(size, crop)}"`;
    reply
      .header("etag", etag)
      .header(THUMBNAIL_STATUS_HEADER, "ready")
      .header("cache-control", ENCRYPTED_THUMBNAIL_CACHE_CONTROL)
      .header("x-content-type-options", "nosniff");
    if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
      return reply.status(304).send();
    }
    reply.type(THUMBNAIL_MIME).header("content-length", String(webp.length));
    return reply.send(request.method === "HEAD" ? undefined : webp);
  }

  /** The thumbnail of an encrypted file, for the request that holds its key (see the route comment). */
  async function encryptedThumb(
    request: FastifyRequest,
    reply: FastifyReply,
    row: FileRow,
    size: ThumbnailSize,
    crop: ThumbnailCrop,
  ): Promise<FastifyReply> {
    const isHead = request.method === "HEAD";
    if (!deps.crypto) throw encryptionUnavailable(row.encryption);
    const opened = await deps.crypto.open(row); // 503 / 409 / 423 / 400 here
    try {
      if (!thumbnailSupported(opened.meta.mime)) {
        throw noThumbnail(`no thumbnail for ${opened.meta.mime}`);
      }
      reply.header("cache-control", ENCRYPTED_THUMBNAIL_CACHE_CONTROL);
      const existing = await openEncryptedThumbnail(derivatives(), row, opened.fk, size, crop);
      if (existing) return sendDecryptedThumbnail(request, reply, row, size, crop, existing);
      if (Number(row.size) > derivatives().maxBytes) {
        throw noThumbnail("the file is above the limit for derivatives of encrypted files");
      }
      // A tenant file's rendition is the worker's job when there is one (it holds the key
      // file); nobody in the background holds a keyring's or a caller's key: inline, now.
      if (deps.jobs && row.encryption === "tenant") {
        try {
          await deps.jobs.requestThumbnail({ ...row, mimeType: opened.meta.mime }, size, crop);
          return await sendPlaceholder(
            reply,
            isHead,
            size,
            "generating",
            ENCRYPTED_THUMBNAIL_CACHE_CONTROL,
          );
        } catch (error) {
          log.warn(
            { err: error, file: row.id, size, crop },
            "thumbnail not queued, rendering inline",
          );
        }
      }
      let webp: Buffer;
      try {
        webp = await ensureEncryptedThumbnail(derivatives(), row, opened, size, crop, {
          timeoutMs: deps.renderTimeoutMs,
          pdftoppm: deps.pdftoppm,
        });
      } catch (error) {
        if (error instanceof DerivativeTooLargeError) {
          throw noThumbnail("the file is above the limit for derivatives of encrypted files");
        }
        if (!(error instanceof ThumbnailError)) throw error;
        log.warn({ err: error, file: row.id, size, crop, code: error.code }, "thumbnail failed");
        return sendPlaceholder(reply, isHead, size, "failed", ENCRYPTED_THUMBNAIL_CACHE_CONTROL);
      }
      return sendDecryptedThumbnail(request, reply, row, size, crop, webp);
    } finally {
      opened.fk.fill(0);
    }
  }

  app.route<{ Params: ThumbParams; Querystring: ThumbQuery }>({
    method: ["GET", "HEAD"],
    url: "/files/:type/:id/:fileId/thumb/:size",
    config: READ,
    handler: async (request, reply) => {
      const isHead = request.method === "HEAD";
      const size = parseThumbnailSize(request.params.size);
      const crop = parseThumbnailCrop(request.query[THUMBNAIL_CROP_QUERY]);
      const scope = parseInstance(requireTenant().tenantId, request.params.type, request.params.id);
      const row = await findReadableFile(service, scope, request.params.fileId);
      if (row.encryption === "client") {
        throw noThumbnail("a client-encrypted file has no thumbnail: the server has no key");
      }
      if (row.encryption !== "none") return encryptedThumb(request, reply, row, size, crop);
      if (!thumbnailable(row)) throw noThumbnail(`no thumbnail for ${row.mimeType}`);

      const existing = await statThumbnail(deps.storage, row.hash, size, crop);
      if (existing) return sendReady(request, reply, row, size, crop, existing.size);

      if (deps.jobs) {
        try {
          await deps.jobs.requestThumbnail(row, size, crop);
          return await sendPlaceholder(reply, isHead, size, "generating");
        } catch (error) {
          // The queue is not reachable: render here, as a deployment without a worker would.
          log.warn(
            { err: error, file: row.id, size, crop },
            "thumbnail not queued, rendering inline",
          );
        }
      }
      try {
        await generateThumbnail(deps.storage, row, size, crop, {
          timeoutMs: deps.renderTimeoutMs,
          pdftoppm: deps.pdftoppm,
        });
      } catch (error) {
        if (!(error instanceof ThumbnailError)) throw error;
        log.warn({ err: error, file: row.id, size, crop, code: error.code }, "thumbnail failed");
        return sendPlaceholder(reply, isHead, size, "failed");
      }
      const rendered = await statThumbnail(deps.storage, row.hash, size, crop);
      if (!rendered) throw new VolaError("blob_missing", 500, "the rendered thumbnail vanished");
      return sendReady(request, reply, row, size, crop, rendered.size);
    },
  });
};

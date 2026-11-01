import {
  THUMBNAIL_CROP_QUERY,
  THUMBNAIL_MIME,
  THUMBNAIL_STATUS_HEADER,
  type ThumbnailCrop,
  type ThumbnailSize,
  type ThumbnailStatus,
} from "@vola/core";
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import type { FileRow } from "../db/schema.js";
import { VolaError } from "../errors.js";
import { type JobDispatcher, thumbnailable } from "../jobs/dispatcher.js";
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
}

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
 * | `404 no_thumbnail` | — | not a raster image or PDF, or encrypted (plan 6.3 lifts this) |
 *
 * `202` is a SUCCESS status to `fetch` and `raise_for_status()`: branch on the code (or the
 * header), and never cache a `202` body under a key derived from the content. Without a
 * worker (`sync` mode) a miss is rendered inline and answered `200`; the same happens when
 * the queue cannot be reached.
 */
export const thumbnailRoutes: FastifyPluginAsync<ThumbnailRoutesDeps> = async (app, deps) => {
  const service: FilesDeps = { db: deps.db, storage: deps.storage, logger: deps.logger ?? app.log };
  const log = deps.logger ?? app.log;

  async function sendPlaceholder(
    reply: FastifyReply,
    isHead: boolean,
    size: ThumbnailSize,
    status: Extract<ThumbnailStatus, "generating" | "failed">,
  ): Promise<FastifyReply> {
    const body = await thumbnailPlaceholder(size);
    reply
      .status(status === "generating" ? 202 : 200)
      .type(THUMBNAIL_MIME)
      .header(THUMBNAIL_STATUS_HEADER, status)
      .header("cache-control", THUMBNAIL_PLACEHOLDER_CACHE_CONTROL)
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
      if (row.encryption !== "none") throw noThumbnail("an encrypted file has no thumbnail");
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

import { errorResponse, FORCE_DOWNLOAD_QUERY } from "@vola/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FileRow } from "../db/schema.js";
import {
  contentRange,
  parseByteRange,
  RangeNotSatisfiableError,
  rangeLength,
} from "../files/byte-range.js";
import { contentDisposition, dispositionFor } from "../files/content-disposition.js";
import { type FilesDeps, openFile, touchLastAccessed } from "../services/files.js";

export interface DownloadQuery {
  [FORCE_DOWNLOAD_QUERY]?: string;
}

export interface SendFileOptions {
  /** The `Cache-Control` of the response. Default: `private, no-cache`. */
  cacheControl?: string | undefined;
  /** Who downloads (for `last_accessed_by`); `null` for an anonymous reader. */
  userId: string | null;
}

export const flag = (value: string | undefined): boolean => value === "1" || value === "true";

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
 * The body (or, for HEAD, only the headers) of `row`: `ETag`/`304`, `Accept-Ranges` and one
 * `Range` → `206` (`416` outside the file), `Content-Disposition` (inline for media and PDF,
 * `?download=1` forces attachment), `X-Content-Type-Options: nosniff`. A GET records
 * `last_accessed_*` (throttled); a HEAD never does.
 */
export async function sendFile(
  service: FilesDeps,
  request: FastifyRequest<{ Querystring: DownloadQuery }>,
  reply: FastifyReply,
  row: FileRow,
  options: SendFileOptions,
): Promise<FastifyReply> {
  const isHead = request.method === "HEAD";
  const size = Number(row.size);
  const etag = `"${row.hash}"`;
  reply
    .header("etag", etag)
    .header("accept-ranges", "bytes")
    .header("x-content-type-options", "nosniff")
    .header("cache-control", options.cacheControl ?? "private, no-cache")
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

  if (!isHead) touchLastAccessed(service, row.id, options.userId);
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

import { ENCRYPTION_RESPONSE_HEADER, errorResponse, FORCE_DOWNLOAD_QUERY } from "@vola/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { type CiphertextSource, createDecryptStream } from "../crypto/index.js";
import type { FileRow } from "../db/schema.js";
import { VolaError } from "../errors.js";
import {
  type ByteRange,
  contentRange,
  parseByteRange,
  RangeNotSatisfiableError,
  rangeLength,
} from "../files/byte-range.js";
import { contentDisposition, dispositionFor } from "../files/content-disposition.js";
import { encryptionUnavailable, type OpenedFile } from "../services/encryption.js";
import { type FilesDeps, openFile, touchLastAccessed } from "../services/files.js";
import { BlobNotFoundError } from "../storage/index.js";

export interface DownloadQuery {
  [FORCE_DOWNLOAD_QUERY]?: string;
}

export interface SendFileOptions {
  /** The `Cache-Control` of the response. Default: `private, no-cache`. */
  cacheControl?: string | undefined;
  /** Who downloads (for `last_accessed_by`); `null` for an anonymous reader. */
  userId: string | null;
  /**
   * An encrypted file ALREADY opened by the caller — the share grant (plan 6.3) opens the key
   * under the link secret, not under the request's material. Absent: `crypto.open(row)`.
   */
  opened?: OpenedFile | undefined;
}

export const flag = (value: string | undefined): boolean => value === "1" || value === "true";

/**
 * The MIME types of an encrypted file a browser may render inline — and only when the bytes
 * themselves said so (`FileMeta.sniffed`): the four raster formats the Notes model trusts.
 * Everything else is an attachment, whatever its name claims.
 */
export const ENCRYPTED_INLINE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** The `Cache-Control` of every answer that carries decrypted bytes or a decrypted name. */
export const ENCRYPTED_CACHE_CONTROL = "no-store";

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
 * `last_accessed_*` (throttled); a HEAD never does. An encrypted row takes `sendEncryptedFile`.
 */
export async function sendFile(
  service: FilesDeps,
  request: FastifyRequest<{ Querystring: DownloadQuery }>,
  reply: FastifyReply,
  row: FileRow,
  options: SendFileOptions,
): Promise<FastifyReply> {
  if (row.encryption === "client")
    return sendOpaqueCiphertext(service, request, reply, row, options);
  if (row.encryption !== "none") return sendEncryptedFile(service, request, reply, row, options);
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

  const range = resolveRange(request, reply, size);
  if (range === "unsatisfiable") return reply.send(isHead ? undefined : unsatisfiable(size));

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

/** The `Range` of the request against `size` bytes; `416` headers set when it is outside the file. */
function resolveRange(
  request: FastifyRequest,
  reply: FastifyReply,
  size: number,
): ByteRange | null | "unsatisfiable" {
  try {
    return parseByteRange(request.headers.range, size);
  } catch (error) {
    if (!(error instanceof RangeNotSatisfiableError)) throw error;
    reply.status(416).header("content-range", `bytes */${size}`);
    return "unsatisfiable";
  }
}

const unsatisfiable = (size: number) =>
  errorResponse(
    "range_not_satisfiable",
    `the requested range is outside the file of ${size} bytes`,
  );

/**
 * The download of an encrypted file (`docs/CRYPTO.md` § Download): the file key is unwrapped
 * (`503 encryption_unavailable` without key material, `409 vola_integrity` when it does not
 * open), the metadata record decrypted for the real name and type, and the bytes decrypted
 * SEGMENT BY SEGMENT for exactly the plaintext range asked for — `206` and `Content-Range`
 * are in plaintext coordinates, memory is one segment per request. The first segment is
 * verified before a header goes out, so a damaged blob is a `409`, not a dropped connection.
 *
 * Headers: `ETag` is the file id (the plaintext of a file never changes; the blob hash would
 * leak nothing but is not a plaintext key either), `Cache-Control: no-store` (decrypted bytes
 * must not sit in a shared cache), `X-Content-Type-Options: nosniff`, `Content-Disposition`
 * inline ONLY for a raster image the bytes identified (`ENCRYPTED_INLINE_MIMES`), otherwise
 * `attachment; filename*=` with the decrypted name.
 */
export async function sendEncryptedFile(
  service: FilesDeps,
  request: FastifyRequest<{ Querystring: DownloadQuery }>,
  reply: FastifyReply,
  row: FileRow,
  options: SendFileOptions,
): Promise<FastifyReply> {
  const crypto = service.crypto;
  if (!crypto) throw encryptionUnavailable(row.encryption);
  const { fk, meta } = options.opened ?? (await crypto.open(row));
  try {
    const isHead = request.method === "HEAD";
    const size = Number(row.size);
    const etag = `"${row.id}"`;
    const inline =
      meta.sniffed &&
      ENCRYPTED_INLINE_MIMES.has(meta.mime) &&
      !flag(request.query[FORCE_DOWNLOAD_QUERY]);
    reply
      .header("etag", etag)
      .header("accept-ranges", "bytes")
      .header("x-content-type-options", "nosniff")
      .header("cache-control", ENCRYPTED_CACHE_CONTROL)
      .header(ENCRYPTION_RESPONSE_HEADER, row.encryption)
      .header("last-modified", row.createdAt.toUTCString())
      .header(
        "content-disposition",
        contentDisposition(meta.filename, inline ? "inline" : "attachment"),
      );
    if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
      return reply.status(304).send();
    }
    const range = resolveRange(request, reply, size);
    if (range === "unsatisfiable") return reply.send(isHead ? undefined : unsatisfiable(size));

    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    let body: NodeJS.ReadableStream | undefined;
    if (!isHead) {
      // Decrypt (and verify the first segment) BEFORE the status and the length are committed.
      const source = await ciphertextSourceOf(service, row);
      try {
        const opened = await createDecryptStream(fk, row.id, source, {
          start,
          end: size === 0 ? undefined : end,
          expectedLength: size,
        });
        body = opened.stream;
      } catch (error) {
        throw crypto.translate(error, row.encryption, row.id);
      }
      touchLastAccessed(service, row.id, options.userId);
    }
    reply.type(meta.mime);
    if (range) {
      reply
        .status(206)
        .header("content-range", contentRange(range, size))
        .header("content-length", String(rangeLength(range)));
    } else {
      reply.header("content-length", String(size));
    }
    if (isHead || !body) return reply.send();
    return reply.send(body);
  } finally {
    fk.fill(0);
  }
}

/**
 * The download of a `client`-encrypted file (plan 6.3, `docs/CRYPTO.md` § 13): the `JSV`
 * blob EXACTLY as the client uploaded it — the server has no key and decrypts nothing.
 * `Content-Type: application/octet-stream`, `X-Vola-Encryption: client`, `Content-Length`
 * and `Range` in CIPHERTEXT bytes (the blob's), `ETag` the blob hash, `Cache-Control:
 * no-store`, `Content-Disposition: attachment; filename="<file id>.jsv"`.
 */
export async function sendOpaqueCiphertext(
  service: FilesDeps,
  request: FastifyRequest<{ Querystring: DownloadQuery }>,
  reply: FastifyReply,
  row: FileRow,
  options: SendFileOptions,
): Promise<FastifyReply> {
  const isHead = request.method === "HEAD";
  const found = await service.storage.stat(row.hash);
  if (!found) throw new VolaError("blob_missing", 500, "the stored bytes of this file are missing");
  const size = found.size;
  const etag = `"${row.hash}"`;
  reply
    .header("etag", etag)
    .header("accept-ranges", "bytes")
    .header("x-content-type-options", "nosniff")
    .header("cache-control", ENCRYPTED_CACHE_CONTROL)
    .header(ENCRYPTION_RESPONSE_HEADER, row.encryption)
    .header("last-modified", row.createdAt.toUTCString())
    .header("content-disposition", contentDisposition(`${row.id}.jsv`, "attachment"));
  if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) {
    return reply.status(304).send();
  }
  const range = resolveRange(request, reply, size);
  if (range === "unsatisfiable") return reply.send(isHead ? undefined : unsatisfiable(size));
  if (!isHead) touchLastAccessed(service, row.id, options.userId);
  reply.type("application/octet-stream");
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

/** The blob of `row` as the decryptor reads it; a blob missing from disk is `500 blob_missing`. */
async function ciphertextSourceOf(service: FilesDeps, row: FileRow): Promise<CiphertextSource> {
  const found = await service.storage.stat(row.hash);
  if (!found) throw new VolaError("blob_missing", 500, "the stored bytes of this file are missing");
  return {
    size: found.size,
    async open(range) {
      try {
        return await service.storage.open(row.hash, range);
      } catch (error) {
        if (error instanceof BlobNotFoundError) {
          throw new VolaError("blob_missing", 500, "the stored bytes of this file are missing");
        }
        throw error;
      }
    },
  };
}

/**
 * Thumbnails and OCR of ENCRYPTED files (plan 6.3, `docs/CRYPTO.md` § 11): made from the
 * decrypted bytes held in memory by whoever holds the file key — the worker for a `tenant`
 * file (it has the key file), the request for a `keyring` or `caller` file (it has the
 * unlock or the content key) — and stored only SEALED under that same key: a thumbnail as
 * `<blob>.enc-<file id>-thumb-<size>-<crop>` (`nonce ∥ AES-GCM(FK, webp, "<file id>:thumb:
 * <size>:<crop>")`), the OCR result in `vola_file_metadata.ocr_ct`. Nothing of the plaintext
 * touches the disk (a PDF is rasterised through pdftoppm's stdin and stdout) or an index (the
 * OCR text of an encrypted file is not in `ocr_tsv`, so not in the full-text search). A file
 * above `VOLA_ENC_INLINE_DERIVE_MAX_BYTES` (default 25 MiB) gets no derivative: the whole
 * plaintext has to be in memory for the render.
 *
 * The derivatives go with the blob (`storage.remove` drops every `<blob>.*`, and an
 * encrypted blob is never shared) and with the key: the crypto-shred of the row covers them.
 */
import type { ThumbnailCrop, ThumbnailSize } from "@vola/core";
import type { FastifyBaseLogger } from "fastify";
import {
  createDecryptStream,
  encryptedThumbnailName,
  IntegrityError,
  openThumbnail,
  sealThumbnail,
} from "../crypto/index.js";
import type { Database } from "../db/index.js";
import type { FileRow } from "../db/schema.js";
import { BlobNotFoundError, type StorageBackend } from "../storage/index.js";
import type { OpenedFile } from "./encryption.js";
import {
  extractTextFromBuffer,
  OcrError,
  type OcrResult,
  type OcrRunOptions,
  saveEncryptedOcrResult,
} from "./ocr.js";
import { type RenderOptions, renderThumbnailFromBuffer, ThumbnailError } from "./thumbnails.js";

export interface DerivativesDeps {
  storage: StorageBackend;
  /** `VOLA_ENC_INLINE_DERIVE_MAX_BYTES`. */
  maxBytes: number;
  logger?: FastifyBaseLogger | undefined;
}

/** The file's plaintext is larger than what a derivative may be made of. */
export class DerivativeTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`the file holds ${size} bytes, derivatives of encrypted files stop at ${maxBytes}`);
    this.name = "DerivativeTooLargeError";
  }
}

/** The whole plaintext of `row` in memory (≤ `maxBytes`), decrypted and verified segment by segment. */
export async function decryptWhole(
  deps: DerivativesDeps,
  row: Pick<FileRow, "id" | "hash" | "size">,
  fk: Buffer,
): Promise<Buffer> {
  const size = Number(row.size);
  if (size > deps.maxBytes) throw new DerivativeTooLargeError(size, deps.maxBytes);
  const found = await deps.storage.stat(row.hash);
  if (!found) throw new BlobNotFoundError(row.hash);
  const opened = await createDecryptStream(
    fk,
    row.id,
    {
      size: found.size,
      open: (range) => deps.storage.open(row.hash, range),
    },
    { expectedLength: size },
  );
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * The sealed thumbnail of `row` at `size` / `crop`, decrypted; `null` when there is none yet.
 * A sibling that does not open (another key, a damaged file) is treated as absent — it is
 * regenerated — and logged.
 */
export async function openEncryptedThumbnail(
  deps: DerivativesDeps,
  row: Pick<FileRow, "id" | "hash">,
  fk: Buffer,
  size: ThumbnailSize,
  crop: ThumbnailCrop,
): Promise<Buffer | null> {
  const name = encryptedThumbnailName(row.id, size, crop);
  const found = await deps.storage.statDerived(row.hash, name);
  if (!found) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of await deps.storage.openDerived(row.hash, name)) {
    chunks.push(chunk as Buffer);
  }
  try {
    return openThumbnail(fk, row.id, size, crop, Buffer.concat(chunks));
  } catch (error) {
    if (!(error instanceof IntegrityError)) throw error;
    deps.logger?.warn(
      { file: row.id, size, crop, reason: error.reason },
      "sealed thumbnail does not open",
    );
    return null;
  }
}

/**
 * Renders the thumbnail of an encrypted file from `plain` (or decrypts the file first) and
 * stores it sealed next to the blob; returns the WebP. Throws `ThumbnailError`,
 * `DerivativeTooLargeError`, `BlobNotFoundError`, `IntegrityError`.
 */
export async function generateEncryptedThumbnail(
  deps: DerivativesDeps,
  row: Pick<FileRow, "id" | "hash" | "size">,
  opened: OpenedFile,
  size: ThumbnailSize,
  crop: ThumbnailCrop,
  options: RenderOptions & { plain?: Buffer | undefined } = {},
): Promise<Buffer> {
  const plain = options.plain ?? (await decryptWhole(deps, row, opened.fk));
  const webp = await renderThumbnailFromBuffer(plain, opened.meta.mime, size, crop, options);
  await deps.storage.putDerived(
    row.hash,
    encryptedThumbnailName(row.id, size, crop),
    sealThumbnail(opened.fk, row.id, size, crop, webp),
  );
  return webp;
}

/** `openEncryptedThumbnail`, else `generateEncryptedThumbnail`. */
export async function ensureEncryptedThumbnail(
  deps: DerivativesDeps,
  row: Pick<FileRow, "id" | "hash" | "size">,
  opened: OpenedFile,
  size: ThumbnailSize,
  crop: ThumbnailCrop,
  options: RenderOptions = {},
): Promise<Buffer> {
  const existing = await openEncryptedThumbnail(deps, row, opened.fk, size, crop);
  if (existing) return existing;
  return generateEncryptedThumbnail(deps, row, opened, size, crop, options);
}

/**
 * The OCR pass of an encrypted file: decrypted into memory, read through tesseract's stdin,
 * the result sealed into `ocr_ct`. Throws `OcrError`, `DerivativeTooLargeError`,
 * `BlobNotFoundError`, `IntegrityError`.
 */
export async function ocrEncrypted(
  deps: DerivativesDeps,
  db: Database,
  row: Pick<FileRow, "id" | "hash" | "size" | "tenantId">,
  opened: OpenedFile,
  options: OcrRunOptions & { at: Date },
): Promise<OcrResult> {
  const plain = await decryptWhole(deps, row, opened.fk);
  const result = await extractTextFromBuffer(plain, opened.meta.mime, options);
  plain.fill(0);
  await saveEncryptedOcrResult(db, opened.fk, {
    fileId: row.id,
    tenantId: row.tenantId,
    text: result.text,
    lang: result.lang,
    pages: result.pages,
    at: options.at,
  });
  return result;
}

/** `true` for the errors of a derivative that mean "not for this file" rather than "try again". */
export function derivativeUnrecoverable(error: unknown): boolean {
  return (
    error instanceof DerivativeTooLargeError ||
    error instanceof IntegrityError ||
    error instanceof BlobNotFoundError ||
    (error instanceof ThumbnailError &&
      (error.code === "unsupported" || error.code === "blob_missing")) ||
    (error instanceof OcrError &&
      (error.code === "unsupported" ||
        error.code === "blob_missing" ||
        error.code === "tool_missing"))
  );
}

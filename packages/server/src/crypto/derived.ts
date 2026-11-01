/**
 * Encrypted DERIVATIVES of a file (plan 6.3, `docs/CRYPTO.md` § 11) and the encrypted
 * PARTIAL SEGMENT of a resumable upload (§ 10): small sealed records under the file key `FK`,
 * each `nonce (12) ∥ ct ∥ tag (16)` (`aeadSeal`), bound by its AAD to the file id and to what
 * it is, so a thumbnail cannot be presented as another size, as the OCR text, or as a
 * derivative of another file:
 *
 * | record | AAD | lives in |
 * |---|---|---|
 * | thumbnail `size`/`crop` (WebP) | `<file id>:thumb:<size>:<crop>` | `<blob>.enc-<file id>-thumb-<size>-<crop>` next to the blob |
 * | OCR result (JSON `{v, text, lang, pages}`) | `<file id>:ocr` | `vola_file_metadata.ocr_ct` (the clear columns stay NULL) |
 * | the head of the plaintext (MIME sniffing) | `<file id>:head` | `vola_upload.enc_state.head_ct` while an upload runs |
 * | the incomplete last segment of an upload | `<file id>:partial:<index>:<write>` | `<uploads>/<upload id>.partial`, nonce `partial_prefix ∥ write` |
 *
 * The partial segment is the one record whose nonce is NOT random: it is `partial_prefix (8 B,
 * random per upload) ∥ write counter (u32)`, a prefix distinct from the blob's `nonce_prefix`,
 * so re-sealing the growing partial never reuses a nonce under FK — neither with an earlier
 * version of itself (the counter moves) nor with the full segment it will become (the prefix
 * differs). The write counter is in the AAD too, so a partial file left behind by a crashed
 * PATCH does not open against the state the database committed.
 *
 * A derivative is never shared between files (its name carries the file id, its AAD too),
 * never written in the clear, and goes with the blob (`storage.remove` drops every
 * `<blob>.*`) — and the crypto-shred of the row covers it anyway: no FK, no thumbnail.
 */
import type { ThumbnailCrop, ThumbnailSize } from "@vola/core";
import { aeadOpen, aeadSeal, assertKey, gcmDecrypt, gcmEncrypt, NONCE_BYTES } from "./aead.js";
import { IntegrityError } from "./errors.js";

export const ENC_DERIVED_PREFIX = "enc-";
export const PARTIAL_PREFIX_BYTES = 8;
/** The OCR record's version (read and dispatched). */
export const OCR_RECORD_VERSION = 1;

/** `enc-<file id>-thumb-<size>-<crop>`: the derived-file name of an encrypted thumbnail. */
export function encryptedThumbnailName(
  fileId: string,
  size: ThumbnailSize | number,
  crop: ThumbnailCrop,
): string {
  return `${ENC_DERIVED_PREFIX}${fileId.toLowerCase()}-thumb-${size}-${crop}`;
}

export function thumbnailAad(
  fileId: string,
  size: ThumbnailSize | number,
  crop: ThumbnailCrop,
): Buffer {
  return Buffer.from(`${fileId}:thumb:${size}:${crop}`, "utf8");
}

/** `nonce ∥ AES-GCM(FK, webp, "<file id>:thumb:<size>:<crop>")`. */
export function sealThumbnail(
  fk: Buffer,
  fileId: string,
  size: ThumbnailSize | number,
  crop: ThumbnailCrop,
  webp: Buffer,
): Buffer {
  return aeadSeal(fk, webp, thumbnailAad(fileId, size, crop));
}

export function openThumbnail(
  fk: Buffer,
  fileId: string,
  size: ThumbnailSize | number,
  crop: ThumbnailCrop,
  sealed: Buffer,
): Buffer {
  return aeadOpen(fk, sealed, thumbnailAad(fileId, size, crop));
}

// --- OCR ---------------------------------------------------------------------------------

export interface OcrRecord {
  text: string;
  lang: string;
  pages: number;
}

export function ocrAad(fileId: string): Buffer {
  return Buffer.from(`${fileId}:ocr`, "utf8");
}

/** `nonce ∥ AES-GCM(FK, {v, text, lang, pages}, "<file id>:ocr")`. */
export function sealOcr(fk: Buffer, fileId: string, record: OcrRecord): Buffer {
  const json = Buffer.from(
    JSON.stringify({
      v: OCR_RECORD_VERSION,
      text: record.text,
      lang: record.lang,
      pages: record.pages,
    }),
    "utf8",
  );
  return aeadSeal(fk, json, ocrAad(fileId));
}

/** Opens `ocr_ct`; `IntegrityError` for a bad tag, another file's record or a malformed body. */
export function openOcr(fk: Buffer, fileId: string, sealed: Buffer): OcrRecord {
  const plain = aeadOpen(fk, sealed, ocrAad(fileId));
  let value: unknown;
  try {
    value = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new IntegrityError("OCR record is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrityError("OCR record is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.v !== OCR_RECORD_VERSION) throw new IntegrityError("unknown OCR record version");
  const { text, lang, pages } = record;
  if (typeof text !== "string" || typeof lang !== "string") {
    throw new IntegrityError("OCR record without text or language");
  }
  if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 0) {
    throw new IntegrityError("OCR record without a page count");
  }
  return { text, lang, pages };
}

// --- the head of the plaintext (an upload in flight) -------------------------------------

export function headAad(fileId: string): Buffer {
  return Buffer.from(`${fileId}:head`, "utf8");
}

export function sealHead(fk: Buffer, fileId: string, head: Buffer): Buffer {
  return aeadSeal(fk, head, headAad(fileId));
}

export function openHead(fk: Buffer, fileId: string, sealed: Buffer): Buffer {
  return aeadOpen(fk, sealed, headAad(fileId));
}

// --- the partial segment of a resumable upload -------------------------------------------

export function partialAad(fileId: string, index: number, write: number): Buffer {
  return Buffer.from(`${fileId}:partial:${index}:${write}`, "utf8");
}

/** `partial_prefix ∥ write (u32 BE)`. */
export function partialNonce(partialPrefix: Buffer, write: number): Buffer {
  if (partialPrefix.length !== PARTIAL_PREFIX_BYTES) {
    throw new RangeError(`partial prefix must be ${PARTIAL_PREFIX_BYTES} bytes`);
  }
  const counter = Buffer.alloc(NONCE_BYTES - PARTIAL_PREFIX_BYTES);
  counter.writeUInt32BE(write);
  return Buffer.concat([partialPrefix, counter]);
}

/**
 * The incomplete segment `index` as it stands after write number `write`: `ct ∥ tag` under
 * FK with the nonce `partial_prefix ∥ write` (NOT stored: both parts are in `enc_state`).
 */
export function sealPartial(
  fk: Buffer,
  fileId: string,
  partialPrefix: Buffer,
  index: number,
  write: number,
  plain: Buffer,
): Buffer {
  return gcmEncrypt(
    assertKey(fk, "file key"),
    partialNonce(partialPrefix, write),
    plain,
    partialAad(fileId, index, write),
  );
}

export function openPartial(
  fk: Buffer,
  fileId: string,
  partialPrefix: Buffer,
  index: number,
  write: number,
  sealed: Buffer,
): Buffer {
  return gcmDecrypt(
    assertKey(fk, "file key"),
    partialNonce(partialPrefix, write),
    sealed,
    partialAad(fileId, index, write),
  );
}

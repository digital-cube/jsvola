/**
 * The encrypted metadata of a file (`vola_file.meta_ct`): what the row cannot say in the
 * clear — the real name, the real MIME type, the caller's `metadata` object — sealed under
 * the file key with AAD `<file id>:meta`, so a record copied onto another row does not open.
 * The row itself shows `<file id>.bin` / `application/octet-stream` / `{}`.
 */
import { aeadOpen, aeadSeal } from "./aead.js";
import { IntegrityError } from "./errors.js";

export const META_VERSION = 1;
export const META_MAX_BYTES = 256 * 1024;

export interface FileMeta {
  filename: string;
  mime: string;
  metadata: Record<string, unknown>;
  /** `true` when `mime` came from the magic bytes (the only MIME a browser may render inline). */
  sniffed: boolean;
}

export function metaAad(fileId: string): Buffer {
  return Buffer.from(`${fileId}:meta`, "utf8");
}

/** `nonce ∥ AES-256-GCM(FK, {v, filename, mime, metadata, sniffed}, "<file id>:meta")`. */
export function sealMeta(fk: Buffer, fileId: string, meta: FileMeta): Buffer {
  const json = Buffer.from(
    JSON.stringify({
      v: META_VERSION,
      filename: meta.filename,
      mime: meta.mime,
      metadata: meta.metadata,
      sniffed: meta.sniffed,
    }),
    "utf8",
  );
  if (json.length > META_MAX_BYTES) throw new RangeError("metadata record too large");
  return aeadSeal(fk, json, metaAad(fileId));
}

/** Opens `meta_ct`; `IntegrityError` for a bad tag, another file's record or a malformed body. */
export function openMeta(fk: Buffer, fileId: string, sealed: Buffer): FileMeta {
  const plain = aeadOpen(fk, sealed, metaAad(fileId));
  let value: unknown;
  try {
    value = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new IntegrityError("metadata is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrityError("metadata is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.v !== META_VERSION) throw new IntegrityError("unknown metadata version");
  const { filename, mime, metadata, sniffed } = record;
  if (typeof filename !== "string" || filename.length === 0 || filename.length > 255) {
    throw new IntegrityError("metadata without a filename");
  }
  if (typeof mime !== "string" || mime.length === 0 || mime.length > 255) {
    throw new IntegrityError("metadata without a MIME type");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new IntegrityError("metadata without an object");
  }
  return {
    filename,
    mime,
    metadata: metadata as Record<string, unknown>,
    sniffed: sniffed === true,
  };
}

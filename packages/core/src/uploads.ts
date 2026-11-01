/**
 * Resumable uploads: the tus 1.0 core protocol (+ `creation`, `termination`, `expiration`)
 * on `/uploads`, implemented natively by the server so `tus-js-client` works unchanged.
 * Everything here is shared by server and clients: header names, the extension list, and
 * the `Upload-Metadata` codec.
 */

/** The one protocol version the server speaks (`Tus-Resumable`, `Tus-Version`). */
export const TUS_VERSION = "1.0.0";

/** `Tus-Extension` of `OPTIONS /uploads`. `Upload-Defer-Length` is deliberately not offered. */
export const TUS_EXTENSIONS = ["creation", "termination", "expiration"] as const;

/** tus headers, lowercase (Node and Fastify expose them that way). */
export const TUS_RESUMABLE_HEADER = "tus-resumable";
export const TUS_VERSION_HEADER = "tus-version";
export const TUS_EXTENSION_HEADER = "tus-extension";
export const TUS_MAX_SIZE_HEADER = "tus-max-size";
export const UPLOAD_LENGTH_HEADER = "upload-length";
export const UPLOAD_OFFSET_HEADER = "upload-offset";
export const UPLOAD_METADATA_HEADER = "upload-metadata";
export const UPLOAD_EXPIRES_HEADER = "upload-expires";
export const UPLOAD_DEFER_LENGTH_HEADER = "upload-defer-length";

/** `Content-Type` of a PATCH body. */
export const TUS_PATCH_CONTENT_TYPE = "application/offset+octet-stream";

/** The `vola_file` id a completed upload became: on the last PATCH and on every HEAD after it. */
export const VOLA_FILE_ID_HEADER = "vola-file-id";

/**
 * Keys of `Upload-Metadata` the server reads. `instance_type`, `instance_id` and `filename`
 * are required; `filetype` is the tus-js-client default name for the MIME type and counts
 * as `content_type`.
 */
export const UPLOAD_META_KEYS = {
  instanceType: "instance_type",
  instanceId: "instance_id",
  filename: "filename",
  folderPath: "folder_path",
  parentId: "parent_id",
  slug: "slug",
  contentType: "content_type",
  /** tus-js-client's default key for the MIME type. */
  filetype: "filetype",
  metadata: "metadata",
} as const;

const META_KEY_RE = /^[^\s,]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** UTF-8 → base64, with the web APIs only (this package also runs in a browser). */
function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64 → UTF-8 (validated by the caller). */
function fromBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Decodes an `Upload-Metadata` header: comma-separated `key base64value` pairs, the value
 * optional (an empty string). Returns `null` for a malformed header (a key repeated, a value
 * that is not base64, a key with whitespace).
 */
export function decodeTusMetadata(
  header: string | undefined | null,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (header === undefined || header === null || header.trim() === "") return out;
  for (const raw of header.split(",")) {
    const pair = raw.trim();
    if (pair === "") continue;
    const space = pair.indexOf(" ");
    const key = space < 0 ? pair : pair.slice(0, space);
    const value = space < 0 ? "" : pair.slice(space + 1).trim();
    if (!META_KEY_RE.test(key) || key in out) return null;
    if (value !== "" && (!BASE64_RE.test(value) || value.length % 4 !== 0)) return null;
    out[key] = value === "" ? "" : fromBase64(value);
  }
  return out;
}

/** Encodes key/value pairs as an `Upload-Metadata` header (values base64, UTF-8). */
export function encodeTusMetadata(pairs: Record<string, string | undefined | null>): string {
  return Object.entries(pairs)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => (value === "" ? key : `${key} ${toBase64(value)}`))
    .join(",");
}

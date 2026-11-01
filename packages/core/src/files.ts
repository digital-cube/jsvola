import { z } from "zod";
import { TimestampSchema } from "./apikey.js";
import { OcrInfoSchema, ProcessingStatusSchema } from "./processing.js";

/** What a file is, derived from its MIME type (the `FileKinds` vocabulary). */
export const FILE_KINDS = [
  "image",
  "video",
  "audio",
  "document",
  "spreadsheet",
  "presentation",
  "archive",
  "text",
  "code",
  "other",
] as const;
export const FileKindSchema = z.enum(FILE_KINDS);
export type FileKind = z.infer<typeof FileKindSchema>;

/**
 * How the bytes of a file are protected (`docs/CRYPTO.md`): `none`; `tenant` — a key the
 * server holds (6.1); `keyring` — a principal's PIN (6.2); `caller` — a key the caller sends
 * with every request in `X-Vola-Content-Key` (6.3); `client` — the CLIENT produced the `JSV`
 * blob and the wrapped key itself, the server stores and serves them as opaque bytes (6.3).
 */
export const FILE_ENCRYPTIONS = ["none", "tenant", "keyring", "caller", "client"] as const;
export const FileEncryptionSchema = z.enum(FILE_ENCRYPTIONS);
export type FileEncryption = z.infer<typeof FileEncryptionSchema>;

/** The host application's object type a file hangs off (`tickets`, `user_profiles`). */
export const InstanceTypeSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and _ starting with a letter");
export type InstanceType = z.infer<typeof InstanceTypeSchema>;

/** A named file inside an instance (`avatar`, `cover_image`): at most one live file per slug. */
export const FileSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,99}$/, "lowercase letters, digits, - and _, 1–100 characters");
export type FileSlug = z.infer<typeof FileSlugSchema>;

/** A SHA-256 as lowercase hex. */
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Free JSON object a caller attaches to a file (the `metadata` multipart field). */
export const FileMetadataSchema = z.record(z.string(), z.unknown());
export type FileMetadata = z.infer<typeof FileMetadataSchema>;

/**
 * Public view of a stored file (`…/info`, the `201` of an upload, list entries). Never the
 * encryption secrets (`fk_ct`, `meta_ct`).
 */
export const FileInfoSchema = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  instance_type: InstanceTypeSchema,
  instance_id: z.uuid(),
  slug: FileSlugSchema.nullable(),
  hash: Sha256Schema,
  size: z.number().int().nonnegative(),
  filename: z.string().min(1).max(255),
  /** Lowercase, without the dot. */
  extension: z.string().nullable(),
  mime_type: z.string(),
  kind: FileKindSchema,
  metadata: FileMetadataSchema,
  folder_id: z.uuid().nullable(),
  parent_id: z.uuid().nullable(),
  is_public: z.boolean(),
  is_global_public: z.boolean(),
  encryption: FileEncryptionSchema,
  enc_format: z.number().int().nullable(),
  keyring_id: z.uuid().nullable(),
  created_by: z.string().nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  deleted_at: TimestampSchema.nullable(),
  deleted_by: z.string().nullable(),
  last_accessed_at: TimestampSchema.nullable(),
  last_accessed_by: z.string().nullable(),
  /**
   * The aggregate of the file's processing jobs (thumbnails, OCR): the worst status wins
   * (`FAILED` > `RUNNING` > `PENDING` > `DONE`); `null` when no job was ever created for it.
   */
  processing_status: ProcessingStatusSchema.nullable(),
});
export type FileInfo = z.infer<typeof FileInfoSchema>;

/** `GET …/:fileId/info`: a `FileInfo` plus the `ocr` block (see `OcrInfoSchema`). */
export const FileDetailSchema = FileInfoSchema.extend({ ocr: OcrInfoSchema });
export type FileDetail = z.infer<typeof FileDetailSchema>;

/** `GET /files/:type/:id` — one page, newest first; `next_cursor` feeds `?cursor=`. */
export const FileListSchema = z.object({
  files: z.array(FileInfoSchema),
  next_cursor: z.string().nullable(),
});
export type FileList = z.infer<typeof FileListSchema>;

/** Page size of a file list: `?limit=`, at most `FILE_LIST_MAX_LIMIT`. */
export const FILE_LIST_DEFAULT_LIMIT = 50;
export const FILE_LIST_MAX_LIMIT = 200;

/** `DELETE …/:fileId/purge`: rows removed, blobs removed from disk. */
export const PurgeResultSchema = z.object({
  files: z.number().int().nonnegative(),
  blobs: z.number().int().nonnegative(),
});
export type PurgeResult = z.infer<typeof PurgeResultSchema>;

/** Multipart field names of an upload. */
export const UPLOAD_FILE_FIELD = "file";
export const UPLOAD_METADATA_FIELD = "metadata";
/**
 * `encryption` form field (BEFORE the `file` part) or `X-Vola-Encryption` header of an upload:
 * `none` | `tenant` (6.1) | `keyring` (6.2, needs `X-Vola-Unlock`). Absent: the folder's
 * policy, else the tenant's `default_encryption`.
 */
export const UPLOAD_ENCRYPTION_FIELD = "encryption";
export const ENCRYPTION_HEADER = "x-vola-encryption";
/** The error code of every integrity failure (`409`), and its one fixed sentence. */
export const INTEGRITY_ERROR_CODE = "vola_integrity";
export const INTEGRITY_ERROR_MESSAGE = "The file could not be decrypted.";
/** `503`: the server has no key material for the encryption mode asked for. */
export const ENCRYPTION_UNAVAILABLE_CODE = "encryption_unavailable";
/** What the row (and the storage) says the type of an encrypted file is: nothing. */
export const ENCRYPTED_STORED_MIME = "application/octet-stream";
/**
 * The `caller` mode's key (plan 6.3): 32 bytes, base64, on the upload and on every read of a
 * `caller` file. Server-to-server only: a request that carries an `Origin` header (a browser)
 * is refused with `400 caller_key_from_browser`. Needs the `encryption:caller` scope.
 */
export const CONTENT_KEY_HEADER = "x-vola-content-key";
/** Bytes of a `caller` content key (and of every AES-256-GCM key in the format). */
export const CONTENT_KEY_BYTES = 32;
export const CALLER_KEY_FROM_BROWSER_CODE = "caller_key_from_browser";
/** On every download of an encrypted file: its `encryption` mode (`client` tells a reader the body is a `JSV` blob). */
export const ENCRYPTION_RESPONSE_HEADER = "x-vola-encryption";
/** `VOLA_ENC_INLINE_DERIVE_MAX_BYTES` when unset: the largest encrypted file a derivative is made of in a request. */
export const DEFAULT_ENC_INLINE_DERIVE_MAX_BYTES = 25 * 1024 * 1024;

/** `?download=1` on a download forces `Content-Disposition: attachment`. */
export const FORCE_DOWNLOAD_QUERY = "download";

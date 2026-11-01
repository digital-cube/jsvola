import { z } from "zod";
import { TimestampSchema } from "./apikey.js";

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

/** How the bytes of a file are protected; `none` until phase 6. */
export const FILE_ENCRYPTIONS = ["none", "tenant", "keyring", "caller"] as const;
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
});
export type FileInfo = z.infer<typeof FileInfoSchema>;

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

/** `?download=1` on a download forces `Content-Disposition: attachment`. */
export const FORCE_DOWNLOAD_QUERY = "download";

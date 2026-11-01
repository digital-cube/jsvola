import { z } from "zod";
import { TimestampSchema } from "./apikey.js";
import { FileKindSchema, InstanceTypeSchema } from "./files.js";
import { FolderPathSchema } from "./folders.js";

/**
 * Who a share link reaches (the `ShareScopes` vocabulary). v1 implements `PUBLIC_LINK` —
 * anyone with the token; the other scopes are declared and answer `501 not_implemented`.
 */
export const SHARE_SCOPES = ["PUBLIC_LINK", "TENANT", "INSTANCE_VIEWERS", "EMAIL"] as const;
export const ShareScopeSchema = z.enum(SHARE_SCOPES);
export type ShareScope = z.infer<typeof ShareScopeSchema>;
/** The scopes a share can be created with in v1. */
export const IMPLEMENTED_SHARE_SCOPES: readonly ShareScope[] = ["PUBLIC_LINK"];

/** Bytes of entropy in a share token; the token is their base64url (43 characters). */
export const SHARE_TOKEN_BYTES = 32;
/** The token as it appears in a URL: base64url of `SHARE_TOKEN_BYTES` random bytes. */
export const ShareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The password of a protected share travels in this header … */
export const SHARE_PASSWORD_HEADER = "x-share-password";
/** … or in this query parameter (`?password=`). */
export const SHARE_PASSWORD_QUERY = "password";
/** A share password: 1–256 characters. */
export const SharePasswordSchema = z.string().min(1).max(256);

/** Wrong passwords tolerated per token in `SHARE_PASSWORD_WINDOW_S` before `429`. */
export const SHARE_PASSWORD_MAX_FAILURES = 10;
export const SHARE_PASSWORD_WINDOW_S = 15 * 60;

/** `folder` of `POST /shares`: which folder of which instance. */
export const ShareFolderTargetSchema = z
  .object({
    instance_type: InstanceTypeSchema,
    instance_id: z.uuid(),
    /** `a/b/c`; the root is not shareable. */
    path: FolderPathSchema.refine((path) => path !== "", { message: "the root is not a folder" }),
  })
  .strict();
export type ShareFolderTarget = z.infer<typeof ShareFolderTargetSchema>;

/**
 * `POST /shares`: exactly one of `file_id` / `folder`. `password` protects the link
 * (argon2id on the server), `expires_at` ends it, `max_downloads` caps how many downloads
 * may START through it (HEAD and Range continuations do not count).
 */
export const ShareCreateSchema = z
  .object({
    file_id: z.uuid().optional(),
    folder: ShareFolderTargetSchema.optional(),
    scope: ShareScopeSchema.default("PUBLIC_LINK"),
    password: SharePasswordSchema.optional(),
    expires_at: TimestampSchema.optional(),
    max_downloads: z.number().int().positive().optional(),
  })
  .strict()
  .refine((body) => (body.file_id === undefined) !== (body.folder === undefined), {
    message: "exactly one of file_id or folder is required",
  });
export type ShareCreate = z.infer<typeof ShareCreateSchema>;

/** A share as its owner sees it (never the token after creation, never the password hash). */
export const ShareInfoSchema = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  /** Set for a file share. */
  file_id: z.uuid().nullable(),
  /** Set for a folder share. */
  folder_id: z.uuid().nullable(),
  scope: ShareScopeSchema,
  has_password: z.boolean(),
  expires_at: TimestampSchema.nullable(),
  max_downloads: z.number().int().positive().nullable(),
  download_count: z.number().int().nonnegative(),
  created_by: z.string().nullable(),
  created_at: TimestampSchema,
  revoked_at: TimestampSchema.nullable(),
});
export type ShareInfo = z.infer<typeof ShareInfoSchema>;

/** The `201` of `POST /shares`: the info plus the token and the public URL, this once. */
export const ShareCreatedSchema = ShareInfoSchema.extend({
  token: ShareTokenSchema,
  /** `<public url><prefix>/s/<token>`. */
  url: z.string().url(),
});
export type ShareCreated = z.infer<typeof ShareCreatedSchema>;

/** `GET /shares[?file_id=|folder_id=][&include_revoked=1]`, newest first. */
export const ShareListSchema = z.object({ shares: z.array(ShareInfoSchema) });
export type ShareList = z.infer<typeof ShareListSchema>;

/** What the public listing of a shared folder tells about one file: no ids of the tenant or instance, no hash. */
export const SharedFileSchema = z.object({
  /** The file id (what `/public`-style consumers may show); not enough to reach the file without the token. */
  id: z.uuid(),
  filename: z.string(),
  extension: z.string().nullable(),
  size: z.number().int().nonnegative(),
  mime_type: z.string(),
  kind: FileKindSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  /** Relative to the shared folder: what follows `/s/<token>/path/`. */
  path: z.string().min(1),
});
export type SharedFile = z.infer<typeof SharedFileSchema>;

/** A subfolder in the public listing of a shared folder. */
export const SharedFolderSchema = z.object({
  name: z.string(),
  /** Relative to the shared folder (`""` for the shared folder itself). */
  path: z.string(),
});
export type SharedFolder = z.infer<typeof SharedFolderSchema>;

/** The state of the share every public answer may reveal. */
export const ShareStateSchema = z.object({
  expires_at: TimestampSchema.nullable(),
  max_downloads: z.number().int().positive().nullable(),
  download_count: z.number().int().nonnegative(),
});

/**
 * `GET /s/<token>` of a folder share (and `GET /s/<token>/path/<subfolder>`): one level —
 * the folder, its direct subfolders by name, its live files by name.
 */
export const SharedFolderListingSchema = z.object({
  kind: z.literal("folder"),
  share: ShareStateSchema,
  folder: SharedFolderSchema,
  subfolders: z.array(SharedFolderSchema),
  files: z.array(SharedFileSchema),
});
export type SharedFolderListing = z.infer<typeof SharedFolderListingSchema>;

/** `?include_revoked=1` on `GET /shares`. */
export const INCLUDE_REVOKED_QUERY = "include_revoked";

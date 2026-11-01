import { z } from "zod";
import { TimestampSchema } from "./apikey.js";
import { FileInfoSchema, InstanceTypeSchema } from "./files.js";

/** Deepest folder: `a/b/…` of this many segments. */
export const FOLDER_MAX_DEPTH = 32;
/** Longest folder name (one path segment), in characters. */
export const FOLDER_SEGMENT_MAX_LENGTH = 255;

/** `/`, `\`, NUL and every other control character (Unicode `Cc`). */
const FORBIDDEN_IN_SEGMENT = /[/\\\p{Cc}]/u;

/**
 * Why `segment` cannot be a folder name, or `null` when it can: 1–255 characters, no `/`,
 * `\`, NUL or control characters, and neither `.` nor `..` (path traversal).
 */
export function folderSegmentError(segment: string): string | null {
  if (segment.length === 0) return "a folder name must not be empty";
  if (segment.length > FOLDER_SEGMENT_MAX_LENGTH) {
    return `a folder name has at most ${FOLDER_SEGMENT_MAX_LENGTH} characters`;
  }
  if (segment === "." || segment === "..") return `"${segment}" is not a folder name`;
  if (FORBIDDEN_IN_SEGMENT.test(segment)) {
    return "a folder name must not contain /, \\ or control characters";
  }
  return null;
}

/** One folder name (a path segment). */
export const FolderSegmentSchema = z.string().superRefine((value, ctx) => {
  const error = folderSegmentError(value);
  if (error) ctx.addIssue({ code: "custom", message: error });
});

export type ParsedFolderPath =
  | { ok: true; path: string; segments: string[] }
  | { ok: false; error: string };

/**
 * Normalises and validates a folder path: leading and trailing `/` are dropped (`/a/b/` →
 * `a/b`; `/` and `` are the root, `segments: []`), an empty segment (`a//b`) and every
 * invalid segment (see `folderSegmentError`) are refused, as is a depth over
 * `FOLDER_MAX_DEPTH`. The result's `path` is the canonical `a/b/c`.
 */
export function parseFolderPath(raw: string): ParsedFolderPath {
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return { ok: true, path: "", segments: [] };
  const segments = trimmed.split("/");
  if (segments.length > FOLDER_MAX_DEPTH) {
    return { ok: false, error: `a path has at most ${FOLDER_MAX_DEPTH} levels` };
  }
  for (const segment of segments) {
    const error = folderSegmentError(segment);
    if (error) return { ok: false, error: `${error} (in "${trimmed}")` };
  }
  return { ok: true, path: segments.join("/"), segments };
}

/** A folder path as sent by a client, normalised to `a/b/c` (`""` for the root). */
export const FolderPathSchema = z.string().transform((value, ctx) => {
  const parsed = parseFolderPath(value);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  }
  return parsed.path;
});

/**
 * `docs/q4/report.pdf` → `{ folderPath: "docs/q4", filename: "report.pdf" }`; a bare
 * `report.pdf` is a root file (`folderPath: ""`). Leading and trailing `/` are dropped.
 */
export function splitFilePath(raw: string): { folderPath: string; filename: string } {
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash < 0) return { folderPath: "", filename: trimmed };
  return { folderPath: trimmed.slice(0, slash), filename: trimmed.slice(slash + 1) };
}

/** Public view of a folder (`/folders/…` responses). */
export const FolderInfoSchema = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  instance_type: InstanceTypeSchema,
  instance_id: z.uuid(),
  /** `null`: a top-level folder. */
  parent_id: z.uuid().nullable(),
  name: z.string().min(1).max(FOLDER_SEGMENT_MAX_LENGTH),
  /** `a/b/c`, no leading or trailing `/`. */
  path: z.string().min(1),
  /** The folder's encryption policy (phase 6.2); `null` until then. */
  default_keyring_id: z.uuid().nullable(),
  created_by: z.string().nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  deleted_at: TimestampSchema.nullable(),
  deleted_by: z.string().nullable(),
});
export type FolderInfo = z.infer<typeof FolderInfoSchema>;

/** `GET /folders/:type/:id/*path`: one level — the folder (`null` for the root), its direct subfolders and its live files. */
export const FolderListingSchema = z.object({
  folder: FolderInfoSchema.nullable(),
  subfolders: z.array(FolderInfoSchema),
  files: z.array(FileInfoSchema),
});
export type FolderListing = z.infer<typeof FolderListingSchema>;

/**
 * `PATCH /folders/:type/:id/*path`: `name` renames the folder (its descendants follow),
 * `parent_path` moves it under another folder (`""`: the root, created when missing). Both
 * together move and rename at once.
 */
export const FolderPatchSchema = z
  .object({
    name: FolderSegmentSchema.optional(),
    parent_path: FolderPathSchema.optional(),
  })
  .strict()
  .refine((patch) => patch.name !== undefined || patch.parent_path !== undefined, {
    message: "name or parent_path is required",
  });
export type FolderPatch = z.infer<typeof FolderPatchSchema>;

/** `DELETE /folders/:type/:id/*path`: the folder as soft-deleted, and how much went with it. */
export const FolderDeleteResultSchema = z.object({
  folder: FolderInfoSchema,
  /** Folders soft-deleted, the folder itself included. */
  folders: z.number().int().nonnegative(),
  /** Files soft-deleted (in the folder and, with `recursive`, in its descendants). */
  files: z.number().int().nonnegative(),
});
export type FolderDeleteResult = z.infer<typeof FolderDeleteResultSchema>;

/** `?recursive=1` on a folder delete. */
export const RECURSIVE_QUERY = "recursive";

/**
 * `PATCH /files/:type/:id/:fileId`: `folder_path` moves the file (`""`: the root; the folder
 * is created when missing), `filename` renames it (`409 file_exists` when taken), the flags
 * change its visibility (`is_global_public` is refused for an encrypted file).
 */
export const FilePatchSchema = z
  .object({
    folder_path: FolderPathSchema.optional(),
    filename: z.string().min(1).max(255).optional(),
    is_public: z.boolean().optional(),
    is_global_public: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "nothing to change",
  });
export type FilePatch = z.infer<typeof FilePatchSchema>;

/** `GET /files/:type/:id/:fileId/versions`: the whole version chain, newest first. */
export const FileVersionsSchema = z.object({
  versions: z.array(FileInfoSchema),
});
export type FileVersions = z.infer<typeof FileVersionsSchema>;

/** Multipart fields of an upload that place the file (2.2). */
export const UPLOAD_FOLDER_PATH_FIELD = "folder_path";
export const UPLOAD_FOLDER_ID_FIELD = "folder_id";
/** Multipart field naming the previous version the upload supersedes. */
export const UPLOAD_PARENT_ID_FIELD = "parent_id";

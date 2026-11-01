import { createHash, randomBytes } from "node:crypto";
import {
  IMPLEMENTED_SHARE_SCOPES,
  SHARE_TOKEN_BYTES,
  type ShareCreate,
  type SharedFile,
  type SharedFolderListing,
  type ShareInfo,
  type ShareScope,
  ShareTokenSchema,
  splitFilePath,
} from "@vola/core";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/index.js";
import {
  type FileRow,
  type FolderRow,
  files,
  folders,
  type ShareLinkRow,
  shareLinks,
} from "../db/schema.js";
import { VolaError } from "../errors.js";
import {
  type FilesDeps,
  fileNotFound,
  findFileInFolder,
  type InstanceScope,
  parseInstance,
} from "./files.js";
import { type FoldersDeps, findFolder, parsePath } from "./folders.js";
import {
  hashSharePassword,
  MemorySharePasswordLimiter,
  type SharePasswordLimiter,
  verifySharePassword,
} from "./share-password.js";

export interface SharesDeps {
  db: Database;
  logger?: FastifyBaseLogger | undefined;
  /** Wrong-password counter per token. Default: an in-memory one per `SharesDeps`. */
  limiter?: SharePasswordLimiter | undefined;
  /** Clock, for tests. */
  now?: (() => Date) | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** PostgreSQL error code of a unique violation. */
const UNIQUE_VIOLATION = "23505";
const pgCode = (error: unknown): string | undefined =>
  (error as { code?: string } | undefined)?.code ??
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;
const clock = (deps: SharesDeps) => (deps.now ?? (() => new Date()))();

/** The one answer for a share that is not there — another tenant's, an unknown token, a garbled one. */
export function shareNotFound(): VolaError {
  return new VolaError("share_not_found", 404, "share not found");
}

/** A share that existed but answers no more: revoked, expired, its downloads used up, its target gone. */
export function shareGone(reason: string): VolaError {
  return new VolaError("share_gone", 410, `this share link is no longer available: ${reason}`);
}

/** The password of a protected share is missing or wrong (the same answer for both). */
export function sharePasswordRequired(): VolaError {
  return new VolaError(
    "share_password_required",
    401,
    "this share link needs its password (X-Share-Password header or ?password=)",
  );
}

// --- token -------------------------------------------------------------------------------

/** SHA-256 of a share token, lowercase hex: what the database stores and the limiter keys on. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A fresh token (`SHARE_TOKEN_BYTES` random bytes as base64url) and its hash. */
export function generateShareToken(): { token: string; tokenHash: string } {
  const token = randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashShareToken(token) };
}

// --- serialize ---------------------------------------------------------------------------

export function serializeShare(row: ShareLinkRow): ShareInfo {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    file_id: row.fileId,
    folder_id: row.folderId,
    scope: row.scope as ShareScope,
    has_password: row.passwordHash !== null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    max_downloads: row.maxDownloads,
    download_count: row.downloadCount,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    revoked_at: row.revokedAt?.toISOString() ?? null,
  };
}

// --- create ------------------------------------------------------------------------------

export interface CreateShareInput {
  tenantId: string;
  body: ShareCreate;
  userId: string | null;
}

export interface CreatedShare {
  share: ShareInfo;
  /** The plaintext token: shown once, never stored. */
  token: string;
}

/**
 * Creates a share of the tenant's own live file (`file_id`) or folder (`folder`: instance and
 * path). A scope other than `PUBLIC_LINK` is `501 not_implemented`; another tenant's or a
 * deleted target is `404`; an encrypted file is `409 encrypted_share_requires_grant` (its
 * share is the grant of plan 6.3). The password is stored as argon2id, the token as SHA-256.
 */
export async function createShare(
  deps: SharesDeps,
  input: CreateShareInput,
): Promise<CreatedShare> {
  const { body } = input;
  if (!IMPLEMENTED_SHARE_SCOPES.includes(body.scope)) {
    throw new VolaError(
      "not_implemented",
      501,
      `share scope "${body.scope}" is not implemented in this version (only ${IMPLEMENTED_SHARE_SCOPES.join(", ")})`,
    );
  }
  let fileId: string | null = null;
  let folderId: string | null = null;
  if (body.file_id !== undefined) {
    const [file] = await deps.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.tenantId, input.tenantId),
          eq(files.id, body.file_id.toLowerCase()),
          isNull(files.deletedAt),
        ),
      )
      .limit(1);
    if (!file) throw fileNotFound();
    if (file.encryption !== "none") {
      throw new VolaError(
        "encrypted_share_requires_grant",
        409,
        "an encrypted file is shared through a share grant, not a plain link",
      );
    }
    fileId = file.id;
  } else if (body.folder) {
    const scope = parseInstance(input.tenantId, body.folder.instance_type, body.folder.instance_id);
    const folder = await findFolder(folderDeps(deps), scope, body.folder.path);
    folderId = folder.id;
  }
  const passwordHash = body.password ? await hashSharePassword(body.password) : null;
  const now = clock(deps);

  // A token collision is astronomically unlikely; the retry keeps it from ever surfacing.
  for (let attempt = 1; ; attempt++) {
    const { token, tokenHash } = generateShareToken();
    try {
      const [row] = await deps.db
        .insert(shareLinks)
        .values({
          tenantId: input.tenantId,
          fileId,
          folderId,
          tokenHash,
          scope: body.scope,
          passwordHash,
          expiresAt: body.expires_at ? new Date(body.expires_at) : null,
          maxDownloads: body.max_downloads ?? null,
          createdBy: input.userId,
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error("share insert returned no row");
      deps.logger?.info(
        {
          share: row.id,
          target: fileId ? `file ${fileId}` : `folder ${folderId}`,
          has_password: passwordHash !== null,
          expires_at: row.expiresAt?.toISOString() ?? null,
          max_downloads: row.maxDownloads,
        },
        "share created",
      );
      return { share: serializeShare(row), token };
    } catch (error) {
      if (attempt < 5 && pgCode(error) === UNIQUE_VIOLATION) continue;
      throw error;
    }
  }
}

// --- owner side: find, list, revoke ------------------------------------------------------

/** The tenant's share `shareId`; `404 share_not_found` otherwise (another tenant's too). */
export async function findShare(
  deps: SharesDeps,
  tenantId: string,
  shareId: string,
): Promise<ShareLinkRow> {
  if (!UUID_RE.test(shareId)) throw shareNotFound();
  const [row] = await deps.db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.tenantId, tenantId), eq(shareLinks.id, shareId.toLowerCase())))
    .limit(1);
  if (!row) throw shareNotFound();
  return row;
}

export interface ListSharesInput {
  fileId?: string | undefined;
  folderId?: string | undefined;
  includeRevoked?: boolean | undefined;
}

/** Shares the list of a tenant may be filtered by (ids that are not UUIDs match nothing). */
export const SHARE_LIST_LIMIT = 200;

/** The tenant's shares, newest first, optionally of one file or folder; revoked ones only on request. */
export async function listShares(
  deps: SharesDeps,
  tenantId: string,
  input: ListSharesInput = {},
): Promise<ShareInfo[]> {
  const idFilter = (column: AnyPgColumn, value: string | undefined) => {
    if (value === undefined) return undefined;
    // An id that is not a UUID would make PostgreSQL error out: it simply matches nothing.
    return UUID_RE.test(value) ? eq(column, value.toLowerCase()) : sql`false`;
  };
  const rows = await deps.db
    .select()
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.tenantId, tenantId),
        idFilter(shareLinks.fileId, input.fileId),
        idFilter(shareLinks.folderId, input.folderId),
        input.includeRevoked ? undefined : isNull(shareLinks.revokedAt),
      ),
    )
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id))
    .limit(SHARE_LIST_LIMIT);
  return rows.map(serializeShare);
}

/** Revokes the tenant's share `shareId` (`revoked_at`); idempotent; the row stays. */
export async function revokeShare(
  deps: SharesDeps,
  tenantId: string,
  shareId: string,
): Promise<ShareInfo> {
  const row = await findShare(deps, tenantId, shareId);
  if (row.revokedAt) return serializeShare(row);
  const now = clock(deps);
  const [updated] = await deps.db
    .update(shareLinks)
    .set({ revokedAt: now })
    .where(and(eq(shareLinks.id, row.id), isNull(shareLinks.revokedAt)))
    .returning();
  deps.logger?.info({ share: row.id }, "share revoked");
  return serializeShare(updated ?? { ...row, revokedAt: now });
}

// --- public side: resolve, count ---------------------------------------------------------

export interface ResolveShareInput {
  /** From `X-Share-Password` or `?password=`; `undefined` when the request carried none. */
  password?: string | undefined;
}

/** The limiter of `deps`, created on first use. */
function limiterOf(deps: SharesDeps): SharePasswordLimiter {
  deps.limiter ??= new MemorySharePasswordLimiter({ now: deps.now });
  return deps.limiter;
}

/**
 * The share behind `token`, checked in this order: unknown or malformed token → `404`;
 * revoked or expired → `410 share_gone` (no password needed to learn that); then, for a
 * protected share, the password — too many wrong ones for this token →
 * `429 too_many_password_attempts` (the right one included, until the window ends), missing
 * or wrong → `401 share_password_required` and one more failure recorded.
 *
 * `max_downloads` is NOT checked here: a share whose downloads are used up refuses to START
 * another one (`consumeDownload` → `410`), but still answers a `HEAD` and the `Range`
 * continuation of the download it already granted — otherwise the last allowed download
 * could never be resumed after an interruption. The limit counts started downloads; it is
 * not a cap on bytes.
 */
export async function resolveShare(
  deps: SharesDeps,
  token: string,
  input: ResolveShareInput = {},
): Promise<ShareLinkRow> {
  if (!ShareTokenSchema.safeParse(token).success) throw shareNotFound();
  const tokenHash = hashShareToken(token);
  const [row] = await deps.db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.tokenHash, tokenHash))
    .limit(1);
  if (!row) throw shareNotFound();
  const now = clock(deps);
  if (row.revokedAt) throw shareGone("it was revoked");
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) throw shareGone("it expired");
  if (row.passwordHash !== null) {
    const limiter = limiterOf(deps);
    const state = await limiter.check(tokenHash);
    if (state.blocked) {
      throw new VolaError(
        "too_many_password_attempts",
        429,
        `too many wrong passwords for this share link; try again in ${state.retryAfterS} s`,
        { retry_after: state.retryAfterS },
      );
    }
    if (input.password === undefined || input.password === "") throw sharePasswordRequired();
    if (!(await verifySharePassword(row.passwordHash, input.password))) {
      await limiter.fail(tokenHash);
      deps.logger?.info({ share: row.id, failures: state.failures + 1 }, "share password wrong");
      throw sharePasswordRequired();
    }
  }
  return row;
}

/**
 * Whether this request STARTS a download — the only kind that counts against
 * `max_downloads`: a `GET` of the whole file, or one whose `Range` begins at byte 0. A `HEAD`
 * and the continuation of an interrupted download (`Range` from a later byte, or a suffix
 * range) do not count; a `Range` the download code ignores (malformed, several ranges)
 * answers the whole file and counts.
 */
export function startsDownload(method: string, range: string | undefined): boolean {
  if (method.toUpperCase() !== "GET") return false;
  if (!range) return true;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return true;
  const [, first = "", last = ""] = match;
  if (!first && !last) return true;
  return first !== "" && Number(first) === 0;
}

/**
 * Counts one download on `share`, atomically against `max_downloads`
 * (`UPDATE … SET download_count = download_count + 1 WHERE download_count < max_downloads
 * RETURNING`): two readers racing for the last download cannot both get it. The loser — or a
 * share revoked meanwhile — is `410 share_gone`. Returns the new count.
 */
export async function consumeDownload(deps: SharesDeps, share: ShareLinkRow): Promise<number> {
  const [updated] = await deps.db
    .update(shareLinks)
    .set({ downloadCount: sql`${shareLinks.downloadCount} + 1` })
    .where(
      and(
        eq(shareLinks.id, share.id),
        isNull(shareLinks.revokedAt),
        sql`(${shareLinks.maxDownloads} is null or ${shareLinks.downloadCount} < ${shareLinks.maxDownloads})`,
      ),
    )
    .returning({ downloadCount: shareLinks.downloadCount });
  if (!updated)
    throw shareGone(share.revokedAt ? "it was revoked" : "its download limit was reached");
  return updated.downloadCount;
}

// --- targets -----------------------------------------------------------------------------

/** The live, unencrypted file a file share points at; `410 share_gone` when it is deleted or encrypted meanwhile. */
export async function sharedFile(deps: SharesDeps, share: ShareLinkRow): Promise<FileRow> {
  if (!share.fileId) throw shareNotFound();
  const [row] = await deps.db
    .select()
    .from(files)
    .where(and(eq(files.id, share.fileId), isNull(files.deletedAt)))
    .limit(1);
  if (!row) throw shareGone("the shared file was deleted");
  if (row.encryption !== "none") throw shareGone("the shared file is encrypted");
  return row;
}

/** The live folder a folder share points at; `410 share_gone` when it was deleted meanwhile. */
export async function sharedFolder(deps: SharesDeps, share: ShareLinkRow): Promise<FolderRow> {
  if (!share.folderId) throw shareNotFound();
  const [row] = await deps.db
    .select()
    .from(folders)
    .where(and(eq(folders.id, share.folderId), isNull(folders.deletedAt)))
    .limit(1);
  if (!row) throw shareGone("the shared folder was deleted");
  return row;
}

const folderDeps = (deps: SharesDeps): FoldersDeps => ({
  db: deps.db,
  logger: deps.logger,
  now: deps.now,
});
const fileDeps = (deps: SharesDeps): FilesDeps =>
  ({ db: deps.db, logger: deps.logger, now: deps.now }) as FilesDeps;

/** The instance a folder lives in. */
export function scopeOfFolder(folder: FolderRow): InstanceScope {
  return {
    tenantId: folder.tenantId,
    instanceType: folder.instanceType,
    instanceId: folder.instanceId,
  };
}

/** `docs/q4` below a shared folder `root/docs/q4` → `q4` relative to the share; `""` for the root itself. */
export function relativeToShare(root: FolderRow, path: string): string {
  return path === root.path ? "" : path.slice(root.path.length + 1);
}

/** The public view of one file in a shared folder: no tenant, no instance, no hash. */
export function serializeSharedFile(row: FileRow, relativeFolder: string): SharedFile {
  return {
    id: row.id,
    filename: row.filename,
    extension: row.extension,
    size: Number(row.size),
    mime_type: row.mimeType,
    kind: row.kind as SharedFile["kind"],
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    path: relativeFolder ? `${relativeFolder}/${row.filename}` : row.filename,
  };
}

/**
 * One level of a shared folder (`folder` is the shared folder itself or a live descendant):
 * direct subfolders by name, live unencrypted files by name, every path relative to the share.
 */
export async function listSharedFolder(
  deps: SharesDeps,
  share: ShareLinkRow,
  root: FolderRow,
  folder: FolderRow,
): Promise<SharedFolderListing> {
  const relative = relativeToShare(root, folder.path);
  const subfolders = await deps.db
    .select({ name: folders.name, path: folders.path })
    .from(folders)
    .where(and(eq(folders.parentId, folder.id), isNull(folders.deletedAt)))
    .orderBy(asc(folders.name), asc(folders.id));
  const rows = await deps.db
    .select()
    .from(files)
    .where(
      and(eq(files.folderId, folder.id), isNull(files.deletedAt), eq(files.encryption, "none")),
    )
    .orderBy(asc(files.filename), asc(files.createdAt), asc(files.id));
  return {
    kind: "folder",
    share: {
      expires_at: share.expiresAt?.toISOString() ?? null,
      max_downloads: share.maxDownloads,
      download_count: share.downloadCount,
    },
    folder: { name: folder.name, path: relative },
    subfolders: subfolders.map((f) => ({ name: f.name, path: relativeToShare(root, f.path) })),
    files: rows.map((row) => serializeSharedFile(row, relative)),
  };
}

/** What a relative path inside a shared folder points at. */
export type SharedPathTarget =
  | { kind: "file"; file: FileRow }
  | { kind: "folder"; folder: FolderRow };

/**
 * Resolves `relativePath` (`q4/report.pdf`, `q4`) inside the shared folder `root`: the newest
 * live, unencrypted file of that name in that subfolder, or — when there is no such file —
 * the live subfolder of that path. A bad segment (`..`, `\`) is `422 validation_error`;
 * nothing there is `404 file_not_found`. Never leaves the shared subtree: every lookup is
 * prefixed with `root.path` inside `root`'s instance.
 */
export async function resolveSharedPath(
  deps: SharesDeps,
  root: FolderRow,
  relativePath: string,
): Promise<SharedPathTarget> {
  const { folderPath, filename } = splitFilePath(relativePath);
  const relativeFolder = parsePath(folderPath);
  if (filename !== "") parsePath(filename, "path");
  const scope = scopeOfFolder(root);
  const fdeps = folderDeps(deps);
  const container =
    relativeFolder === "" ? root : await findFolder(fdeps, scope, `${root.path}/${relativeFolder}`);
  if (filename !== "") {
    try {
      const file = await findFileInFolder(fileDeps(deps), scope, container.id, filename);
      if (file.encryption === "none") return { kind: "file", file };
    } catch (error) {
      if (!(error instanceof VolaError) || error.code !== "file_not_found") throw error;
    }
    const [subfolder] = await deps.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.parentId, container.id),
          eq(folders.name, filename),
          isNull(folders.deletedAt),
        ),
      )
      .limit(1);
    if (subfolder) return { kind: "folder", folder: subfolder };
    throw fileNotFound();
  }
  return { kind: "folder", folder: container };
}

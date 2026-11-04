import { createHash, randomBytes } from "node:crypto";
import {
  callerGrantAad as coreCallerGrantAad,
  ENCRYPTED_SHARE_REQUIRES_GRANT_CODE,
  IMPLEMENTED_SHARE_SCOPES,
  SHARE_SECRET_BYTES,
  SHARE_SECRET_REQUIRED_CODE,
  SHARE_TOKEN_BYTES,
  type ShareCreate,
  type SharedFile,
  type SharedFolderListing,
  type ShareInfo,
  type ShareScope,
  ShareSecretSchema,
  ShareTokenSchema,
  splitFilePath,
} from "@vol-a/core";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { FastifyBaseLogger } from "fastify";
import type { AuditLog } from "../audit/log.js";
import { aeadOpen, aeadSeal, IntegrityError, KEY_BYTES, openMeta } from "../crypto/index.js";
import type { Database } from "../db/index.js";
import {
  type FileRow,
  type FolderRow,
  files,
  folders,
  type ShareLinkRow,
  shareLinks,
} from "../db/schema.js";
import { uuidv7 } from "../db/uuid.js";
import { VolaError } from "../errors.js";
import { type EncryptionService, integrityFailure, type OpenedFile } from "./encryption.js";
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
  /** The audit trail (`VOLA_SHARE_CREATED`, `VOLA_SHARE_REVOKED`); never the token or the password. */
  audit?: AuditLog | undefined;
  /** Encryption (plan 6.3): opens an encrypted file's key for its share grant; absent → `409` for encrypted files. */
  crypto?: EncryptionService | undefined;
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

/** `401 share_secret_required`: the share of an encrypted file was asked for without its secret. */
export function shareSecretRequired(): VolaError {
  return new VolaError(
    SHARE_SECRET_REQUIRED_CODE,
    401,
    "this share link is of an encrypted file: send the secret after # in the link as X-Share-Secret",
  );
}

/** `409 encrypted_share_requires_grant`: a share the server cannot make a grant for. */
export function encryptedShareRequiresGrant(mode: string): VolaError {
  return new VolaError(
    ENCRYPTED_SHARE_REQUIRES_GRANT_CODE,
    409,
    mode === "caller"
      ? "a caller-encrypted file's share needs the grant from the caller: send fk_share_ct (the file key wrapped under the link secret)"
      : "a client-encrypted file cannot be shared: the server holds no key to grant",
  );
}

// --- the share grant (plan 6.3) ----------------------------------------------------------

/** `<share id>:key`: the AAD of a grant the SERVER made. */
export function shareGrantAad(shareId: string): Buffer {
  return Buffer.from(`${shareId}:key`, "utf8");
}

/** `<file id>:key:share:caller`: the AAD of a grant a CALLER made (it cannot know the share id). */
export function callerGrantAad(fileId: string): Buffer {
  return Buffer.from(coreCallerGrantAad(fileId), "utf8");
}

/** A fresh link secret `S` and its base64url form (the URL fragment). */
export function newShareSecret(): { secret: Buffer; fragment: string } {
  const secret = randomBytes(SHARE_SECRET_BYTES);
  return { secret, fragment: secret.toString("base64url") };
}

/** `fk_share_ct` = `nonce ∥ AES-256-GCM(S, FK, "<share id>:key")`. */
export function wrapShareGrant(secret: Buffer, fk: Buffer, shareId: string): Buffer {
  return aeadSeal(secret, fk, shareGrantAad(shareId));
}

/**
 * The file key behind a share's grant, under the secret the request sent. `null` for a
 * request without a secret (the route answers `401`); a secret that does not open the grant —
 * or a damaged grant — is `409 vola_integrity`, the one fixed sentence.
 */
export function openShareGrant(
  share: Pick<ShareLinkRow, "id" | "fileId" | "fkShareCt">,
  rawSecret: string | undefined,
): Buffer | null {
  if (rawSecret === undefined || rawSecret === "") return null;
  if (!ShareSecretSchema.safeParse(rawSecret).success) throw integrityFailure();
  const secret = Buffer.from(rawSecret, "base64url");
  if (secret.length !== KEY_BYTES || !share.fkShareCt || !share.fileId) throw integrityFailure();
  try {
    // The server's grant first; a caller-made one is bound to the file id instead.
    return aeadOpen(secret, share.fkShareCt, shareGrantAad(share.id));
  } catch (first) {
    if (!(first instanceof IntegrityError)) throw first;
    try {
      return aeadOpen(secret, share.fkShareCt, callerGrantAad(share.fileId));
    } catch (second) {
      if (second instanceof IntegrityError) throw integrityFailure();
      throw second;
    }
  } finally {
    secret.fill(0);
  }
}

/**
 * The key and metadata of the encrypted `file` of a share, from its grant and the request's
 * secret (`X-Share-Secret`): `401 share_secret_required` without one, `409 vola_integrity` for
 * a wrong one or a metadata record that does not open under it.
 */
export function openSharedEncryptedFile(
  share: ShareLinkRow,
  file: FileRow,
  rawSecret: string | undefined,
): OpenedFile {
  const fk = openShareGrant(share, rawSecret);
  if (!fk) throw shareSecretRequired();
  if (!file.metaCt) {
    fk.fill(0);
    throw integrityFailure();
  }
  try {
    return { fk, meta: openMeta(fk, file.id, file.metaCt) };
  } catch (error) {
    fk.fill(0);
    if (error instanceof IntegrityError) throw integrityFailure();
    throw error;
  }
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
    encrypted: row.fkShareCt !== null,
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
  /**
   * The link secret `S` of an encrypted file's share as base64url — the URL FRAGMENT: shown
   * once, never stored (the server keeps only the file key wrapped under it). `null` for a
   * plain file, and for a `caller` file whose grant the caller made itself (it holds `S`).
   */
  secret: string | null;
}

/**
 * Creates a share of the tenant's own live file (`file_id`) or folder (`folder`: instance and
 * path). A scope other than `PUBLIC_LINK` is `501 not_implemented`; another tenant's or a
 * deleted target is `404`. The password is stored as argon2id, the token as SHA-256.
 *
 * An ENCRYPTED file (plan 6.3, `docs/CRYPTO.md` § 12) gets a share GRANT: the request has
 * to hold the file key — the key file for `tenant`, the owner's `X-Vola-Unlock` for `keyring`
 * (`423` without) — the server draws a 32-byte secret `S`, wraps the key under it
 * (`fk_share_ct`, AAD `<share id>:key`) and hands `S` back ONCE as the fragment of the URL;
 * nothing of `S` is stored. A `caller` file is `409 encrypted_share_requires_grant` unless
 * the caller sends its own `fk_share_ct` (it holds the key, the server never did); a `client`
 * file is `409` always.
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
  let encrypted: FileRow | null = null;
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
    fileId = file.id;
    encrypted = file;
  } else if (body.folder) {
    const scope = parseInstance(input.tenantId, body.folder.instance_type, body.folder.instance_id);
    const folder = await findFolder(folderDeps(deps), scope, body.folder.path);
    folderId = folder.id;
  }
  if (body.fk_share_ct !== undefined && encrypted?.encryption !== "caller") {
    throw new VolaError(
      "validation_error",
      422,
      "fk_share_ct: only a caller-encrypted file takes a grant made by the caller",
    );
  }
  // The share id is drawn HERE: a server-made grant is bound to it through the AAD.
  const shareId = uuidv7();
  let fkShareCt: Buffer | null = null;
  let secret: string | null = null;
  if (encrypted && encrypted.encryption !== "none") {
    const mode = encrypted.encryption;
    if (mode === "caller" && body.fk_share_ct !== undefined) {
      fkShareCt = Buffer.from(body.fk_share_ct.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (fkShareCt.length < 60 || fkShareCt.length > 256) {
        throw new VolaError(
          "validation_error",
          422,
          "fk_share_ct: nonce ∥ ct ∥ tag of a 32-byte key",
        );
      }
    } else if (mode === "caller" || mode === "client" || !deps.crypto) {
      throw encryptedShareRequiresGrant(mode);
    } else {
      const fk = await deps.crypto.fileKey(encrypted); // 503 / 409 / 423 here
      try {
        const drawn = newShareSecret();
        fkShareCt = wrapShareGrant(drawn.secret, fk, shareId);
        secret = drawn.fragment;
        drawn.secret.fill(0);
      } finally {
        fk.fill(0);
      }
    }
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
          id: shareId,
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
          fkShareCt,
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
          grant: fkShareCt !== null,
        },
        "share created",
      );
      deps.audit?.emit({
        event_type: "VOLA_SHARE_CREATED",
        instance_type: "vola_share",
        instance_id: row.id,
        payload: shareAuditPayload(row),
      });
      return { share: serializeShare(row), token, secret };
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
  /** Only the shares this user made (the examples site's visitors see their own). */
  createdBy?: string | undefined;
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
        input.createdBy === undefined ? undefined : eq(shareLinks.createdBy, input.createdBy),
      ),
    )
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id))
    .limit(SHARE_LIST_LIMIT);
  return rows.map(serializeShare);
}

/**
 * Revokes the tenant's share `shareId` (`revoked_at`); idempotent; the row stays — except its
 * grant: `fk_share_ct` is dropped, the crypto-shred of the grant (whoever kept the link and
 * its secret has nothing to open any more; the owner's own key is untouched).
 */
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
    .set({ revokedAt: now, fkShareCt: null })
    .where(and(eq(shareLinks.id, row.id), isNull(shareLinks.revokedAt)))
    .returning();
  deps.logger?.info({ share: row.id, grant_dropped: row.fkShareCt !== null }, "share revoked");
  const revoked = updated ?? { ...row, revokedAt: now, fkShareCt: null };
  deps.audit?.emit({
    event_type: "VOLA_SHARE_REVOKED",
    instance_type: "vola_share",
    instance_id: row.id,
    payload: shareAuditPayload(revoked),
  });
  return serializeShare(revoked);
}

/** What a share event says: the target, the scope, the limits — never the token hash, never the password hash. */
export function shareAuditPayload(row: ShareLinkRow): Record<string, unknown> {
  return {
    share_id: row.id,
    file_id: row.fileId,
    folder_id: row.folderId,
    scope: row.scope,
    has_password: row.passwordHash !== null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    max_downloads: row.maxDownloads,
    download_count: row.downloadCount,
    created_at: row.createdAt.toISOString(),
    revoked_at: row.revokedAt?.toISOString() ?? null,
    encrypted: row.fkShareCt !== null,
  };
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

/**
 * The live file a file share points at; `410 share_gone` when it was deleted meanwhile, or
 * when it is encrypted and the share holds no grant for it (a plain file encrypted after the
 * share was made — not a path vola offers, but the rule holds).
 */
export async function sharedFile(deps: SharesDeps, share: ShareLinkRow): Promise<FileRow> {
  if (!share.fileId) throw shareNotFound();
  const [row] = await deps.db
    .select()
    .from(files)
    .where(and(eq(files.id, share.fileId), isNull(files.deletedAt)))
    .limit(1);
  if (!row) throw shareGone("the shared file was deleted");
  if (row.encryption !== "none" && !share.fkShareCt) {
    throw shareGone("the shared file is encrypted and this link holds no grant for it");
  }
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

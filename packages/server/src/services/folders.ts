import {
  FOLDER_MAX_DEPTH,
  type FolderDeleteResult,
  type FolderInfo,
  type FolderListing,
  folderSegmentError,
  parseFolderPath,
} from "@vola/core";
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { AuditLog } from "../audit/log.js";
import { fileAuditPayload } from "../audit/memento.js";
import type { Database } from "../db/index.js";
import { type FolderRow, files, folders } from "../db/schema.js";
import { VolaError } from "../errors.js";
import { type FileEventBus, publishFileEvents } from "../events/bus.js";
import { type InstanceScope, serializeFile } from "./files.js";
import { attachProcessingStatus } from "./processing.js";

export interface FoldersDeps {
  db: Database;
  logger?: FastifyBaseLogger | undefined;
  /** Where a change of the files in a folder is announced after its commit; absent: nowhere. */
  events?: FileEventBus | undefined;
  /** The audit trail: every file a folder delete soft-deletes is recorded (`VOLA_FILE_DELETED`). */
  audit?: AuditLog | undefined;
  /** Clock, for tests. */
  now?: (() => Date) | undefined;
}

/** What the DML of this module runs on: the database or a transaction of it. */
type Tx = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** PostgreSQL error code of a unique violation. */
const UNIQUE_VIOLATION = "23505";
const pgCode = (error: unknown): string | undefined =>
  (error as { code?: string } | undefined)?.code ??
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** The one answer for a folder that is not there — or belongs to another tenant (never 403). */
export function folderNotFound(path: string): VolaError {
  return new VolaError("folder_not_found", 404, `folder "${path}" not found`);
}

function folderExists(path: string): VolaError {
  return new VolaError("folder_exists", 409, `a folder "${path}" already exists`);
}

function validation(message: string): VolaError {
  return new VolaError("validation_error", 422, message);
}

/** Validates and normalises a folder path of a route or body; `422 validation_error` otherwise. */
export function parsePath(raw: string | undefined | null, field = "path"): string {
  const parsed = parseFolderPath(raw ?? "");
  if (!parsed.ok) throw validation(`${field}: ${parsed.error}`);
  return parsed.path;
}

/** Validates one folder name; `422 validation_error` otherwise. */
export function parseSegment(raw: string, field = "name"): string {
  const error = folderSegmentError(raw);
  if (error) throw validation(`${field}: ${error}`);
  return raw;
}

export function serializeFolder(row: FolderRow): FolderInfo {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    instance_type: row.instanceType,
    instance_id: row.instanceId,
    parent_id: row.parentId,
    name: row.name,
    path: row.path,
    default_keyring_id: row.defaultKeyringId,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    deleted_at: row.deletedAt?.toISOString() ?? null,
    deleted_by: row.deletedBy,
  };
}

function instanceWhere(scope: InstanceScope) {
  return and(
    eq(folders.tenantId, scope.tenantId),
    eq(folders.instanceType, scope.instanceType),
    eq(folders.instanceId, scope.instanceId),
  );
}

/** `%`, `_` and `\` of a LIKE pattern literal, escaped (PostgreSQL's default escape is `\`). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `path` itself and everything below it (`path/…`), live rows only. */
function subtreeWhere(scope: InstanceScope, path: string) {
  return and(
    instanceWhere(scope),
    isNull(folders.deletedAt),
    or(eq(folders.path, path), like(folders.path, `${escapeLike(path)}/%`)),
  );
}

/** The parent path of `a/b/c` is `a/b`; of `a` it is `""` (the root). */
export function parentPathOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

const joinPath = (parent: string, name: string): string => (parent ? `${parent}/${name}` : name);

// --- lookup ------------------------------------------------------------------------------

async function selectLive(tx: Tx, scope: InstanceScope, path: string): Promise<FolderRow | null> {
  const [row] = await tx
    .select()
    .from(folders)
    .where(and(instanceWhere(scope), eq(folders.path, path), isNull(folders.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The live folder at `path` (already normalised, not the root); `404 folder_not_found` otherwise. */
export async function findFolder(
  deps: FoldersDeps,
  scope: InstanceScope,
  path: string,
): Promise<FolderRow> {
  const row = await selectLive(deps.db, scope, path);
  if (!row) throw folderNotFound(path);
  return row;
}

/** The live folder `folderId` of the instance; `404 folder_not_found` otherwise. */
export async function findFolderById(
  deps: FoldersDeps,
  scope: InstanceScope,
  folderId: string,
): Promise<FolderRow> {
  if (!UUID_RE.test(folderId)) throw folderNotFound(folderId);
  const [row] = await deps.db
    .select()
    .from(folders)
    .where(
      and(instanceWhere(scope), eq(folders.id, folderId.toLowerCase()), isNull(folders.deletedAt)),
    )
    .limit(1);
  if (!row) throw folderNotFound(folderId);
  return row;
}

/**
 * Resolves `folderPath` (normalised) to a folder id for a file: `""` is the root (`null`),
 * anything else is created when missing (the whole chain of parents too).
 */
export async function resolveFolderId(
  deps: FoldersDeps,
  scope: InstanceScope,
  folderPath: string,
  userId: string | null,
): Promise<string | null> {
  if (folderPath === "") return null;
  return (await ensureFolder(deps, scope, folderPath, userId)).folder.id;
}

// --- encryption policy (plan 6.2) --------------------------------------------------------

/**
 * The keyring every new upload into the folder `folderId` goes under: the folder's own
 * `default_keyring_id`, else the nearest ancestor's; `null` for the root or a lineage
 * without a policy. One query over the path prefixes — folders are looked up by their full
 * path, never walked. A soft-deleted folder has no policy.
 */
export async function effectiveKeyringId(
  deps: Pick<FoldersDeps, "db">,
  scope: InstanceScope,
  folderId: string | null,
): Promise<string | null> {
  if (folderId === null) return null;
  const [folder] = await deps.db
    .select({ path: folders.path })
    .from(folders)
    .where(and(instanceWhere(scope), eq(folders.id, folderId), isNull(folders.deletedAt)))
    .limit(1);
  if (!folder) return null;
  return effectiveKeyringIdOfPath(deps, scope, folder.path);
}

/** `effectiveKeyringId` for a path (the folder may not exist yet: its ancestors still decide). */
export async function effectiveKeyringIdOfPath(
  deps: Pick<FoldersDeps, "db">,
  scope: InstanceScope,
  path: string,
): Promise<string | null> {
  if (path === "") return null;
  const segments = path.split("/");
  const prefixes = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
  const [nearest] = await deps.db
    .select({ keyringId: folders.defaultKeyringId })
    .from(folders)
    .where(
      and(
        instanceWhere(scope),
        isNull(folders.deletedAt),
        isNotNull(folders.defaultKeyringId),
        inArray(folders.path, prefixes),
      ),
    )
    .orderBy(desc(sql`length(${folders.path})`))
    .limit(1);
  return nearest?.keyringId ?? null;
}

/**
 * `PATCH …/*path {default_keyring}`: sets (or clears, with `null`) the folder's own policy.
 * Files already in the folder are not touched — the policy is for what arrives next.
 */
export async function setFolderKeyring(
  deps: FoldersDeps,
  scope: InstanceScope,
  path: string,
  keyringId: string | null,
): Promise<FolderInfo> {
  const folder = await findFolder(deps, scope, path);
  if (folder.defaultKeyringId === keyringId) return serializeFolder(folder);
  const now = (deps.now ?? (() => new Date()))();
  const [updated] = await deps.db
    .update(folders)
    .set({ defaultKeyringId: keyringId, updatedAt: now })
    .where(and(eq(folders.id, folder.id), isNull(folders.deletedAt)))
    .returning();
  if (!updated) throw folderNotFound(path);
  deps.logger?.info(
    { folder: folder.id, path, keyring: keyringId },
    keyringId ? "folder encryption policy set" : "folder encryption policy cleared",
  );
  return serializeFolder(updated);
}

// --- create ------------------------------------------------------------------------------

export interface EnsureResult {
  folder: FolderRow;
  /** `true` when the leaf did not exist before this call. */
  created: boolean;
}

/**
 * The folder at `path` (normalised, not the root), creating it and every missing parent on
 * the way. Idempotent: an existing path is returned with `created: false`. A concurrent
 * creation of the same segment trips the partial unique index; that row is then read back.
 */
export async function ensureFolder(
  deps: FoldersDeps,
  scope: InstanceScope,
  path: string,
  userId: string | null,
): Promise<EnsureResult> {
  const segments = path.split("/");
  if (path === "" || segments.length > FOLDER_MAX_DEPTH) {
    throw validation(path === "" ? "path: the root is not a folder" : "path: too deep");
  }
  const now = (deps.now ?? (() => new Date()))();
  let parent: FolderRow | null = null;
  let created = false;
  let running = "";
  for (const segment of segments) {
    running = joinPath(running, segment);
    const existing = await selectLive(deps.db, scope, running);
    if (existing) {
      parent = existing;
      created = false;
      continue;
    }
    const [inserted]: FolderRow[] = await deps.db
      .insert(folders)
      .values({
        tenantId: scope.tenantId,
        instanceType: scope.instanceType,
        instanceId: scope.instanceId,
        parentId: parent?.id ?? null,
        name: segment,
        path: running,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [folders.tenantId, folders.instanceType, folders.instanceId, folders.path],
        where: sql`${folders.deletedAt} is null`,
      })
      .returning();
    if (inserted) {
      deps.logger?.info(
        {
          folder: inserted.id,
          path: running,
          instance: `${scope.instanceType}/${scope.instanceId}`,
        },
        "folder created",
      );
      parent = inserted;
      created = true;
    } else {
      // Lost the race: the other request's row is live now.
      parent = await selectLive(deps.db, scope, running);
      if (!parent) throw folderNotFound(running);
      created = false;
    }
  }
  return { folder: parent as FolderRow, created };
}

// --- list --------------------------------------------------------------------------------

/** One level: the folder at `path` (`null` for the root `""`), its direct subfolders by name, its live files by name. */
export async function listFolder(
  deps: FoldersDeps,
  scope: InstanceScope,
  path: string,
): Promise<FolderListing> {
  const folder = path === "" ? null : await findFolder(deps, scope, path);
  const folderId = folder?.id ?? null;
  const subfolders = await deps.db
    .select()
    .from(folders)
    .where(
      and(
        instanceWhere(scope),
        isNull(folders.deletedAt),
        folderId ? eq(folders.parentId, folderId) : isNull(folders.parentId),
      ),
    )
    .orderBy(asc(folders.name), asc(folders.id));
  const rows = await deps.db
    .select()
    .from(files)
    .where(
      and(
        eq(files.tenantId, scope.tenantId),
        eq(files.instanceType, scope.instanceType),
        eq(files.instanceId, scope.instanceId),
        isNull(files.deletedAt),
        folderId ? eq(files.folderId, folderId) : isNull(files.folderId),
      ),
    )
    .orderBy(asc(files.filename), asc(files.createdAt), asc(files.id));
  return {
    folder: folder ? serializeFolder(folder) : null,
    subfolders: subfolders.map(serializeFolder),
    files: await attachProcessingStatus(
      deps.db,
      rows.map((row) => serializeFile(row)),
    ),
  };
}

// --- rename / move -----------------------------------------------------------------------

export interface RelocateInput {
  /** The new name of the folder (rename); default: unchanged. */
  name?: string | undefined;
  /** The new parent path, `""` for the root (move; created when missing); default: unchanged. */
  parentPath?: string | undefined;
  userId: string | null;
}

/**
 * Renames and/or moves the folder at `path`: the folder's own `path`, `name` and `parent_id`
 * and the `path` of every live descendant are rewritten in ONE transaction (`a/b` → `x/y`
 * turns `a/b/c/d` into `x/y/c/d`). A live folder at the destination is `409 folder_exists`
 * (also when a concurrent rename wins the race); moving a folder into itself or below itself
 * is `422 validation_error`. A no-op (same name, same parent) returns the folder unchanged.
 */
export async function relocateFolder(
  deps: FoldersDeps,
  scope: InstanceScope,
  path: string,
  input: RelocateInput,
): Promise<FolderInfo> {
  const folder = await findFolder(deps, scope, path);
  const name = input.name ?? folder.name;
  const parentPath = input.parentPath ?? parentPathOf(path);
  const target = joinPath(parentPath, name);
  if (target === path) return serializeFolder(folder);
  if (parentPath === path || parentPath.startsWith(`${path}/`)) {
    throw validation("parent_path: a folder cannot be moved into itself or below itself");
  }
  if (target.split("/").length > FOLDER_MAX_DEPTH) throw validation("path: too deep");
  const descendantDepth = await deepestBelow(deps.db, scope, path);
  if (descendantDepth - path.split("/").length + target.split("/").length > FOLDER_MAX_DEPTH) {
    throw validation(`path: a descendant would exceed ${FOLDER_MAX_DEPTH} levels`);
  }
  if (await selectLive(deps.db, scope, target)) throw folderExists(target);
  const parentId =
    parentPath === parentPathOf(path)
      ? folder.parentId
      : await resolveFolderId(deps, scope, parentPath, input.userId);

  const now = (deps.now ?? (() => new Date()))();
  try {
    const { result, movedFiles } = await deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${scope.tenantId}/${scope.instanceType}/${scope.instanceId}`}, 0))`,
      );
      // Descendants first (their LIKE match is by the old prefix), then the folder itself.
      const moved = await tx
        .update(folders)
        .set({
          path: sql`${target} || substr(${folders.path}, ${path.length + 1})`,
          updatedAt: now,
        })
        .where(subtreeWhere(scope, path))
        .returning({ id: folders.id });
      const [updated] = await tx
        .update(folders)
        .set({ name, parentId, updatedAt: now })
        .where(and(eq(folders.id, folder.id), isNull(folders.deletedAt)))
        .returning();
      if (!updated) throw folderNotFound(path);
      deps.logger?.info(
        { folder: folder.id, from: path, to: target, folders: moved.length },
        "folder relocated",
      );
      // Every live file in the subtree now has another `folder_path`.
      const movedFiles =
        deps.events && moved.length > 0
          ? await tx
              .select({ id: files.id, folderId: files.folderId })
              .from(files)
              .where(
                and(
                  inArray(
                    files.folderId,
                    moved.map((f) => f.id),
                  ),
                  isNull(files.deletedAt),
                ),
              )
          : [];
      return { result: serializeFolder(updated), movedFiles };
    });
    await publishFileEvents(deps, { ...scope, kind: "updated" }, movedFiles);
    return result;
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw folderExists(target);
    throw error;
  }
}

/** The depth (segment count) of the deepest live folder at or below `path`. */
async function deepestBelow(tx: Tx, scope: InstanceScope, path: string): Promise<number> {
  const [row] = await tx
    .select({
      depth: sql<number>`coalesce(max(length(${folders.path}) - length(replace(${folders.path}, '/', '')) + 1), 0)`,
    })
    .from(folders)
    .where(subtreeWhere(scope, path));
  return Number(row?.depth ?? 0);
}

// --- delete ------------------------------------------------------------------------------

/**
 * Soft-deletes the folder at `path`. Without `recursive` the folder must be empty — no live
 * subfolder, no live file in it — or the answer is `409 folder_not_empty`; with it every
 * live descendant folder and every live file in any of them goes too, in one transaction.
 */
export async function deleteFolder(
  deps: FoldersDeps,
  scope: InstanceScope,
  path: string,
  options: { recursive: boolean; userId: string | null },
): Promise<FolderDeleteResult> {
  const folder = await findFolder(deps, scope, path);
  const now = (deps.now ?? (() => new Date()))();
  const { result, deletedFiles } = await deps.db.transaction(async (tx) => {
    const subtree = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(subtreeWhere(scope, path));
    const ids = subtree.map((row) => row.id);
    const [count] = await tx
      .select({ files: sql<number>`count(*)` })
      .from(files)
      .where(and(inArray(files.folderId, ids), isNull(files.deletedAt)));
    const liveFiles = Number(count?.files ?? 0);
    if (!options.recursive && (ids.length > 1 || liveFiles > 0)) {
      throw new VolaError(
        "folder_not_empty",
        409,
        `folder "${path}" is not empty (${ids.length - 1} subfolders, ${liveFiles} files); pass recursive=1 to delete everything in it`,
      );
    }
    const deletedFiles = await tx
      .update(files)
      .set({ deletedAt: now, deletedBy: options.userId, updatedAt: now })
      .where(and(inArray(files.folderId, ids), isNull(files.deletedAt)))
      .returning();
    const deletedFolders = await tx
      .update(folders)
      .set({ deletedAt: now, deletedBy: options.userId, updatedAt: now })
      .where(and(inArray(folders.id, ids), isNull(folders.deletedAt)))
      .returning();
    const self = deletedFolders.find((row) => row.id === folder.id) ?? {
      ...folder,
      deletedAt: now,
      deletedBy: options.userId,
      updatedAt: now,
    };
    deps.logger?.info(
      { folder: folder.id, path, folders: deletedFolders.length, files: deletedFiles.length },
      "folder soft-deleted",
    );
    return {
      result: {
        folder: serializeFolder(self),
        folders: deletedFolders.length,
        files: deletedFiles.length,
      },
      deletedFiles,
    };
  });
  await publishFileEvents(deps, { ...scope, kind: "deleted" }, deletedFiles);
  for (const file of deletedFiles) {
    deps.audit?.emit({
      event_type: "VOLA_FILE_DELETED",
      instance_type: "vola_file",
      instance_id: file.id,
      payload: { ...fileAuditPayload(file), folder_path: path, recursive: options.recursive },
    });
  }
  return result;
}

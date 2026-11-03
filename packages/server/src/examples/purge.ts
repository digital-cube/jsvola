import { and, eq, inArray, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/index.js";
import { files, folders, keyrings } from "../db/schema.js";
import { type FileEventBus, publishFileEvents } from "../events/bus.js";
import { deleteFolder, type FoldersDeps } from "../services/folders.js";
import { type KeyringsDeps, resetKeyring } from "../services/keyrings.js";
import type { StorageBackend } from "../storage/index.js";
import { SEEDER_USER } from "./demo.js";

export interface DemoPurgeDeps {
  db: Database;
  storage: StorageBackend;
  tenantId: string;
  instanceType: string;
  instanceId: string;
  /** Anything a visitor made before `now - ttlMs` goes. */
  ttlMs: number;
  events?: FileEventBus | undefined;
  /** The keyring services' dependencies; `null` when the deployment has no keyring provider. */
  keyrings?: KeyringsDeps | null | undefined;
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
}

export interface DemoPurgeResult {
  /** File rows removed (every version a visitor made, soft-deleted ones included). */
  files: number;
  /** Blobs removed from disk (those no other row cites). */
  blobs: number;
  /** Visitor keyrings crypto-shredded (their files went with them). */
  keyrings: number;
  /** Visitor folders deleted. */
  folders: number;
  /** Things that could not be removed this time (logged; tried again on the next run). */
  failed: number;
}

/**
 * The demo job (plan 8.1): everything a visitor made more than `ttlMs` ago goes, each row by
 * its own `created_at` —
 * their files (`created_by` is not the seeder's; the whole version chain is theirs too, a
 * visitor cannot write to a seeded file), their keyrings (a crypto-shred, exactly as
 * `POST /keyrings/me/reset`), then their folders. The seeder's files are never touched, so
 * the site always has its pack. A removal that fails is logged and counted, never raised.
 */
export async function purgeDemo(deps: DemoPurgeDeps): Promise<DemoPurgeResult> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - deps.ttlMs);
  const result: DemoPurgeResult = { files: 0, blobs: 0, keyrings: 0, folders: 0, failed: 0 };
  const scope = {
    tenantId: deps.tenantId,
    instanceType: deps.instanceType,
    instanceId: deps.instanceId,
  };

  // 1. Visitor keyrings first: their reset removes the keyring files (any instance).
  if (deps.keyrings?.unlocks) {
    const rings = await deps.db
      .select({ id: keyrings.id, principal: keyrings.principal })
      .from(keyrings)
      .where(
        and(
          eq(keyrings.tenantId, deps.tenantId),
          like(keyrings.principal, "demo-%"),
          isNull(keyrings.deletedAt),
          lt(keyrings.createdAt, cutoff),
        ),
      );
    for (const ring of rings) {
      try {
        await resetKeyring(deps.keyrings, { tenantId: deps.tenantId, principal: ring.principal });
        result.keyrings++;
      } catch (error) {
        result.failed++;
        deps.logger?.warn({ err: error, keyring: ring.id }, "demo purge: keyring not reset");
      }
    }
  }

  // 2. Visitor files of the demo instance (plain, tenant-encrypted, soft-deleted alike).
  const rows = await deps.db
    .select({ id: files.id, hash: files.hash, folderId: files.folderId })
    .from(files)
    .where(
      and(
        eq(files.tenantId, scope.tenantId),
        eq(files.instanceType, scope.instanceType),
        eq(files.instanceId, scope.instanceId),
        or(isNull(files.createdBy), ne(files.createdBy, SEEDER_USER)),
        lt(files.createdAt, cutoff),
      ),
    );
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const deleted = await deps.db
      .delete(files)
      .where(inArray(files.id, ids))
      .returning({ id: files.id });
    const gone = new Set(deleted.map((r) => r.id));
    result.files += gone.size;
    await publishFileEvents(
      { events: deps.events, logger: deps.logger },
      { ...scope, kind: "purged" },
      rows.filter((r) => gone.has(r.id)),
    );
    for (const hash of [...new Set(rows.map((r) => r.hash))].sort()) {
      try {
        const removed = await deps.db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${hash}, 0))`);
          const [reference] = await tx
            .select({ id: files.id })
            .from(files)
            .where(eq(files.hash, hash))
            .limit(1);
          return reference ? false : await deps.storage.remove(hash);
        });
        if (removed) result.blobs++;
      } catch (error) {
        result.failed++;
        deps.logger?.error({ err: error, hash }, "demo purge: blob not removed");
      }
    }
  }

  // 3. Visitor folders, deepest first (a parent's delete would take the children anyway).
  const dirs = await deps.db
    .select({ path: folders.path })
    .from(folders)
    .where(
      and(
        eq(folders.tenantId, scope.tenantId),
        eq(folders.instanceType, scope.instanceType),
        eq(folders.instanceId, scope.instanceId),
        like(folders.createdBy, "demo-%"),
        isNull(folders.deletedAt),
        lt(folders.createdAt, cutoff),
      ),
    );
  const folderDeps: FoldersDeps = { db: deps.db, events: deps.events, logger: deps.logger };
  for (const dir of dirs.sort((a, b) => b.path.length - a.path.length)) {
    try {
      await deleteFolder(folderDeps, scope, dir.path, { recursive: true, userId: "examples" });
      result.folders++;
    } catch (error) {
      // Already gone with its parent, or holding a seeded file someone moved: leave it.
      result.failed++;
      deps.logger?.warn({ err: error, path: dir.path }, "demo purge: folder not deleted");
    }
  }

  if (result.files || result.keyrings || result.folders || result.failed) {
    deps.logger?.info(result, "demo purge");
  }
  return result;
}

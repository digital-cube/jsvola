import type { StorageStats, StorageUsage, TenantStats } from "@vola/core";
import { and, count, eq, isNull, lt, max, min, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/index.js";
import { files, type TenantStatsRow, tenantStats } from "../db/schema.js";
import { directoryUsage, type StorageBackend } from "../storage/index.js";
import type { InstanceScope } from "./files.js";

export interface StatsDeps {
  db: Database;
  logger?: FastifyBaseLogger | undefined;
  /**
   * A snapshot older than this is recomputed on read. Set it where no worker refreshes
   * snapshots (`sync` mode); leave it out where the `refresh-stats` job does.
   */
  staleAfterMs?: number | undefined;
  /** Clock, for tests. */
  now?: (() => Date) | undefined;
}

/** What a snapshot covers. */
export type StatsTarget =
  | { tenantId: string; scope: "tenant" }
  | { tenantId: string; scope: "instance"; instanceType: string; instanceId: string };

/** The instance target of a scope. */
export function instanceTarget(scope: InstanceScope): StatsTarget {
  return {
    tenantId: scope.tenantId,
    scope: "instance",
    instanceType: scope.instanceType,
    instanceId: scope.instanceId,
  };
}

const clock = (deps: StatsDeps) => (deps.now ?? (() => new Date()))();

/** The live files of `target`. */
function liveFilesOf(target: StatsTarget) {
  return and(
    eq(files.tenantId, target.tenantId),
    isNull(files.deletedAt),
    target.scope === "instance" ? eq(files.instanceType, target.instanceType) : undefined,
    target.scope === "instance" ? eq(files.instanceId, target.instanceId) : undefined,
  );
}

/** The snapshot row of `target`. */
function snapshotOf(target: StatsTarget) {
  return and(
    eq(tenantStats.tenantId, target.tenantId),
    eq(tenantStats.scope, target.scope),
    target.scope === "instance" ? eq(tenantStats.instanceType, target.instanceType) : undefined,
    target.scope === "instance" ? eq(tenantStats.instanceId, target.instanceId) : undefined,
  );
}

export function serializeStats(row: TenantStatsRow): TenantStats {
  return {
    tenant_id: row.tenantId,
    scope: row.scope as TenantStats["scope"],
    instance_type: row.instanceType,
    instance_id: row.instanceId,
    total_files: Number(row.totalFiles),
    total_bytes: Number(row.totalBytes),
    by_kind: row.byKind,
    oldest_at: row.oldestAt?.toISOString() ?? null,
    newest_at: row.newestAt?.toISOString() ?? null,
    computed_at: row.computedAt.toISOString(),
  };
}

/**
 * Recomputes the snapshot of `target` from scratch — two aggregate queries over the live
 * files (never an incremental delta, so concurrent uploads and deletes cannot drift it) —
 * and upserts the row. Returns the fresh row.
 */
export async function computeStats(deps: StatsDeps, target: StatsTarget): Promise<TenantStatsRow> {
  const where = liveFilesOf(target);
  const [totals] = await deps.db
    .select({
      files: count(),
      bytes: sql<string>`coalesce(sum(${files.size}), 0)`,
      oldest: min(files.createdAt),
      newest: max(files.createdAt),
    })
    .from(files)
    .where(where);
  const kinds = await deps.db
    .select({ kind: files.kind, files: count() })
    .from(files)
    .where(where)
    .groupBy(files.kind)
    .orderBy(files.kind);
  const byKind: Record<string, number> = {};
  for (const row of kinds) byKind[row.kind] = Number(row.files);
  const values = {
    totalFiles: Number(totals?.files ?? 0),
    totalBytes: Number(totals?.bytes ?? 0),
    byKind,
    oldestAt: totals?.oldest ?? null,
    newestAt: totals?.newest ?? null,
    computedAt: clock(deps),
  };
  const [row] = await deps.db
    .insert(tenantStats)
    .values({
      tenantId: target.tenantId,
      scope: target.scope,
      instanceType: target.scope === "instance" ? target.instanceType : null,
      instanceId: target.scope === "instance" ? target.instanceId : null,
      ...values,
    })
    .onConflictDoUpdate(
      target.scope === "tenant"
        ? {
            target: [tenantStats.tenantId],
            targetWhere: sql`${tenantStats.scope} = 'tenant'`,
            set: values,
          }
        : {
            target: [tenantStats.tenantId, tenantStats.instanceType, tenantStats.instanceId],
            targetWhere: sql`${tenantStats.scope} = 'instance'`,
            set: values,
          },
    )
    .returning();
  if (!row) throw new Error("stats upsert returned no row");
  deps.logger?.debug(
    {
      tenant: target.tenantId,
      scope: target.scope === "instance" ? `${target.instanceType}/${target.instanceId}` : "tenant",
      files: row.totalFiles,
      bytes: row.totalBytes,
    },
    "stats computed",
  );
  return row;
}

/** The stored snapshot of `target`, or `null` when none was computed yet. */
export async function readStats(
  deps: StatsDeps,
  target: StatsTarget,
): Promise<TenantStatsRow | null> {
  const [row] = await deps.db.select().from(tenantStats).where(snapshotOf(target)).limit(1);
  return row ?? null;
}

/**
 * The snapshot of `target`: the stored one, computed now when there is none, when
 * `recompute` asks for it, or when it is older than `deps.staleAfterMs`.
 */
export async function getStats(
  deps: StatsDeps,
  target: StatsTarget,
  options: { recompute?: boolean | undefined } = {},
): Promise<TenantStats> {
  if (!options.recompute) {
    const stored = await readStats(deps, target);
    if (stored) {
      const stale =
        deps.staleAfterMs !== undefined &&
        clock(deps).getTime() - stored.computedAt.getTime() > deps.staleAfterMs;
      if (!stale) return serializeStats(stored);
    }
  }
  return serializeStats(await computeStats(deps, target));
}

export interface RefreshResult {
  /** Snapshots older than the TTL. */
  stale: number;
  /** Of those, recomputed because their tenant had file activity since. */
  refreshed: number;
}

/**
 * The worker's `refresh-stats` job: every snapshot older than `ttlMs` whose tenant had
 * activity since it was computed — a file created, changed, soft-deleted (all touch
 * `updated_at`) — is recomputed; an idle tenant's snapshot is left alone (it is still
 * right). Snapshots are refreshed one by one; a failure is logged and the next one follows.
 */
export async function refreshStaleStats(
  deps: StatsDeps,
  options: { ttlMs: number },
): Promise<RefreshResult> {
  const now = clock(deps);
  const cutoff = new Date(now.getTime() - options.ttlMs);
  const stale = await deps.db
    .select()
    .from(tenantStats)
    .where(lt(tenantStats.computedAt, cutoff))
    .orderBy(tenantStats.computedAt);
  let refreshed = 0;
  for (const row of stale) {
    const target: StatsTarget =
      row.scope === "instance"
        ? {
            tenantId: row.tenantId,
            scope: "instance",
            instanceType: row.instanceType as string,
            instanceId: row.instanceId as string,
          }
        : { tenantId: row.tenantId, scope: "tenant" };
    try {
      const [activity] = await deps.db
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            eq(files.tenantId, row.tenantId),
            sql`${files.updatedAt} > ${row.computedAt}`,
            target.scope === "instance" ? eq(files.instanceType, target.instanceType) : undefined,
            target.scope === "instance" ? eq(files.instanceId, target.instanceId) : undefined,
          ),
        )
        .limit(1);
      if (!activity) continue;
      await computeStats(deps, target);
      refreshed++;
    } catch (error) {
      deps.logger?.error({ err: error, snapshot: row.id }, "stats snapshot not refreshed");
    }
  }
  if (stale.length > 0) {
    deps.logger?.info({ stale: stale.length, refreshed }, "stale stats snapshots checked");
  }
  return { stale: stale.length, refreshed };
}

// --- storage -----------------------------------------------------------------------------

export interface StorageStatsInput {
  /** The tenant to measure; `null`: every tenant (an admin key without `X-Tenant-Slug`). */
  tenantId: string | null;
  /** Walk the disk too (admin keys only). */
  physical: boolean;
}

export interface StorageStatsDeps extends StatsDeps {
  storage: StorageBackend;
  /** The directory of resumable-upload part files (`uploads`). */
  uploadsPath: string;
}

/**
 * Logical bytes (the sum of the live files' sizes), distinct blobs they point at and the
 * bytes of those — for one tenant or across every tenant — plus, on request, what the
 * storage directory physically holds (`blobs`, `derived`, `uploads`).
 */
export async function storageStats(
  deps: StorageStatsDeps,
  input: StorageStatsInput,
): Promise<StorageStats> {
  const live = and(
    isNull(files.deletedAt),
    input.tenantId ? eq(files.tenantId, input.tenantId) : undefined,
  );
  const [totals] = await deps.db
    .select({
      files: count(),
      logical: sql<string>`coalesce(sum(${files.size}), 0)`,
      blobs: sql<string>`count(distinct ${files.hash})`,
    })
    .from(files)
    .where(live);
  // Every distinct blob once, with its size (the same hash always has the same size).
  const distinct = deps.db
    .selectDistinct({ hash: files.hash, size: files.size })
    .from(files)
    .where(live)
    .as("distinct_blobs");
  const [unique] = await deps.db
    .select({ bytes: sql<string>`coalesce(sum(${distinct.size}), 0)` })
    .from(distinct);
  let physical: StorageUsage | null = null;
  if (input.physical) {
    const [store, uploads] = await Promise.all([
      deps.storage.usage(),
      directoryUsage(deps.uploadsPath),
    ]);
    physical = { blobs: store.blobs, derived: store.derived, uploads };
  }
  return {
    scope: input.tenantId ? "tenant" : "deployment",
    tenant_id: input.tenantId,
    files: Number(totals?.files ?? 0),
    logical_bytes: Number(totals?.logical ?? 0),
    unique_blobs: Number(totals?.blobs ?? 0),
    unique_bytes: Number(unique?.bytes ?? 0),
    physical,
    computed_at: clock(deps).toISOString(),
  };
}

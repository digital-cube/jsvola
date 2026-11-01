import { RECOMPUTE_QUERY, type StorageStats, type TenantStats } from "@vola/core";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import { hasTenant, requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import { parseInstance } from "../services/files.js";
import {
  getStats,
  instanceTarget,
  type StatsDeps,
  type StorageStatsDeps,
  storageStats,
} from "../services/stats.js";
import type { StorageBackend } from "../storage/index.js";
import { flag } from "./send-file.js";

export interface StatsRoutesDeps {
  db: Database;
  storage: StorageBackend;
  /** The directory of resumable-upload part files, measured as `physical.uploads`. */
  uploadsPath: string;
  /** Recompute a snapshot older than this on read (set it where no worker refreshes them). */
  staleAfterMs?: number | undefined;
  logger?: FastifyBaseLogger | undefined;
  now?: (() => Date) | undefined;
}

const READ = { scope: "files:read" } as const;

interface RecomputeQuery {
  [RECOMPUTE_QUERY]?: string;
}
interface InstanceParams {
  type: string;
  id: string;
}

/**
 * Statistics (scope `files:read`):
 *
 * - `GET /stats/tenant[?recompute=1]` — the tenant's live files: count, bytes, per kind,
 *   oldest and newest; the snapshot is computed on the first read, `recompute=1` forces it;
 * - `GET /stats/instance/:type/:id[?recompute=1]` — the same for one instance;
 * - `GET /stats/storage` — the tenant's logical bytes and distinct blobs; an admin key
 *   also gets `physical` (the disk: `blobs`, `derived`, `uploads`), and without
 *   `X-Tenant-Slug` the numbers of the whole deployment.
 */
export const statsRoutes: FastifyPluginAsync<StatsRoutesDeps> = async (app, deps) => {
  const service: StatsDeps = {
    db: deps.db,
    logger: deps.logger ?? app.log,
    staleAfterMs: deps.staleAfterMs,
    now: deps.now,
  };
  const storage: StorageStatsDeps = {
    ...service,
    storage: deps.storage,
    uploadsPath: deps.uploadsPath,
  };

  app.get<{ Querystring: RecomputeQuery }>(
    "/stats/tenant",
    { config: READ },
    async (request): Promise<TenantStats> =>
      getStats(
        service,
        { tenantId: requireTenant().tenantId, scope: "tenant" },
        { recompute: flag(request.query[RECOMPUTE_QUERY]) },
      ),
  );

  app.get<{ Params: InstanceParams; Querystring: RecomputeQuery }>(
    "/stats/instance/:type/:id",
    { config: READ },
    async (request): Promise<TenantStats> =>
      getStats(
        service,
        instanceTarget(
          parseInstance(requireTenant().tenantId, request.params.type, request.params.id),
        ),
        { recompute: flag(request.query[RECOMPUTE_QUERY]) },
      ),
  );

  app.get(
    "/stats/storage",
    { config: { ...READ, tenant: "optional" } },
    async (request): Promise<StorageStats> => {
      const context = request.vola;
      if (!context) throw new Error("stats/storage without an authenticated context");
      return storageStats(storage, {
        tenantId: hasTenant(context) ? context.tenantId : null,
        physical: context.isAdmin,
      });
    },
  );
};

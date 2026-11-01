import { z } from "zod";
import { TimestampSchema } from "./apikey.js";
import { InstanceTypeSchema } from "./files.js";

/** What a statistics snapshot covers: the whole tenant, or one instance of it. */
export const STATS_SCOPES = ["tenant", "instance"] as const;
export const StatsScopeSchema = z.enum(STATS_SCOPES);
export type StatsScope = z.infer<typeof StatsScopeSchema>;

/** `?recompute=1` on `GET /stats/tenant` and `GET /stats/instance/:type/:id`. */
export const RECOMPUTE_QUERY = "recompute";

/** Minutes a snapshot may age before the worker's `refresh-stats` job recomputes it (`VOLA_STATS_TTL_MIN`). */
export const DEFAULT_STATS_TTL_MIN = 60;

/**
 * `GET /stats/tenant`, `GET /stats/instance/:type/:id`: the live files of the scope — never
 * the soft-deleted ones — as of `computed_at`. `total_bytes` is the sum of the files' sizes
 * (what the tenant stored, before deduplication).
 */
export const TenantStatsSchema = z.object({
  tenant_id: z.uuid(),
  scope: StatsScopeSchema,
  instance_type: InstanceTypeSchema.nullable(),
  instance_id: z.uuid().nullable(),
  total_files: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  /** Live files per `kind` (`{"image": 12, "document": 5}`); a kind with none is absent. */
  by_kind: z.record(z.string(), z.number().int().nonnegative()),
  oldest_at: TimestampSchema.nullable(),
  newest_at: TimestampSchema.nullable(),
  computed_at: TimestampSchema,
});
export type TenantStats = z.infer<typeof TenantStatsSchema>;

/** Bytes and entries of one area of the storage directory. */
export const StorageAreaUsageSchema = z.object({
  bytes: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});
export type StorageAreaUsage = z.infer<typeof StorageAreaUsageSchema>;

/** What is physically on the disk: the blobs, their derived files (thumbnails), the resumable uploads in flight. */
export const StorageUsageSchema = z.object({
  blobs: StorageAreaUsageSchema,
  derived: StorageAreaUsageSchema,
  uploads: StorageAreaUsageSchema,
});
export type StorageUsage = z.infer<typeof StorageUsageSchema>;

/**
 * `GET /stats/storage`. For a tenant key (or an admin key with `X-Tenant-Slug`): the tenant's
 * logical bytes and distinct blobs. For an admin key without a tenant: the same across every
 * tenant. `physical` — what the storage directory holds — only for an admin key.
 */
export const StorageStatsSchema = z.object({
  /** `tenant`: one tenant; `deployment`: every tenant (admin without `X-Tenant-Slug`). */
  scope: z.enum(["tenant", "deployment"]),
  tenant_id: z.uuid().nullable(),
  /** Live file rows. */
  files: z.number().int().nonnegative(),
  /** Sum of the sizes of the live files: what was stored, before deduplication. */
  logical_bytes: z.number().int().nonnegative(),
  /** Distinct blobs the live files point at. */
  unique_blobs: z.number().int().nonnegative(),
  /** Sum of the sizes of those distinct blobs: what the live files occupy after deduplication. */
  unique_bytes: z.number().int().nonnegative(),
  /** The disk, as the server sees it; `null` for a tenant key. */
  physical: StorageUsageSchema.nullable(),
  computed_at: TimestampSchema,
});
export type StorageStats = z.infer<typeof StorageStatsSchema>;

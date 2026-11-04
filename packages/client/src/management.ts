import {
  type ApiKey,
  type ApiKeyCreate,
  type ApiKeyCreated,
  ApiKeyCreatedSchema,
  type ApiKeyList,
  ApiKeyListSchema,
  ApiKeySchema,
  RECOMPUTE_QUERY,
  type StorageStats,
  StorageStatsSchema,
  type TenantStats,
  TenantStatsSchema,
  type TransferResult,
  TransferResultSchema,
} from "@vol-a/core";
import type { CallOptions, VolaClient } from "./client.js";

export interface StatsOptions extends CallOptions {
  /** Recompute the snapshot now instead of reading the cached one. */
  recompute?: boolean | undefined;
}

/** `POST /admin/transfer` as a caller writes it (`user_map` and `dry_run` optional). */
export interface TransferInput {
  from_tenant: string;
  to_tenant: string;
  instances: { instance_type: string; instance_id: string }[];
  user_map?: Record<string, string> | undefined;
  dry_run?: boolean | undefined;
}

/** Statistics (scope `files:read`). */
export class StatsApi {
  constructor(private readonly client: VolaClient) {}

  /** `GET /stats/tenant[?recompute=1]`: the tenant's live files — count, bytes, per kind, oldest, newest. */
  tenant(options: StatsOptions = {}): Promise<TenantStats> {
    return this.client.json("/stats/tenant", TenantStatsSchema, {
      query: { [RECOMPUTE_QUERY]: options.recompute },
      signal: options.signal,
    });
  }

  /** `GET /stats/instance/:type/:id[?recompute=1]`: the same for one instance. */
  instance(type: string, id: string, options: StatsOptions = {}): Promise<TenantStats> {
    return this.client.json(
      `/stats/instance/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
      TenantStatsSchema,
      { query: { [RECOMPUTE_QUERY]: options.recompute }, signal: options.signal },
    );
  }

  /** `GET /stats/storage`: logical bytes and distinct blobs; an admin key also gets `physical` (and, without a tenant, the whole deployment). */
  storage(options: CallOptions = {}): Promise<StorageStats> {
    return this.client.json("/stats/storage", StorageStatsSchema, options);
  }
}

/** API keys of the tenant (scope `keys:write`). */
export class KeysApi {
  constructor(private readonly client: VolaClient) {}

  /** `POST /keys {name, scopes, env, expires_at?}` → `201`: the key with its plaintext, this once. */
  create(body: ApiKeyCreate, options: CallOptions = {}): Promise<ApiKeyCreated> {
    return this.client.json("/keys", ApiKeyCreatedSchema, {
      method: "POST",
      json: body,
      ...options,
    });
  }

  /** `GET /keys`: the tenant's keys, newest first, never the hash. */
  list(options: CallOptions = {}): Promise<ApiKeyList> {
    return this.client.json("/keys", ApiKeyListSchema, options);
  }

  /** `DELETE /keys/:id`: revoke (idempotent). */
  revoke(id: string, options: CallOptions = {}): Promise<ApiKey> {
    return this.client.json(`/keys/${encodeURIComponent(id)}`, ApiKeySchema, {
      method: "DELETE",
      ...options,
    });
  }
}

/** Cross-tenant administration (an admin key, scope `admin`). */
export class AdminApi {
  constructor(private readonly client: VolaClient) {}

  /** `POST /admin/transfer`: move the files of instances from one tenant to another (`dry_run` counts only). */
  transfer(body: TransferInput, options: CallOptions = {}): Promise<TransferResult> {
    return this.client.json("/admin/transfer", TransferResultSchema, {
      method: "POST",
      json: body,
      ...options,
    });
  }
}

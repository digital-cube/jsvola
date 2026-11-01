import {
  type ApiKey,
  displayApiKey,
  type KeyEnv,
  parseApiKey,
  parseScopes,
  type Scope,
} from "@vola/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import { generateApiKey, hashApiKey, sameHash } from "../apikey.js";
import type { Database } from "../db/index.js";
import { type ApiKeyRow, apiKeys, type TenantRow, tenants } from "../db/schema.js";
import { VolaError } from "../errors.js";

export function serializeApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    name: row.name,
    prefix: row.prefix as ApiKey["prefix"],
    last4: row.last4,
    scopes: row.scopes as Scope[],
    is_admin: row.isAdmin,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    created_by: row.createdBy ?? null,
  };
}

export interface CreateApiKeyInput {
  /** The owning tenant; `null` mints an admin key (`env` must be `admin`). */
  tenantId: string | null;
  name: string;
  env: KeyEnv;
  /** Scopes, as a list or `a,b,c`. Admin keys get `["admin"]`; tenant keys may not hold it. */
  scopes: string | readonly string[];
  expiresAt?: Date | null | undefined;
  createdBy?: string | null | undefined;
}

export interface CreatedApiKey {
  apiKey: ApiKey;
  /** The plaintext, returned exactly once. */
  key: string;
}

/** Creates a key. Only the hash is stored; the plaintext comes back once. */
export async function createApiKey(db: Database, input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const name = input.name.trim();
  if (!name || name.length > 200) {
    throw new VolaError("validation_error", 422, "name: 1–200 characters");
  }
  const isAdmin = input.tenantId === null;
  if (isAdmin !== (input.env === "admin")) {
    throw new VolaError(
      "validation_error",
      422,
      isAdmin ? "an admin key needs env admin" : "a tenant key needs env live or test",
    );
  }
  let scopes: Scope[];
  try {
    scopes = isAdmin ? ["admin"] : parseScopes(input.scopes);
  } catch (error) {
    throw new VolaError("validation_error", 422, `scopes: ${(error as Error).message}`);
  }
  if (!isAdmin && scopes.includes("admin")) {
    throw new VolaError("validation_error", 422, "scopes: a tenant key cannot hold admin");
  }
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new VolaError("validation_error", 422, "expires_at: must be in the future");
  }
  const generated = generateApiKey(input.env);
  const [row] = await db
    .insert(apiKeys)
    .values({
      tenantId: input.tenantId,
      name,
      keyHash: generated.keyHash,
      prefix: generated.prefix,
      last4: generated.last4,
      scopes,
      isAdmin,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return { apiKey: serializeApiKey(row as ApiKeyRow), key: generated.key };
}

/** What a key event says about its key: ids, name, prefix and last four, scopes, dates — never the plaintext, never the hash. */
export function keyAuditPayload(key: ApiKey): Record<string, unknown> {
  return {
    key_id: key.id,
    name: key.name,
    prefix: key.prefix,
    last4: key.last4,
    scopes: key.scopes,
    is_admin: key.is_admin,
    expires_at: key.expires_at,
    created_at: key.created_at,
    revoked_at: key.revoked_at,
    created_by: key.created_by,
  };
}

export interface ListApiKeysFilter {
  /** Only this tenant's keys; `null` only admin keys; absent: every key. */
  tenantId?: string | null;
}

/** Keys, newest first, never the hash. */
export async function listApiKeys(db: Database, filter: ListApiKeysFilter = {}): Promise<ApiKey[]> {
  const where =
    filter.tenantId === undefined
      ? undefined
      : filter.tenantId === null
        ? isNull(apiKeys.tenantId)
        : eq(apiKeys.tenantId, filter.tenantId);
  const rows = await db
    .select()
    .from(apiKeys)
    .where(where)
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  return rows.map(serializeApiKey);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPLAY_RE = /^(vola_(?:live|test|admin))(?:…|\.\.\.)([A-Za-z0-9]{4})$/;

/**
 * Finds a key by id or by its display form `vola_live…k3Qz` (also `vola_live...k3Qz`).
 * Throws `not_found` when nothing matches and `conflict` when the display form is ambiguous.
 */
export async function findApiKey(db: Database, idOrDisplay: string): Promise<ApiKeyRow> {
  const reference = idOrDisplay.trim();
  let rows: ApiKeyRow[] = [];
  if (UUID_RE.test(reference)) {
    rows = await db.select().from(apiKeys).where(eq(apiKeys.id, reference)).limit(1);
  } else {
    const match = DISPLAY_RE.exec(reference);
    if (!match) {
      throw new VolaError(
        "validation_error",
        422,
        `"${reference}" is neither a key id nor a display form like vola_live…k3Qz`,
      );
    }
    rows = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.prefix, match[1] as string), eq(apiKeys.last4, match[2] as string)));
    if (rows.length > 1) {
      throw new VolaError(
        "conflict",
        409,
        `${rows.length} keys match ${reference}; use the id (vola list-keys)`,
      );
    }
  }
  const row = rows[0];
  if (!row) throw new VolaError("not_found", 404, `key ${reference} not found`);
  return row;
}

export interface RevokeApiKeyOptions {
  /** Only a key of this tenant may be revoked; another tenant's key is `not_found`. */
  tenantId?: string | undefined;
  now?: Date | undefined;
}

/**
 * Soft-revokes a key (`revoked_at`); revoked keys fail authentication from then on.
 * Idempotent: an already revoked key is returned as it is.
 */
export async function revokeApiKey(
  db: Database,
  id: string,
  options: RevokeApiKeyOptions = {},
): Promise<ApiKey> {
  const notFound = () => new VolaError("not_found", 404, `key ${id} not found`);
  if (!UUID_RE.test(id)) throw notFound();
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  if (!row || (options.tenantId !== undefined && row.tenantId !== options.tenantId)) {
    throw notFound();
  }
  if (row.revokedAt) return serializeApiKey(row);
  const [updated] = await db
    .update(apiKeys)
    .set({ revokedAt: options.now ?? new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning();
  return serializeApiKey(updated ?? { ...row, revokedAt: options.now ?? new Date() });
}

/** The key and its tenant (`null` for an admin key) a plaintext resolves to; `null` when it must be refused. */
export interface AuthenticatedKey {
  key: ApiKeyRow;
  tenant: TenantRow | null;
}

/**
 * Resolves a plaintext key: malformed, unknown, revoked, expired, or a tenant key whose tenant
 * is missing or inactive → `null`. The caller answers every `null` the same way.
 */
export async function authenticateApiKey(
  db: Database,
  plaintext: string,
  now: Date = new Date(),
): Promise<AuthenticatedKey | null> {
  if (!parseApiKey(plaintext)) return null;
  const hash = hashApiKey(plaintext);
  const [found] = await db
    .select({ key: apiKeys, tenant: tenants })
    .from(apiKeys)
    .leftJoin(tenants, eq(apiKeys.tenantId, tenants.id))
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);
  if (!found || !sameHash(found.key.keyHash, hash)) return null;
  if (found.key.revokedAt) return null;
  if (found.key.expiresAt && found.key.expiresAt.getTime() <= now.getTime()) return null;
  if (!found.key.isAdmin && !found.tenant?.isActive) return null;
  return { key: found.key, tenant: found.tenant };
}

/** Interval between two `last_used_at` writes of one key. */
export const LAST_USED_INTERVAL_MS = 60_000;

/**
 * Remembers when each key's `last_used_at` was last written, so the column is updated at
 * most once a minute per key (process-local; a request on another instance may write too).
 */
export class LastUsedThrottle {
  private readonly written = new Map<string, number>();

  constructor(
    private readonly intervalMs = LAST_USED_INTERVAL_MS,
    private readonly maxEntries = 10_000,
  ) {}

  /** `true` when `keyId` is due for a write at `now` (and records that write). */
  shouldWrite(keyId: string, now: number = Date.now()): boolean {
    const last = this.written.get(keyId);
    if (last !== undefined && now - last < this.intervalMs) return false;
    if (this.written.size >= this.maxEntries) this.prune(now);
    this.written.set(keyId, now);
    return true;
  }

  private prune(now: number): void {
    for (const [keyId, at] of this.written) {
      if (now - at >= this.intervalMs) this.written.delete(keyId);
    }
    if (this.written.size >= this.maxEntries) this.written.clear();
  }
}

/** Writes `last_used_at = now` for `keyId`; best effort, a failure is swallowed. */
export async function touchLastUsed(db: Database, keyId: string, now: Date): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, keyId))
    .catch(() => undefined);
}

/** `vola_live…k3Qz` of a stored key. */
export function displayKey(key: Pick<ApiKey, "prefix" | "last4"> | ApiKeyRow): string {
  return displayApiKey(key.prefix, key.last4);
}

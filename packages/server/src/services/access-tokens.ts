import { createHash } from "node:crypto";
import {
  ACCESS_TOKEN_ENCRYPTION_UNSUPPORTED_CODE,
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_READABLE_ENCRYPTIONS,
  ACCESS_TOKEN_SECRET_LENGTH,
  type AccessTokenCreate,
  type AccessTokenCreated,
  DEFAULT_ACCESS_TOKEN_MAX_TTL_S,
  DEFAULT_ACCESS_TOKEN_TTL_S,
  displayApiKey,
  isAccessToken,
} from "@vol-a/core";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { randomBase62, sameHash } from "../apikey.js";
import type { AccessGrant, TenantContext } from "../context.js";
import type { Database } from "../db/index.js";
import {
  type AccessTokenRow,
  accessTokens,
  apiKeys,
  type FileRow,
  files,
  tenants,
} from "../db/schema.js";
import { uuidv7 } from "../db/uuid.js";
import { VolaError } from "../errors.js";
import { fileNotFound, type InstanceScope } from "./files.js";

export type { AccessGrant } from "../context.js";

export interface AccessTokensDeps {
  db: Database;
  /** `VOLA_ACCESS_TOKEN_MAX_TTL_S`: the longest `expires_in` a caller may ask for. */
  maxTtlS?: number | undefined;
  now?: (() => Date) | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SHA-256 of a token, lowercase hex: what the database stores. */
export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A fresh `vola_at_<40 base62>` and its hash. */
export function generateAccessToken(): { token: string; tokenHash: string } {
  const token = `${ACCESS_TOKEN_PREFIX}${randomBase62(ACCESS_TOKEN_SECRET_LENGTH)}`;
  return { token, tokenHash: hashAccessToken(token) };
}

function accessTokenNotFound(): VolaError {
  return new VolaError("access_token_not_found", 404, "access token not found");
}

export interface IssueAccessTokenInput {
  tenantId: string;
  apiKeyId: string;
  body: AccessTokenCreate;
}

/**
 * Issues a token for `body.file_ids` (every one a live row of the tenant, else `404
 * file_not_found` for the whole request) or `body.instance`. `expires_in` above the
 * configured maximum is `422`. The tenant's expired tokens are deleted first — the lazy
 * cleanup that keeps the table at about (issue rate × maximum TTL) rows without a worker.
 */
export async function issueAccessToken(
  deps: AccessTokensDeps,
  input: IssueAccessTokenInput,
): Promise<AccessTokenCreated> {
  const { body } = input;
  const now = (deps.now ?? (() => new Date()))();
  const maxTtlS = deps.maxTtlS ?? DEFAULT_ACCESS_TOKEN_MAX_TTL_S;
  const ttlS = body.expires_in ?? Math.min(DEFAULT_ACCESS_TOKEN_TTL_S, maxTtlS);
  if (ttlS > maxTtlS) {
    throw new VolaError(
      "validation_error",
      422,
      `expires_in: at most ${maxTtlS} seconds (VOLA_ACCESS_TOKEN_MAX_TTL_S)`,
    );
  }
  let fileIds: string[] | null = null;
  if (body.file_ids) {
    fileIds = [...new Set(body.file_ids.map((id) => id.toLowerCase()))];
    const found = await deps.db
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          eq(files.tenantId, input.tenantId),
          inArray(files.id, fileIds),
          isNull(files.deletedAt),
        ),
      );
    if (found.length !== fileIds.length) throw fileNotFound();
  }
  await pruneExpiredAccessTokens(deps.db, input.tenantId, now);
  const { token, tokenHash } = generateAccessToken();
  const expiresAt = new Date(now.getTime() + ttlS * 1000);
  const id = uuidv7();
  await deps.db.insert(accessTokens).values({
    id,
    tenantId: input.tenantId,
    apiKeyId: input.apiKeyId,
    tokenHash,
    principal: body.principal,
    fileIds,
    instanceType: body.instance?.instance_type ?? null,
    instanceId: body.instance?.instance_id.toLowerCase() ?? null,
    expiresAt,
    createdAt: now,
  });
  return { id, token, expires_at: expiresAt.toISOString() };
}

/** Deletes the tenant's tokens that expired before `now`; returns how many. */
export async function pruneExpiredAccessTokens(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<number> {
  const deleted = await db
    .delete(accessTokens)
    .where(and(eq(accessTokens.tenantId, tenantId), lt(accessTokens.expiresAt, now)))
    .returning({ id: accessTokens.id });
  return deleted.length;
}

/**
 * Revokes the tenant's token `id` (`revoked_at`); idempotent — a revoked token stays
 * revoked and the call answers the same. Another tenant's token, an unknown id and a token
 * already pruned after its expiry are `404 access_token_not_found`.
 */
export async function revokeAccessToken(
  deps: AccessTokensDeps,
  tenantId: string,
  id: string,
): Promise<void> {
  if (!UUID_RE.test(id)) throw accessTokenNotFound();
  const now = (deps.now ?? (() => new Date()))();
  const [row] = await deps.db
    .select({ id: accessTokens.id, revokedAt: accessTokens.revokedAt })
    .from(accessTokens)
    .where(and(eq(accessTokens.id, id.toLowerCase()), eq(accessTokens.tenantId, tenantId)))
    .limit(1);
  if (!row) throw accessTokenNotFound();
  if (row.revokedAt) return;
  await deps.db
    .update(accessTokens)
    .set({ revokedAt: now })
    .where(and(eq(accessTokens.id, row.id), isNull(accessTokens.revokedAt)));
}

/** The grant of a stored row. */
export function grantOf(row: AccessTokenRow): AccessGrant {
  return {
    id: row.id,
    fileIds: row.fileIds,
    instance:
      row.instanceType && row.instanceId
        ? { instanceType: row.instanceType, instanceId: row.instanceId }
        : null,
  };
}

/**
 * The context of a request that carries access token `plaintext`, or `null` when the token
 * is malformed, unknown, expired or revoked — or its tenant inactive, or the key that issued
 * it revoked or expired. The context reads (`files:read`) and nothing else: the routes that
 * accept a token say so (`config.accessToken`), and the grant on it narrows what they find.
 * `X-User-Id`, `X-Tenant-Slug`, `X-Vola-Unlock` and `X-Vola-Content-Key` are not read.
 */
export async function authenticateAccessToken(
  db: Database,
  plaintext: string,
  now: Date,
  browserOrigin: string | null,
): Promise<TenantContext | null> {
  if (!isAccessToken(plaintext)) return null;
  const hash = hashAccessToken(plaintext);
  const [found] = await db
    .select({ token: accessTokens, tenant: tenants, key: apiKeys })
    .from(accessTokens)
    .innerJoin(tenants, eq(accessTokens.tenantId, tenants.id))
    .innerJoin(apiKeys, eq(accessTokens.apiKeyId, apiKeys.id))
    .where(eq(accessTokens.tokenHash, hash))
    .limit(1);
  if (!found || !sameHash(found.token.tokenHash, hash)) return null;
  const at = now.getTime();
  if (found.token.revokedAt || found.token.expiresAt.getTime() <= at) return null;
  if (!found.tenant.isActive) return null;
  if (found.key.revokedAt || (found.key.expiresAt && found.key.expiresAt.getTime() <= at)) {
    return null;
  }
  return {
    tenantId: found.tenant.id,
    tenantSlug: found.tenant.slug,
    apiKeyId: found.key.id,
    apiKeyLabel: displayApiKey(found.key.prefix, found.key.last4),
    scopes: ["files:read"],
    isAdmin: false,
    userId: found.token.principal,
    unlockToken: null,
    contentKey: null,
    browserOrigin,
    accessToken: grantOf(found.token),
  };
}

/** `true` when `grant` covers file `fileId` of `scope`'s instance. */
export function grantCovers(grant: AccessGrant, scope: InstanceScope, fileId: string): boolean {
  if (grant.fileIds) return grant.fileIds.includes(fileId.toLowerCase());
  return (
    grant.instance !== null &&
    grant.instance.instanceType === scope.instanceType &&
    grant.instance.instanceId === scope.instanceId
  );
}

/**
 * `409 access_token_encryption_unsupported` for a `keyring`, `caller` or `client` row read
 * with a token: it carries no unlock and no content key, and this version serves only `none`
 * and `tenant` files through one.
 */
export function assertTokenReadable(row: FileRow): void {
  if ((ACCESS_TOKEN_READABLE_ENCRYPTIONS as readonly string[]).includes(row.encryption)) return;
  throw new VolaError(
    ACCESS_TOKEN_ENCRYPTION_UNSUPPORTED_CODE,
    409,
    `a ${row.encryption}-encrypted file cannot be read with an access token in this version: use an API key`,
  );
}

/**
 * The row a token request may read: covered by the grant (else `404`, before any query), the
 * tenant's own (never another tenant's `is_public` file), live, and of a readable encryption.
 */
export async function findGrantedFile(
  db: Database,
  grant: AccessGrant,
  scope: InstanceScope,
  fileId: string,
): Promise<FileRow> {
  if (!UUID_RE.test(fileId) || !grantCovers(grant, scope, fileId)) throw fileNotFound();
  const [row] = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.tenantId, scope.tenantId),
        eq(files.instanceType, scope.instanceType),
        eq(files.instanceId, scope.instanceId),
        eq(files.id, fileId.toLowerCase()),
        isNull(files.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw fileNotFound();
  assertTokenReadable(row);
  return row;
}

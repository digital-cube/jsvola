import { parseApiKey, type Scope } from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { hashApiKey } from "../apikey.js";
import type { ExamplesConfig } from "../config.js";
import type { Database } from "../db/index.js";
import { apiKeys, tenants } from "../db/schema.js";
import { authenticateApiKey } from "../services/apikeys.js";
import { createTenant, findTenantBySlug } from "../services/tenants.js";

/** The `X-User-Id` the seeder uploads the demo pack with; its files are never purged and never written to. */
export const SEEDER_USER = "seeder";

/** The scopes the visitor's key may hold, and holds when the server mints it. */
export const DEMO_READ_SCOPES: readonly Scope[] = ["files:read", "folders:read"];

/** The scopes the server-side write key needs (and gets when the server mints it). */
export const DEMO_WRITE_SCOPES: readonly Scope[] = [
  "files:read",
  "files:write",
  "folders:read",
  "folders:write",
  "shares:write",
  "keyrings:write",
];

/** Why the server refuses to start with the demo keys it was given. */
export class DemoSetupError extends Error {
  constructor(message: string) {
    super(`examples: ${message}`);
    this.name = "DemoSetupError";
  }
}

export interface DemoTenant {
  tenantId: string;
  tenantSlug: string;
}

/**
 * Brings the demo tenant and its two keys into being, once per start, so a stage `.env`
 * with two freshly generated keys (`vola demo-keys`) is a complete deployment:
 *
 * - the tenant `config.tenant` is created when missing;
 * - each key that is unknown is stored (by hash, as `POST /keys` would) with its scopes —
 *   `DEMO_READ_SCOPES` for the visitor's key, `DEMO_WRITE_SCOPES` for the write key;
 * - a key that exists is checked: the visitor's key may hold nothing beyond
 *   `DEMO_READ_SCOPES` (it is published to everyone), the write key must hold every one of
 *   `DEMO_WRITE_SCOPES`, both must belong to the demo tenant and be usable. Anything else is a
 *   `DemoSetupError` and the server does not start.
 */
export async function ensureDemoTenant(
  db: Database,
  config: ExamplesConfig,
  log?: FastifyBaseLogger,
): Promise<DemoTenant> {
  let tenant = await findTenantBySlug(db, config.tenant);
  if (!tenant) {
    await createTenant(db, { slug: config.tenant, name: "Demo" }).catch(() => undefined);
    tenant = await findTenantBySlug(db, config.tenant);
    if (!tenant) throw new DemoSetupError(`the tenant "${config.tenant}" could not be created`);
    log?.info({ tenant: tenant.slug }, "examples: demo tenant created");
  }
  if (!tenant.isActive) throw new DemoSetupError(`the tenant "${config.tenant}" is inactive`);

  await ensureKey(db, tenant.id, config.apiKey, "examples-visitor (read-only)", DEMO_READ_SCOPES, {
    exact: true,
    label: "VOLA_DEMO_API_KEY",
    log,
  });
  await ensureKey(db, tenant.id, config.writeKey, "examples-writer", DEMO_WRITE_SCOPES, {
    exact: false,
    label: "VOLA_DEMO_WRITE_KEY",
    log,
  });
  return { tenantId: tenant.id, tenantSlug: tenant.slug };
}

async function ensureKey(
  db: Database,
  tenantId: string,
  plaintext: string,
  name: string,
  scopes: readonly Scope[],
  options: { exact: boolean; label: string; log?: FastifyBaseLogger | undefined },
): Promise<void> {
  const parsed = parseApiKey(plaintext);
  if (!parsed || parsed.env === "admin") {
    throw new DemoSetupError(`${options.label} must be a tenant key (vola_live_… or vola_test_…)`);
  }
  const hash = hashApiKey(plaintext);
  const [existing] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
  if (!existing) {
    await db.insert(apiKeys).values({
      tenantId,
      name,
      keyHash: hash,
      prefix: parsed.prefix,
      last4: parsed.last4,
      scopes: [...scopes],
      isAdmin: false,
      createdBy: "examples",
    });
    options.log?.info(
      { key: `${parsed.prefix}…${parsed.last4}`, scopes },
      `examples: ${name} stored`,
    );
    return;
  }
  const usable = await authenticateApiKey(db, plaintext);
  if (!usable)
    throw new DemoSetupError(`${options.label} is revoked, expired or its tenant is inactive`);
  if (existing.tenantId !== tenantId) {
    throw new DemoSetupError(
      `${options.label} belongs to another tenant than "${await slugOf(db, tenantId)}"`,
    );
  }
  const held = existing.scopes as Scope[];
  if (options.exact) {
    const extra = held.filter((scope) => !scopes.includes(scope));
    if (extra.length > 0) {
      throw new DemoSetupError(
        `${options.label} is published to every visitor and may hold only ${scopes.join(", ")}; it holds ${extra.join(", ")} too`,
      );
    }
  } else {
    const missing = scopes.filter((scope) => !held.includes(scope));
    if (missing.length > 0) {
      throw new DemoSetupError(`${options.label} lacks the scope(s) ${missing.join(", ")}`);
    }
  }
}

async function slugOf(db: Database, tenantId: string): Promise<string> {
  const [row] = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row?.slug ?? tenantId;
}

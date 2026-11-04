import type { ApiKey, KeyEnv } from "@vol-a/core";
import type { FastifyInstance } from "fastify";
import { type BuildAppOptions, buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { connect, type DatabaseHandle } from "../src/db/index.js";
import {
  apiKeys,
  files,
  folders,
  keyrings,
  processingJobs,
  shareLinks,
  tenantStats,
  tenants,
  uploads,
} from "../src/db/schema.js";
import { createApiKey } from "../src/services/apikeys.js";
import { createTenant } from "../src/services/tenants.js";

// The vocabulary of the repository, without recording candidates into its var/ directory.
// Background jobs are OFF (`sync` mode: thumbnails render inline, nothing is queued) so the
// suites never touch the shared Redis queue; the worker suite opens its own queue explicitly.
export const config = loadConfig({
  ...process.env,
  VOLA_PREFIX: "/vola",
  VOLA_RECORD_CANDIDATES: "false",
  VOLA_WORKER_ENABLED: "0",
});

/** A pool on the test database. */
export function testDatabase(max = 3): DatabaseHandle {
  return connect(config.testDatabaseUrl, { max });
}

/** Empties the tables (files and keys cascade from tenants; admin keys explicitly). */
export async function truncate(handle: DatabaseHandle): Promise<void> {
  await handle.db.delete(shareLinks);
  await handle.db.delete(tenantStats);
  await handle.db.delete(processingJobs);
  await handle.db.delete(uploads);
  await handle.db.delete(files);
  await handle.db.delete(folders);
  await handle.db.delete(keyrings);
  await handle.db.delete(apiKeys);
  await handle.db.delete(tenants);
}

export interface Fixture {
  app: FastifyInstance;
  tenant: { id: string; slug: string };
  /** A tenant key with every tenant scope. */
  full: { apiKey: ApiKey; key: string };
  /** A tenant key with `files:read` only. */
  readOnly: { apiKey: ApiKey; key: string };
  /** An admin key. */
  admin: { apiKey: ApiKey; key: string };
}

/** A tenant with three keys and an app on the test database. */
export async function setupFixture(
  handle: DatabaseHandle,
  options: Partial<BuildAppOptions> = {},
): Promise<Fixture> {
  const tenant = await createTenant(handle.db, { slug: "acme", name: "Acme" });
  const full = await mintKey(handle, tenant.id, "full", "live", [
    "files:read",
    "files:write",
    "folders:read",
    "folders:write",
    "shares:write",
    "keys:write",
    "keyrings:write",
  ]);
  const readOnly = await mintKey(handle, tenant.id, "read-only", "test", ["files:read"]);
  const admin = await mintKey(handle, null, "root", "admin", ["admin"]);
  const app = await buildApp({ config, db: handle.db, logger: false, ...options });
  return { app, tenant: { id: tenant.id, slug: tenant.slug }, full, readOnly, admin };
}

export function mintKey(
  handle: DatabaseHandle,
  tenantId: string | null,
  name: string,
  env: KeyEnv,
  scopes: string[],
  extra: { expiresAt?: Date } = {},
) {
  return createApiKey(handle.db, { tenantId, name, env, scopes, expiresAt: extra.expiresAt });
}

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

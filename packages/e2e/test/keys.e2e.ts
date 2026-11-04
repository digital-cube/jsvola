import { ApiKeyCreatedSchema, ApiKeyListSchema, ErrorResponseSchema } from "@vol-a/core";
import {
  connect,
  createApiKey,
  createTenant,
  type DatabaseHandle,
  loadConfig,
  schema,
} from "@vol-a/server";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const server = inject("server");

/**
 * Auth and `/keys` over HTTP against the built server. Needs the database that server uses
 * (`VOLA_DATABASE_URL_TEST` for the suite's own server; skipped for an external
 * `VOLA_E2E_URL` whose database we cannot reach).
 */
describe.skipIf(Boolean(process.env.VOLA_E2E_URL))("API keys (built server)", () => {
  let handle: DatabaseHandle;
  let adminKey: string;
  const slug = `e2e-${Date.now().toString(36)}`;

  beforeAll(async () => {
    handle = connect(loadConfig().testDatabaseUrl, { max: 1 });
    await createTenant(handle.db, { slug, name: "E2E" });
    adminKey = (
      await createApiKey(handle.db, {
        tenantId: null,
        env: "admin",
        name: "e2e",
        scopes: ["admin"],
      })
    ).key;
  });
  afterAll(async () => {
    await handle.db.delete(schema.apiKeys);
    await handle.db.delete(schema.tenants);
    await handle.close();
  });

  it("refuses an unauthenticated request with 401 and the envelope", async () => {
    const response = await fetch(`${server}/keys`);
    expect(response.status).toBe(401);
    expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe("unauthorized");
  });

  it("admin + X-Tenant-Slug mints a tenant key, which then lists and revokes itself", async () => {
    const created = await fetch(`${server}/keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminKey}`,
        "x-tenant-slug": slug,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "e2e-key", scopes: ["keys:write", "files:read"], env: "test" }),
    });
    expect(created.status).toBe(201);
    const key = ApiKeyCreatedSchema.parse(await created.json());

    const listed = await fetch(`${server}/keys`, { headers: { "x-api-key": key.key } });
    expect(listed.status).toBe(200);
    expect(ApiKeyListSchema.parse(await listed.json()).keys.map((k) => k.id)).toEqual([key.id]);

    const revoked = await fetch(`${server}/keys/${key.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key.key}` },
    });
    expect(revoked.status).toBe(200);
    const after = await fetch(`${server}/keys`, { headers: { "x-api-key": key.key } });
    expect(after.status).toBe(401);
  });
});

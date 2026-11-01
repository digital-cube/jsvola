import { ApiKeyCreatedSchema, ApiKeyListSchema } from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiKeys } from "../src/db/schema.js";
import { VolaError } from "../src/errors.js";
import {
  authenticateApiKey,
  createApiKey,
  findApiKey,
  listApiKeys,
  revokeApiKey,
} from "../src/services/apikeys.js";
import { createTenant, getTenantBySlug, listTenants } from "../src/services/tenants.js";
import { bearer, type Fixture, mintKey, setupFixture, testDatabase, truncate } from "./helpers.js";

const handle = testDatabase();
let fx: Fixture;
let app: FastifyInstance;

beforeAll(async () => {
  await truncate(handle);
  fx = await setupFixture(handle);
  app = fx.app;
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

const post = (key: string, payload: object, extra: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/vola/keys", headers: { ...bearer(key), ...extra }, payload });

describe("POST /vola/keys", () => {
  it("creates a key and returns the plaintext once", async () => {
    const response = await post(fx.full.key, {
      name: "dashboard",
      scopes: ["files:read", "folders:read"],
      env: "test",
    });
    expect(response.statusCode).toBe(201);
    const body = ApiKeyCreatedSchema.parse(response.json());
    expect(body).toMatchObject({
      tenant_id: fx.tenant.id,
      name: "dashboard",
      prefix: "vola_test",
      scopes: ["files:read", "folders:read"],
      is_admin: false,
      expires_at: null,
      revoked_at: null,
      created_by: null,
    });
    expect(body.key).toMatch(/^vola_test_[A-Za-z0-9]{32}$/);
    expect(body.last4).toBe(body.key.slice(-4));
    expect(response.json()).not.toHaveProperty("key_hash");

    // The new key works, with exactly the scopes it was given.
    const whoami = await app.inject({
      method: "GET",
      url: "/vola/keys",
      headers: bearer(body.key),
    });
    expect(whoami.statusCode).toBe(403);
    expect(whoami.json().error.required).toEqual(["keys:write"]);
  });

  it("records X-User-Id as created_by and accepts expires_at", async () => {
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    const response = await post(
      fx.full.key,
      { name: "temp", scopes: ["files:read"], env: "live", expires_at: expires },
      { "x-user-id": "igor" },
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ created_by: "igor", expires_at: expires });
  });

  it("only grants scopes the caller holds", async () => {
    const response = await post(fx.readOnly.key, {
      name: "escalate",
      scopes: ["files:write"],
      env: "live",
    });
    // read-only lacks keys:write altogether → 403 at the route.
    expect(response.statusCode).toBe(403);

    const keysOnly = await mintKey(handle, fx.tenant.id, "keys-only", "live", ["keys:write"]);
    const beyond = await post(keysOnly.key, {
      name: "escalate",
      scopes: ["keys:write", "files:write"],
      env: "live",
    });
    expect(beyond.statusCode).toBe(403);
    expect(beyond.json().error).toMatchObject({ code: "forbidden", required: ["files:write"] });

    const within = await post(keysOnly.key, { name: "fine", scopes: ["keys:write"], env: "live" });
    expect(within.statusCode).toBe(201);
  });

  it("validates the body", async () => {
    const cases: [object, RegExp][] = [
      [{ name: "", scopes: ["files:read"], env: "live" }, /^name/],
      [{ name: "x", scopes: [], env: "live" }, /^scopes/],
      [{ name: "x", scopes: ["admin"], env: "live" }, /^scopes/],
      [{ name: "x", scopes: ["files:read"], env: "admin" }, /^env/],
      [{ name: "x", scopes: ["files:read"], env: "live", extra: 1 }, /extra/],
      [{ name: "x", scopes: ["files:read"], env: "live", expires_at: "yesterday" }, /^expires_at/],
    ];
    for (const [payload, message] of cases) {
      const response = await post(fx.full.key, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
      expect(response.json().error.code).toBe("validation_error");
      expect(response.json().error.message).toMatch(message);
    }
    const past = await post(fx.full.key, {
      name: "x",
      scopes: ["files:read"],
      env: "live",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(past.statusCode).toBe(422);
    expect(past.json().error.message).toMatch(/expires_at: must be in the future/);
  });

  it("lets an admin key create tenant keys through X-Tenant-Slug, and needs one", async () => {
    const without = await post(fx.admin.key, { name: "x", scopes: ["files:read"], env: "live" });
    expect(without.statusCode).toBe(400);
    expect(without.json().error.code).toBe("tenant_required");

    const response = await post(
      fx.admin.key,
      { name: "by-admin", scopes: ["files:read", "keys:write"], env: "live" },
      { "x-tenant-slug": "acme" },
    );
    expect(response.statusCode).toBe(201);
    expect(response.json().tenant_id).toBe(fx.tenant.id);
  });
});

describe("GET /vola/keys", () => {
  it("lists the tenant's keys, newest first, without hashes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vola/keys",
      headers: bearer(fx.full.key),
    });
    expect(response.statusCode).toBe(200);
    const { keys } = ApiKeyListSchema.parse(response.json());
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(keys.every((k) => k.tenant_id === fx.tenant.id)).toBe(true);
    expect(keys.map((k) => k.id)).toContain(fx.full.apiKey.id);
    expect(keys.map((k) => k.id)).not.toContain(fx.admin.apiKey.id);
    for (const key of keys) {
      expect(key).not.toHaveProperty("key");
      expect(key).not.toHaveProperty("key_hash");
    }
    const created = keys.map((k) => Date.parse(k.created_at));
    expect([...created].sort((a, b) => b - a)).toEqual(created);
  });

  it("isolates tenants: another tenant sees none of these keys", async () => {
    const other = await createTenant(handle.db, { slug: "other" });
    const otherKey = await mintKey(handle, other.id, "other-full", "live", ["keys:write"]);
    const response = await app.inject({
      method: "GET",
      url: "/vola/keys",
      headers: bearer(otherKey.key),
    });
    const { keys } = ApiKeyListSchema.parse(response.json());
    expect(keys.map((k) => k.id)).toEqual([otherKey.apiKey.id]);
  });
});

describe("DELETE /vola/keys/:id", () => {
  it("revokes a key of the tenant (soft) and the key stops working", async () => {
    const victim = await mintKey(handle, fx.tenant.id, "victim", "live", ["files:read"]);
    const response = await app.inject({
      method: "DELETE",
      url: `/vola/keys/${victim.apiKey.id}`,
      headers: bearer(fx.full.key),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revoked_at).toBeTruthy();
    const [row] = await handle.db.select().from(apiKeys).where(eq(apiKeys.id, victim.apiKey.id));
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect(await authenticateApiKey(handle.db, victim.key)).toBeNull();

    // Idempotent.
    const again = await app.inject({
      method: "DELETE",
      url: `/vola/keys/${victim.apiKey.id}`,
      headers: bearer(fx.full.key),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().revoked_at).toBe(response.json().revoked_at);
  });

  it("answers 404 for another tenant's key, an unknown id and a malformed id", async () => {
    const other = await getTenantBySlug(handle.db, "other");
    const foreign = await mintKey(handle, other.id, "foreign", "live", ["files:read"]);
    for (const id of [foreign.apiKey.id, "00000000-0000-7000-8000-000000000000", "not-a-uuid"]) {
      const response = await app.inject({
        method: "DELETE",
        url: `/vola/keys/${id}`,
        headers: bearer(fx.full.key),
      });
      expect(response.statusCode, id).toBe(404);
      expect(response.json().error.code).toBe("not_found");
    }
    expect(await authenticateApiKey(handle.db, foreign.key)).not.toBeNull();
  });
});

describe("services", () => {
  it("createTenant validates the slug, defaults the name and refuses duplicates", async () => {
    const tenant = await createTenant(handle.db, { slug: "digital-cube" });
    expect(tenant).toMatchObject({ slug: "digital-cube", name: "Digital Cube", is_active: true });
    await expect(createTenant(handle.db, { slug: "digital-cube" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(createTenant(handle.db, { slug: "Bad Slug" })).rejects.toMatchObject({
      code: "validation_error",
    });
    await expect(createTenant(handle.db, { slug: "ok-slug", name: " " })).rejects.toMatchObject({
      code: "validation_error",
    });
    expect((await listTenants(handle.db)).map((t) => t.slug)).toContain("digital-cube");
    await expect(getTenantBySlug(handle.db, "missing")).rejects.toMatchObject({
      code: "tenant_not_found",
    });
  });

  it("createApiKey enforces env/tenant pairing and scope rules", async () => {
    const base = { name: "k", scopes: ["files:read"] };
    await expect(
      createApiKey(handle.db, { ...base, tenantId: fx.tenant.id, env: "admin" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      createApiKey(handle.db, { ...base, tenantId: null, env: "live" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      createApiKey(handle.db, { ...base, tenantId: fx.tenant.id, env: "live", scopes: "admin" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      createApiKey(handle.db, { ...base, tenantId: fx.tenant.id, env: "live", scopes: "nope" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      createApiKey(handle.db, { ...base, tenantId: fx.tenant.id, env: "live", name: "  " }),
    ).rejects.toMatchObject({ code: "validation_error" });
    const admin = await createApiKey(handle.db, {
      tenantId: null,
      env: "admin",
      name: "root2",
      scopes: "files:read", // ignored: admin keys hold exactly ["admin"]
    });
    expect(admin.apiKey).toMatchObject({ is_admin: true, tenant_id: null, scopes: ["admin"] });
  });

  it("listApiKeys filters by tenant, admin only, or everything", async () => {
    const all = await listApiKeys(handle.db);
    const admins = await listApiKeys(handle.db, { tenantId: null });
    const acme = await listApiKeys(handle.db, { tenantId: fx.tenant.id });
    expect(admins.every((k) => k.is_admin)).toBe(true);
    expect(acme.every((k) => k.tenant_id === fx.tenant.id)).toBe(true);
    expect(all.length).toBeGreaterThan(admins.length + acme.length - 1);
  });

  it("findApiKey resolves an id or a display form and reports ambiguity", async () => {
    const byId = await findApiKey(handle.db, fx.full.apiKey.id);
    expect(byId.id).toBe(fx.full.apiKey.id);
    const display = `${fx.readOnly.apiKey.prefix}…${fx.readOnly.apiKey.last4}`;
    const matches = (await listApiKeys(handle.db)).filter(
      (k) => k.prefix === fx.readOnly.apiKey.prefix && k.last4 === fx.readOnly.apiKey.last4,
    );
    if (matches.length === 1) {
      expect((await findApiKey(handle.db, display)).id).toBe(fx.readOnly.apiKey.id);
      expect((await findApiKey(handle.db, display.replace("…", "..."))).id).toBe(
        fx.readOnly.apiKey.id,
      );
    } else {
      await expect(findApiKey(handle.db, display)).rejects.toMatchObject({ code: "conflict" });
    }
    await expect(findApiKey(handle.db, "vola_live…ZZZZ")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      findApiKey(handle.db, "00000000-0000-7000-8000-000000000000"),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(findApiKey(handle.db, "garbage")).rejects.toMatchObject({
      code: "validation_error",
    });
  });

  it("revokeApiKey without a tenant filter (CLI) revokes any key, admin ones too", async () => {
    const admin = await mintKey(handle, null, "doomed", "admin", ["admin"]);
    const revoked = await revokeApiKey(handle.db, admin.apiKey.id);
    expect(revoked.revoked_at).toBeTruthy();
    expect(await authenticateApiKey(handle.db, admin.key)).toBeNull();
    await expect(revokeApiKey(handle.db, "nope")).rejects.toBeInstanceOf(VolaError);
  });

  it("authenticateApiKey honours the clock for expiry", async () => {
    const soon = new Date(Date.now() + 60_000);
    const key = await mintKey(handle, fx.tenant.id, "soon", "live", ["files:read"], {
      expiresAt: soon,
    });
    expect(await authenticateApiKey(handle.db, key.key, new Date())).not.toBeNull();
    expect(await authenticateApiKey(handle.db, key.key, soon)).toBeNull();
    expect(await authenticateApiKey(handle.db, "garbage")).toBeNull();
  });
});

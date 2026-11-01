import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requestUserId, websocketKey } from "../src/auth.js";
import { currentContext, requireTenant, type TenantContext } from "../src/context.js";
import { apiKeys, tenants } from "../src/db/schema.js";
import { VolaError } from "../src/errors.js";
import { LastUsedThrottle } from "../src/services/apikeys.js";
import { setTenantActive } from "../src/services/tenants.js";
import { bearer, type Fixture, mintKey, setupFixture, testDatabase, truncate } from "./helpers.js";

const handle = testDatabase();
let fx: Fixture;
let app: FastifyInstance;
/** What the test routes saw. */
let seen: { context?: TenantContext; store?: TenantContext; required?: TenantContext };

beforeAll(async () => {
  await truncate(handle);
  fx = await setupFixture(handle, {
    lastUsed: new LastUsedThrottle(60_000),
    // Test routes INSIDE the plugin, so its auth hooks apply.
    extend: (child) => {
      child.get("/t/whoami", { config: { scope: "files:read" } }, async (request) => {
        seen.context = request.vola;
        seen.store = currentContext();
        return { tenant: request.vola?.tenantSlug, user: request.vola?.userId };
      });
      child.get("/t/write", { config: { scope: ["files:read", "files:write"] } }, async () => ({
        ok: true,
      }));
      child.get("/t/any", async () => ({ ok: true }));
      child.get("/t/open", { config: { auth: "none" } }, async () => ({ open: true }));
      child.get(
        "/t/admin",
        { config: { scope: "admin", tenant: "optional" } },
        async (request) => ({
          tenant: request.vola?.tenantSlug ?? null,
        }),
      );
      child.get("/t/require", { config: { tenant: "optional" } }, async () => {
        seen.required = requireTenant();
        return { tenant: seen.required.tenantSlug };
      });
    },
  });
  app = fx.app;
  await app.ready();
});
beforeEach(() => {
  seen = {};
});
afterAll(async () => {
  await app.close();
  await handle.close();
});

const UNAUTHORIZED = { error: { code: "unauthorized", message: "a valid API key is required" } };

describe("authentication", () => {
  it("answers the same 401 without a key, with a malformed key and with an unknown key", async () => {
    const malformed = "vola_live_short";
    const unknown = `vola_live_${"A".repeat(32)}`;
    for (const headers of [{}, bearer(malformed), bearer(unknown), { "x-api-key": unknown }]) {
      const response = await app.inject({ method: "GET", url: "/vola/t/whoami", headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(401);
      expect(response.json()).toEqual(UNAUTHORIZED);
    }
  });

  it("refuses a revoked key, an expired key and a key of an inactive tenant with that same 401", async () => {
    const revoked = await mintKey(handle, fx.tenant.id, "revoked", "live", ["files:read"]);
    await handle.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, revoked.apiKey.id));
    const expired = await mintKey(handle, fx.tenant.id, "expired", "live", ["files:read"]);
    await handle.db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, expired.apiKey.id));
    const sleepy = await handle.db
      .insert(tenants)
      .values({ slug: "sleepy", name: "Sleepy", isActive: false })
      .returning();
    const inactive = await mintKey(handle, (sleepy[0] as { id: string }).id, "zzz", "live", [
      "files:read",
    ]);

    for (const key of [revoked.key, expired.key, inactive.key]) {
      const response = await app.inject({
        method: "GET",
        url: "/vola/t/whoami",
        headers: bearer(key),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(UNAUTHORIZED);
    }
  });

  it("refuses a tenant key once its tenant is deactivated, and accepts it again afterwards", async () => {
    await setTenantActive(handle.db, fx.tenant.slug, false);
    const off = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: bearer(fx.full.key),
    });
    expect(off.statusCode).toBe(401);
    await setTenantActive(handle.db, fx.tenant.slug, true);
    const on = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: bearer(fx.full.key),
    });
    expect(on.statusCode).toBe(200);
  });

  it("accepts Authorization: Bearer and X-Api-Key and builds the TenantContext", async () => {
    for (const headers of [bearer(fx.full.key), { "x-api-key": fx.full.key }]) {
      const response = await app.inject({
        method: "GET",
        url: "/vola/t/whoami",
        headers: { ...headers, "x-user-id": "user-42" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ tenant: "acme", user: "user-42" });
      expect(seen.context).toEqual({
        tenantId: fx.tenant.id,
        tenantSlug: "acme",
        apiKeyId: fx.full.apiKey.id,
        apiKeyLabel: `${fx.full.apiKey.prefix}…${fx.full.apiKey.last4}`,
        scopes: fx.full.apiKey.scopes,
        isAdmin: false,
        userId: "user-42",
      });
      // requireTenant() (AsyncLocalStorage) sees the same context as request.vola.
      expect(seen.store).toBe(seen.context);
    }
  });

  it("leaves userId null without X-User-Id and rejects an invalid one with 400", async () => {
    const without = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: bearer(fx.full.key),
    });
    expect(without.json().user).toBeNull();
    const control = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: { ...bearer(fx.full.key), "x-user-id": "bad\u0001id" },
    });
    expect(control.statusCode).toBe(400);
    expect(control.json().error.code).toBe("bad_request");
    const long = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: { ...bearer(fx.full.key), "x-user-id": "x".repeat(256) },
    });
    expect(long.statusCode).toBe(400);
  });

  it("lets routes with config.auth = none through without a key (health too)", async () => {
    expect((await app.inject({ method: "GET", url: "/vola/t/open" })).json()).toEqual({
      open: true,
    });
    expect((await app.inject({ method: "GET", url: "/vola/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/vola/health/ready" })).statusCode).toBe(200);
  });

  it("requires a key, but no particular scope, for a route without config.scope", async () => {
    expect((await app.inject({ method: "GET", url: "/vola/t/any" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/vola/t/any", headers: bearer(fx.readOnly.key) }))
        .statusCode,
    ).toBe(200);
  });

  it("still answers 404 for an unknown route without a key", async () => {
    const response = await app.inject({ method: "GET", url: "/vola/nothing" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });

  it("accepts the key as the bearer.<key> WebSocket subprotocol", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": `vola.v1, bearer.${fx.readOnly.key}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tenant).toBe("acme");

    // Without the upgrade the subprotocol header means nothing.
    const plain = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: { "sec-websocket-protocol": `bearer.${fx.readOnly.key}` },
    });
    expect(plain.statusCode).toBe(401);
  });
});

describe("scopes", () => {
  it("answers 403 forbidden with the required scopes when one is missing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vola/t/write",
      headers: bearer(fx.readOnly.key),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: {
        code: "forbidden",
        message: 'this API key lacks the scope "files:write"',
        required: ["files:read", "files:write"],
      },
    });
  });

  it("passes a key holding every listed scope, and an admin key for anything", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/vola/t/write", headers: bearer(fx.full.key) }))
        .statusCode,
    ).toBe(200);
    const admin = await app.inject({
      method: "GET",
      url: "/vola/t/write",
      headers: { ...bearer(fx.admin.key), "x-tenant-slug": "acme" },
    });
    expect(admin.statusCode).toBe(200);
  });

  it("keeps tenant keys away from admin routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vola/t/admin",
      headers: bearer(fx.full.key),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.required).toEqual(["admin"]);
  });
});

describe("admin keys and X-Tenant-Slug", () => {
  it("selects the tenant named by X-Tenant-Slug", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: { ...bearer(fx.admin.key), "x-tenant-slug": "acme" },
    });
    expect(response.statusCode).toBe(200);
    expect(seen.context).toMatchObject({
      tenantId: fx.tenant.id,
      tenantSlug: "acme",
      apiKeyId: fx.admin.apiKey.id,
      apiKeyLabel: `${fx.admin.apiKey.prefix}…${fx.admin.apiKey.last4}`,
      scopes: ["admin"],
      isAdmin: true,
    });
  });

  it("answers 404 tenant_not_found for an unknown or inactive slug", async () => {
    const unknown = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: { ...bearer(fx.admin.key), "x-tenant-slug": "nope" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({
      error: { code: "tenant_not_found", message: 'tenant "nope" not found' },
    });
    const inactive = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: { ...bearer(fx.admin.key), "x-tenant-slug": "sleepy" },
    });
    expect(inactive.statusCode).toBe(404);
    expect(inactive.json().error.code).toBe("tenant_not_found");
  });

  it("without the header reaches only routes that accept no tenant", async () => {
    const admin = await app.inject({
      method: "GET",
      url: "/vola/t/admin",
      headers: bearer(fx.admin.key),
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toEqual({ tenant: null });

    const tenantRoute = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: bearer(fx.admin.key),
    });
    expect(tenantRoute.statusCode).toBe(400);
    expect(tenantRoute.json().error.code).toBe("tenant_required");

    // requireTenant() inside a tenant-optional route gives the same answer.
    const required = await app.inject({
      method: "GET",
      url: "/vola/t/require",
      headers: bearer(fx.admin.key),
    });
    expect(required.statusCode).toBe(400);
    expect(required.json().error.code).toBe("tenant_required");
    const bound = await app.inject({
      method: "GET",
      url: "/vola/t/require",
      headers: { ...bearer(fx.admin.key), "x-tenant-slug": "acme" },
    });
    expect(bound.json()).toEqual({ tenant: "acme" });
  });

  it("is ignored by a tenant key", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vola/t/whoami",
      headers: { ...bearer(fx.full.key), "x-tenant-slug": "nope" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tenant).toBe("acme");
  });
});

describe("last_used_at", () => {
  it("is written on the first request and then at most once a minute", async () => {
    const key = await mintKey(handle, fx.tenant.id, "used", "live", ["files:read"]);
    const read = async () =>
      (await handle.db.select().from(apiKeys).where(eq(apiKeys.id, key.apiKey.id)))[0]
        ?.lastUsedAt ?? null;
    expect(await read()).toBeNull();

    await app.inject({ method: "GET", url: "/vola/t/whoami", headers: bearer(key.key) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const first = await read();
    expect(first).not.toBeNull();

    await app.inject({ method: "GET", url: "/vola/t/whoami", headers: bearer(key.key) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await read())?.getTime()).toBe(first?.getTime());
  });
});

describe("helpers", () => {
  it("requireTenant throws unauthorized outside a request", () => {
    expect(() => requireTenant()).toThrow(VolaError);
    try {
      requireTenant();
    } catch (error) {
      expect((error as VolaError).code).toBe("unauthorized");
    }
  });

  it("websocketKey and requestUserId read the raw headers", () => {
    const fake = (headers: Record<string, string>) => ({ headers }) as never;
    expect(websocketKey(fake({ upgrade: "WebSocket", "sec-websocket-protocol": "bearer.k" }))).toBe(
      "k",
    );
    expect(websocketKey(fake({ "sec-websocket-protocol": "bearer.k" }))).toBeNull();
    expect(requestUserId(fake({}))).toBeNull();
    expect(requestUserId(fake({ "x-user-id": "u" }))).toBe("u");
  });
});

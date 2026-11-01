import { describe, expect, it } from "vitest";
import {
  ApiKeyCreateSchema,
  bearerSubprotocols,
  displayApiKey,
  extractApiKey,
  extractSubprotocolKey,
  hasScope,
  missingScopes,
  parseApiKey,
  parseScopes,
  SCOPES,
  SlugSchema,
  TENANT_SCOPES,
  UserIdSchema,
} from "../src/index.js";

const SECRET = "Ab3dEfGh1jKlMn0pQrStUvWxYz123456";

describe("parseApiKey", () => {
  it("splits a well-formed key into prefix, env, secret and last4", () => {
    expect(parseApiKey(`vola_live_${SECRET}`)).toEqual({
      prefix: "vola_live",
      env: "live",
      secret: SECRET,
      last4: "3456",
    });
    expect(parseApiKey(`vola_test_${SECRET}`)?.env).toBe("test");
    expect(parseApiKey(`vola_admin_${SECRET}`)?.prefix).toBe("vola_admin");
  });

  it("rejects anything else", () => {
    for (const bad of [
      "",
      "vola_live_",
      `vola_prod_${SECRET}`,
      `mk_live_${SECRET}`,
      `vola_live_${SECRET.slice(1)}`,
      `vola_live_${SECRET}x`,
      `vola_live_${SECRET.replace("A", "-")}`,
      ` vola_live_${SECRET}`,
    ]) {
      expect(parseApiKey(bad), bad).toBeNull();
    }
  });

  it("displays a key as prefix…last4", () => {
    expect(displayApiKey("vola_live", "k3Qz")).toBe("vola_live…k3Qz");
  });
});

describe("extractApiKey", () => {
  it("reads Authorization: Bearer, case-insensitively, then X-Api-Key", () => {
    expect(extractApiKey({ authorization: "Bearer abc" })).toBe("abc");
    expect(extractApiKey({ authorization: "bearer  abc " })).toBe("abc");
    expect(extractApiKey({ "x-api-key": " abc " })).toBe("abc");
    expect(extractApiKey({ authorization: "Bearer first", "x-api-key": "second" })).toBe("first");
    expect(extractApiKey({ authorization: ["Bearer one", "Bearer two"] })).toBe("one");
  });

  it("ignores other schemes and empty values", () => {
    expect(extractApiKey({ authorization: "Basic abc" })).toBeNull();
    expect(extractApiKey({ authorization: "Bearer" })).toBeNull();
    expect(extractApiKey({ "x-api-key": "" })).toBeNull();
    expect(extractApiKey({})).toBeNull();
  });
});

describe("extractSubprotocolKey", () => {
  it("finds bearer.<key> among the offered subprotocols", () => {
    expect(extractSubprotocolKey("vola.v1, bearer.abc")).toBe("abc");
    expect(extractSubprotocolKey(["chat", "bearer.abc"])).toBe("abc");
    expect(extractSubprotocolKey(bearerSubprotocols("k").join(", "))).toBe("k");
  });

  it("returns null without one", () => {
    expect(extractSubprotocolKey(undefined)).toBeNull();
    expect(extractSubprotocolKey("")).toBeNull();
    expect(extractSubprotocolKey("vola.v1, bearer.")).toBeNull();
  });
});

describe("scopes", () => {
  it("admin satisfies every scope", () => {
    for (const scope of SCOPES) expect(hasScope(["admin"], scope)).toBe(true);
    expect(missingScopes(["admin"], [...SCOPES])).toEqual([]);
  });

  it("matches exact scopes only", () => {
    expect(hasScope(["files:read"], "files:read")).toBe(true);
    expect(hasScope(["files:read"], "files:write")).toBe(false);
    expect(hasScope(["files:write"], "files:read")).toBe(false);
    expect(hasScope([], "files:read")).toBe(false);
    expect(missingScopes(["files:read"], ["files:read", "folders:write"])).toEqual([
      "folders:write",
    ]);
    expect(missingScopes(["files:read"], "keys:write")).toEqual(["keys:write"]);
  });

  it("parses a comma list or an array into distinct known scopes", () => {
    expect(parseScopes("files:read, files:write,files:read,")).toEqual([
      "files:read",
      "files:write",
    ]);
    expect(parseScopes(["keys:write"])).toEqual(["keys:write"]);
    expect(() => parseScopes("files:all")).toThrow(/unknown scope "files:all"/);
    expect(() => parseScopes("")).toThrow(/at least one scope/);
  });

  it("keeps admin out of the tenant scopes", () => {
    expect(TENANT_SCOPES).not.toContain("admin");
    expect(TENANT_SCOPES.length).toBe(SCOPES.length - 1);
    expect(
      ApiKeyCreateSchema.safeParse({ name: "x", scopes: ["admin"], env: "live" }).success,
    ).toBe(false);
    expect(
      ApiKeyCreateSchema.safeParse({ name: "x", scopes: ["files:read"], env: "live" }).success,
    ).toBe(true);
  });
});

describe("header value schemas", () => {
  it("accepts slugs of 2–63 lowercase letters, digits and dashes", () => {
    for (const ok of ["ab", "acme", "acme-inc", "a1", "0-9", "a".repeat(63)]) {
      expect(SlugSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["a", "-acme", "Acme", "acme inc", "acme_inc", "a".repeat(64), ""]) {
      expect(SlugSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("accepts a user id of up to 255 printable characters", () => {
    expect(UserIdSchema.safeParse("user-42").success).toBe(true);
    expect(UserIdSchema.safeParse("Žarko Đurić").success).toBe(true);
    expect(UserIdSchema.safeParse("x".repeat(255)).success).toBe(true);
    expect(UserIdSchema.safeParse("x".repeat(256)).success).toBe(false);
    expect(UserIdSchema.safeParse("a\nb").success).toBe(false);
    expect(UserIdSchema.safeParse("a\x7fb").success).toBe(false);
    expect(UserIdSchema.safeParse("").success).toBe(false);
  });
});

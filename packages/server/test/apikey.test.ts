import { createHash } from "node:crypto";
import { parseApiKey } from "@vol-a/core";
import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, randomBase62, sameHash } from "../src/apikey.js";
import { uuidv7 } from "../src/db/uuid.js";
import { LastUsedThrottle } from "../src/services/apikeys.js";

describe("generateApiKey", () => {
  it("mints vola_<env>_<32 base62> keys with their hash and last4", () => {
    for (const env of ["live", "test", "admin"] as const) {
      const generated = generateApiKey(env);
      expect(generated.key).toMatch(new RegExp(`^vola_${env}_[A-Za-z0-9]{32}$`));
      expect(generated.prefix).toBe(`vola_${env}`);
      expect(generated.last4).toBe(generated.key.slice(-4));
      expect(generated.keyHash).toBe(createHash("sha256").update(generated.key).digest("hex"));
      expect(parseApiKey(generated.key)?.env).toBe(env);
    }
  });

  it("does not repeat itself", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey("live").key));
    expect(keys.size).toBe(200);
  });

  it("randomBase62 uses the whole alphabet and the exact length", () => {
    const sample = randomBase62(5000);
    expect(sample).toHaveLength(5000);
    expect(sample).toMatch(/^[A-Za-z0-9]+$/);
    const classes = new Set(
      sample.split("").map((c) => (/[a-z]/.test(c) ? "l" : /[A-Z]/.test(c) ? "u" : "d")),
    );
    expect(classes.size).toBe(3);
  });
});

describe("hashApiKey / sameHash", () => {
  it("is SHA-256 hex and compares in constant time", () => {
    const hash = hashApiKey("vola_live_x");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sameHash(hash, hashApiKey("vola_live_x"))).toBe(true);
    expect(sameHash(hash, hashApiKey("vola_live_y"))).toBe(false);
    expect(sameHash(hash, hash.slice(1))).toBe(false);
  });
});

describe("uuidv7", () => {
  it("produces RFC 9562 v7 ids ordered by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    // The first 48 bits are the millisecond timestamp.
    expect(Number.parseInt(a.replace(/-/g, "").slice(0, 12), 16)).toBe(1_700_000_000_000);
    expect(new Set(Array.from({ length: 100 }, () => uuidv7())).size).toBe(100);
  });
});

describe("LastUsedThrottle", () => {
  it("allows one write per key per interval", () => {
    const throttle = new LastUsedThrottle(60_000);
    expect(throttle.shouldWrite("k1", 0)).toBe(true);
    expect(throttle.shouldWrite("k1", 30_000)).toBe(false);
    expect(throttle.shouldWrite("k2", 30_000)).toBe(true);
    expect(throttle.shouldWrite("k1", 59_999)).toBe(false);
    expect(throttle.shouldWrite("k1", 60_000)).toBe(true);
  });

  it("prunes stale entries when full", () => {
    const throttle = new LastUsedThrottle(1_000, 3);
    expect(throttle.shouldWrite("a", 0)).toBe(true);
    expect(throttle.shouldWrite("b", 0)).toBe(true);
    expect(throttle.shouldWrite("c", 0)).toBe(true);
    // Full: stale entries (older than the interval) go, the new one fits.
    expect(throttle.shouldWrite("d", 2_000)).toBe(true);
    expect(throttle.shouldWrite("a", 2_000)).toBe(true);
    // Full again with nothing stale: everything is forgotten rather than growing without bound.
    expect(throttle.shouldWrite("e", 2_000)).toBe(true);
    expect(throttle.shouldWrite("f", 2_000)).toBe(true);
    expect(throttle.shouldWrite("d", 2_000)).toBe(true);
  });
});

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import {
  hashSharePassword,
  isLimiterRedis,
  MemorySharePasswordLimiter,
  RedisSharePasswordLimiter,
  SHARE_PASSWORD_KEY_PREFIX,
  verifySharePassword,
} from "../src/services/share-password.js";
import { generateShareToken, hashShareToken, startsDownload } from "../src/services/shares.js";
import { config } from "./helpers.js";

describe("share tokens", () => {
  it("are 32 random bytes as base64url, stored as their SHA-256", () => {
    const { token, tokenHash } = generateShareToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).toBe(hashShareToken(token));
    expect(generateShareToken().token).not.toBe(token);
  });
});

describe("startsDownload", () => {
  it("is a GET of the whole file or a Range from byte 0; never HEAD, never a continuation", () => {
    expect(startsDownload("GET", undefined)).toBe(true);
    expect(startsDownload("GET", "")).toBe(true);
    expect(startsDownload("GET", "bytes=0-")).toBe(true);
    expect(startsDownload("GET", "bytes=0-1023")).toBe(true);
    expect(startsDownload("get", " bytes=0-5 ")).toBe(true);
    expect(startsDownload("GET", "bytes=1-")).toBe(false);
    expect(startsDownload("GET", "bytes=1024-2047")).toBe(false);
    expect(startsDownload("GET", "bytes=-500")).toBe(false);
    // Ignored by the download code → the whole file → a download.
    expect(startsDownload("GET", "bytes=-")).toBe(true);
    expect(startsDownload("GET", "items=0-5")).toBe(true);
    expect(startsDownload("GET", "bytes=0-1,5-6")).toBe(true);
    expect(startsDownload("HEAD", undefined)).toBe(false);
    expect(startsDownload("HEAD", "bytes=0-")).toBe(false);
  });
});

describe("share passwords", () => {
  it("hashes with argon2id (OWASP parameters) and verifies; an unreadable hash is false", async () => {
    const hash = await hashSharePassword("s3cr3t");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(await verifySharePassword(hash, "s3cr3t")).toBe(true);
    expect(await verifySharePassword(hash, "S3cr3t")).toBe(false);
    expect(await verifySharePassword("not-a-hash", "s3cr3t")).toBe(false);
    expect(await hashSharePassword("s3cr3t")).not.toBe(hash); // a fresh salt every time
  });
});

describe("MemorySharePasswordLimiter", () => {
  it("blocks after the limit for the window, then forgets", async () => {
    let now = new Date("2026-11-01T10:00:00Z");
    const limiter = new MemorySharePasswordLimiter({
      maxFailures: 3,
      windowS: 60,
      now: () => now,
    });
    expect(await limiter.check("t")).toEqual({ failures: 0, blocked: false, retryAfterS: 0 });
    await limiter.fail("t");
    await limiter.fail("t");
    expect(await limiter.check("t")).toEqual({ failures: 2, blocked: false, retryAfterS: 60 });
    await limiter.fail("t");
    now = new Date(now.getTime() + 30_000);
    expect(await limiter.check("t")).toEqual({ failures: 3, blocked: true, retryAfterS: 30 });
    expect(await limiter.check("other")).toMatchObject({ blocked: false });
    now = new Date(now.getTime() + 30_000);
    expect(await limiter.check("t")).toEqual({ failures: 0, blocked: false, retryAfterS: 0 });
    await limiter.fail("t");
    expect(await limiter.check("t")).toMatchObject({ failures: 1, retryAfterS: 60 });
  });

  it("evicts expired entries first, then the oldest, when full", async () => {
    let now = new Date("2026-11-01T10:00:00Z");
    const limiter = new MemorySharePasswordLimiter({ windowS: 60, maxKeys: 3, now: () => now });
    await limiter.fail("a");
    await limiter.fail("b");
    await limiter.fail("c");
    expect(limiter.size).toBe(3);
    await limiter.fail("d"); // full: nothing expired → the oldest (a) goes
    expect(limiter.size).toBe(3);
    expect(await limiter.check("a")).toMatchObject({ failures: 0 });
    expect(await limiter.check("d")).toMatchObject({ failures: 1 });
    now = new Date(now.getTime() + 61_000);
    await limiter.fail("e"); // everything expired → all dropped, e added
    expect(limiter.size).toBe(1);
  });
});

describe.skipIf(!config.redisUrl)("RedisSharePasswordLimiter (real Redis)", () => {
  const redis = new Redis(config.redisUrl as string, { lazyConnect: true });
  const keys: string[] = [];
  afterAll(async () => {
    if (keys.length > 0) await redis.del(...keys.map((k) => SHARE_PASSWORD_KEY_PREFIX + k));
    await redis.quit();
  });

  it("counts per key with the window as TTL and shares the count across instances", async () => {
    expect(isLimiterRedis(redis)).toBe(true);
    expect(isLimiterRedis({ ping: async () => "PONG" })).toBe(false);
    const key = `test-${randomUUID()}`;
    keys.push(key);
    const a = new RedisSharePasswordLimiter(redis, { maxFailures: 2, windowS: 120 });
    const b = new RedisSharePasswordLimiter(redis, { maxFailures: 2, windowS: 120 });
    expect(await a.check(key)).toEqual({ failures: 0, blocked: false, retryAfterS: 0 });
    await a.fail(key);
    const once = await b.check(key);
    expect(once.failures).toBe(1);
    expect(once.blocked).toBe(false);
    expect(once.retryAfterS).toBeGreaterThan(100);
    expect(once.retryAfterS).toBeLessThanOrEqual(120);
    await b.fail(key);
    expect((await a.check(key)).blocked).toBe(true);
    expect(await redis.ttl(SHARE_PASSWORD_KEY_PREFIX + key)).toBeGreaterThan(0);
  });

  it("never blocks a reader when Redis fails", async () => {
    const broken = {
      incr: async () => {
        throw new Error("down");
      },
      expire: async () => 0,
      get: async () => {
        throw new Error("down");
      },
      ttl: async () => -2,
    };
    const limiter = new RedisSharePasswordLimiter(broken);
    await limiter.fail("x");
    expect(await limiter.check("x")).toEqual({ failures: 0, blocked: false, retryAfterS: 0 });
  });
});

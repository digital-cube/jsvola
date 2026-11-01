import { SHARE_PASSWORD_MAX_FAILURES, SHARE_PASSWORD_WINDOW_S } from "@vola/core";
import argon2 from "argon2";
import type { FastifyBaseLogger } from "fastify";

/**
 * argon2id for share passwords — the OWASP minimum (19 MiB, 2 passes, 1 lane): a share
 * password is a short-lived secret checked on every anonymous request, and the brute-force
 * guard is the rate limit below, not the cost of one hash. The parameters live in the hash
 * string, so they can be raised without a migration.
 */
export const SHARE_ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** The encoded argon2id string of `password` (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`). */
export function hashSharePassword(password: string): Promise<string> {
  return argon2.hash(password, SHARE_ARGON2_OPTIONS);
}

/** `true` when `password` is the one behind `hash`; an unreadable hash is simply `false`. */
export async function verifySharePassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** What the limiter says before a password is checked. */
export interface PasswordAttemptState {
  /** Wrong attempts recorded in the current window. */
  failures: number;
  /** `true`: no more attempts until the window ends. */
  blocked: boolean;
  /** Seconds until the window ends (what `Retry-After` says); 0 when nothing is recorded. */
  retryAfterS: number;
}

/**
 * Counts wrong passwords per share token (`SHARE_PASSWORD_MAX_FAILURES` in
 * `SHARE_PASSWORD_WINDOW_S`): past the limit every attempt — the right password too — is
 * `429` until the window ends. The key is the token's hash, never the token.
 */
export interface SharePasswordLimiter {
  check(key: string): Promise<PasswordAttemptState>;
  /** Records one wrong password. */
  fail(key: string): Promise<void>;
}

export interface LimiterOptions {
  maxFailures?: number | undefined;
  windowS?: number | undefined;
  now?: (() => Date) | undefined;
}

/** The subset of ioredis the Redis limiter uses. */
export interface LimiterRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  get(key: string): Promise<string | null>;
  ttl(key: string): Promise<number>;
}

/** Redis key prefix of the per-token failure counters. */
export const SHARE_PASSWORD_KEY_PREFIX = "vola:share:pwfail:";

/**
 * The limiter of a deployment with Redis: one counter per token with the window as its TTL,
 * shared by every server process. A Redis error never blocks a reader (logged, treated as
 * "no failures").
 */
export class RedisSharePasswordLimiter implements SharePasswordLimiter {
  private readonly maxFailures: number;
  private readonly windowS: number;

  constructor(
    private readonly redis: LimiterRedis,
    options: LimiterOptions & { log?: FastifyBaseLogger | undefined } = {},
    private readonly log = options.log,
  ) {
    this.maxFailures = options.maxFailures ?? SHARE_PASSWORD_MAX_FAILURES;
    this.windowS = options.windowS ?? SHARE_PASSWORD_WINDOW_S;
  }

  async check(key: string): Promise<PasswordAttemptState> {
    try {
      const [count, ttl] = await Promise.all([
        this.redis.get(SHARE_PASSWORD_KEY_PREFIX + key),
        this.redis.ttl(SHARE_PASSWORD_KEY_PREFIX + key),
      ]);
      const failures = Number(count ?? 0);
      return {
        failures,
        blocked: failures >= this.maxFailures,
        retryAfterS: failures > 0 && ttl > 0 ? ttl : 0,
      };
    } catch (error) {
      this.log?.warn({ err: error }, "share password limiter unavailable (redis)");
      return { failures: 0, blocked: false, retryAfterS: 0 };
    }
  }

  async fail(key: string): Promise<void> {
    try {
      const count = await this.redis.incr(SHARE_PASSWORD_KEY_PREFIX + key);
      if (count === 1) await this.redis.expire(SHARE_PASSWORD_KEY_PREFIX + key, this.windowS);
    } catch (error) {
      this.log?.warn({ err: error }, "share password failure not recorded (redis)");
    }
  }
}

/** Entries the in-memory limiter keeps at most (expired ones are dropped first, then the oldest). */
export const MEMORY_LIMITER_MAX_KEYS = 10_000;

/**
 * The limiter without Redis: per process, a fixed window per token. Good for a single
 * server; several servers each allow the limit on their own.
 */
export class MemorySharePasswordLimiter implements SharePasswordLimiter {
  private readonly entries = new Map<string, { failures: number; resetAt: number }>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly clock: () => Date;

  constructor(
    options: LimiterOptions & { maxKeys?: number | undefined } = {},
    private readonly maxKeys = options.maxKeys ?? MEMORY_LIMITER_MAX_KEYS,
  ) {
    this.maxFailures = options.maxFailures ?? SHARE_PASSWORD_MAX_FAILURES;
    this.windowMs = (options.windowS ?? SHARE_PASSWORD_WINDOW_S) * 1000;
    this.clock = options.now ?? (() => new Date());
  }

  async check(key: string): Promise<PasswordAttemptState> {
    const now = this.clock().getTime();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (entry) this.entries.delete(key);
      return { failures: 0, blocked: false, retryAfterS: 0 };
    }
    return {
      failures: entry.failures,
      blocked: entry.failures >= this.maxFailures,
      retryAfterS: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }

  async fail(key: string): Promise<void> {
    const now = this.clock().getTime();
    const entry = this.entries.get(key);
    if (entry && entry.resetAt > now) {
      entry.failures++;
      return;
    }
    if (this.entries.size >= this.maxKeys) this.evict(now);
    this.entries.set(key, { failures: 1, resetAt: now + this.windowMs });
  }

  /** How many tokens are being tracked (tests). */
  get size(): number {
    return this.entries.size;
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** `true` when `redis` can serve as the limiter's store (an ioredis client, not just a `RedisLike`). */
export function isLimiterRedis(redis: unknown): redis is LimiterRedis {
  const candidate = redis as Partial<LimiterRedis> | null | undefined;
  return (
    typeof candidate?.incr === "function" &&
    typeof candidate.expire === "function" &&
    typeof candidate.get === "function" &&
    typeof candidate.ttl === "function"
  );
}

/**
 * Unlock tokens of the `keyring` provider (plan 6.2; Notes `unlock.py` taken as it is). An
 * unlock is a Redis entry
 *
 *     vola:unlock:<token>  →  {tenant_id, principal, keyring_id, mk}   EX <ttl>
 *
 * where `token` is 32 random bytes (base64url) and `mk` the keyring's master key WRAPPED
 * under the active line of `VOLA_KEY_FILE` (`crypto/keyring.ts` `wrapForStore`, bound to
 * the token), so a dump of Redis on its own opens nothing. The TTL (`VOLA_UNLOCK_TTL_S`,
 * default 150 s) SLIDES: every request that resolves the token starts the count again;
 * `GET …/status` reads the remaining time without sliding. An index set
 * `vola:unlock-index:<tenant>:<principal>` lists a principal's live tokens so a PIN change, a
 * recovery or a reset can drop every one of them at once (`dropAll`). The same client holds
 * the per-principal attempt mutex (`SET NX EX 15`) the brute-force counter needs.
 *
 * Every failure to resolve — no token, an unknown one, an expired one, one of another tenant,
 * principal or keyring, a damaged entry — is the SAME `null` (→ `423 vola_locked`); a Redis
 * that does not answer is `EncryptionUnavailableError` (→ `503`): without Redis the keyring
 * provider does not exist.
 */
import { randomBytes } from "node:crypto";
import { DEFAULT_UNLOCK_TTL_S } from "@vola/core";
import type { FastifyBaseLogger } from "fastify";
import type { Redis } from "ioredis";
import {
  EncryptionUnavailableError,
  IntegrityError,
  type KeySource,
  tokenFingerprint,
  unwrapFromStore,
  wrapForStore,
} from "../crypto/index.js";

export const UNLOCK_KEY_PREFIX = "vola:unlock:";
export const UNLOCK_INDEX_PREFIX = "vola:unlock-index:";
export const ATTEMPT_LOCK_PREFIX = "vola:attempt-lock:";
/** Seconds one PIN check may hold the per-principal mutex (an Argon2 run is far shorter). */
export const ATTEMPT_LOCK_S = 15;
/** Life of an index set: long enough to outlive any token in it. */
export const UNLOCK_INDEX_TTL_S = 86_400;
export const TOKEN_BYTES = 32;

/** The subset of ioredis the store uses (`isUnlockRedis` recognises a client). */
export type UnlockRedis = Pick<
  Redis,
  "get" | "set" | "del" | "expire" | "ttl" | "sadd" | "srem" | "smembers"
>;

/** `true` when `redis` is a client the store can run on (an ioredis `Redis`). */
export function isUnlockRedis(redis: unknown): redis is UnlockRedis {
  const c = redis as Partial<UnlockRedis> | null | undefined;
  return (
    typeof c?.get === "function" &&
    typeof c.set === "function" &&
    typeof c.del === "function" &&
    typeof c.expire === "function" &&
    typeof c.ttl === "function" &&
    typeof c.sadd === "function" &&
    typeof c.srem === "function" &&
    typeof c.smembers === "function"
  );
}

/** Who a token belongs to. */
export interface UnlockPrincipal {
  tenantId: string;
  principal: string;
}

export interface OpenUnlockInput extends UnlockPrincipal {
  keyringId: string;
  /** The master key; copied into the entry wrapped, never kept here. */
  mk: Buffer;
}

export interface OpenedUnlock {
  token: string;
  /** Seconds the token lives from now (the TTL). */
  expiresIn: number;
}

export interface ResolvedUnlock {
  keyringId: string;
  mk: Buffer;
}

interface Entry {
  tenant_id: string;
  principal: string;
  keyring_id: string;
  /** base64 of `wrapForStore(...)`. */
  mk: string;
}

export interface UnlockStoreOptions {
  redis: UnlockRedis;
  /** The key file the master key is wrapped under while it sits in Redis. */
  keys: KeySource;
  /** `VOLA_UNLOCK_TTL_S`. Default 150. */
  ttlS?: number | undefined;
  logger?: FastifyBaseLogger | undefined;
}

export class UnlockStore {
  readonly ttlS: number;
  private readonly redis: UnlockRedis;
  private readonly keys: KeySource;
  private readonly logger: FastifyBaseLogger | undefined;

  constructor(options: UnlockStoreOptions) {
    this.redis = options.redis;
    this.keys = options.keys;
    this.ttlS = options.ttlS ?? DEFAULT_UNLOCK_TTL_S;
    this.logger = options.logger;
  }

  /** `503` unless Redis answers (the keyring routes check it before anything else). */
  async assertAvailable(): Promise<void> {
    await this.call(() => this.redis.ttl(`${UNLOCK_KEY_PREFIX}probe`));
    await this.keys.lines();
  }

  /** Issues a token for `mk`; the entry holds the key wrapped under the active key-file line. */
  async open(input: OpenUnlockInput): Promise<OpenedUnlock> {
    const [active] = await this.keys.lines();
    if (!active) throw new EncryptionUnavailableError("no active key line");
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const entry: Entry = {
      tenant_id: input.tenantId,
      principal: input.principal,
      keyring_id: input.keyringId,
      mk: wrapForStore(active, input.mk, input.tenantId, Buffer.from(token)).toString("base64"),
    };
    const index = indexKey(input);
    await this.call(async () => {
      await this.redis.set(UNLOCK_KEY_PREFIX + token, JSON.stringify(entry), "EX", this.ttlS);
      await this.redis.sadd(index, token);
      await this.redis.expire(index, UNLOCK_INDEX_TTL_S);
    });
    this.logger?.info(
      { keyring: input.keyringId, token: tokenFingerprint(token), ttl_s: this.ttlS },
      "keyring unlocked",
    );
    return { token, expiresIn: this.ttlS };
  }

  /**
   * The master key behind `token` for `who`, sliding the TTL (unless `slide: false`); `null`
   * for every token that is not exactly theirs. The caller zeroes the key when done.
   */
  async resolve(
    token: string | null | undefined,
    who: UnlockPrincipal,
    options: { slide?: boolean } = {},
  ): Promise<ResolvedUnlock | null> {
    if (!token || !isTokenShaped(token)) return null;
    const entry = await this.entryOf(token, who);
    if (!entry) return null;
    let mk: Buffer;
    try {
      mk = unwrapFromStore(
        await this.keys.lines(),
        Buffer.from(entry.mk, "base64"),
        who.tenantId,
        Buffer.from(token),
      );
    } catch (error) {
      if (!(error instanceof IntegrityError)) throw error;
      this.logger?.warn(
        { token: tokenFingerprint(token), reason: error.reason },
        "unlock entry does not open",
      );
      return null;
    }
    if (options.slide !== false) {
      await this.call(() => this.redis.expire(UNLOCK_KEY_PREFIX + token, this.ttlS));
    }
    return { keyringId: entry.keyring_id, mk };
  }

  /** Seconds `token` still lives for `who`, WITHOUT sliding; `null` when it is not theirs or gone. */
  async expiresIn(token: string | null | undefined, who: UnlockPrincipal): Promise<number | null> {
    if (!token || !isTokenShaped(token)) return null;
    const entry = await this.entryOf(token, who);
    if (!entry) return null;
    const ttl = await this.call(() => this.redis.ttl(UNLOCK_KEY_PREFIX + token));
    return ttl > 0 ? ttl : null;
  }

  /** Forgets `token`, whoever's it is (holding it is the whole authority); idempotent. */
  async drop(token: string | null | undefined): Promise<boolean> {
    if (!token || !isTokenShaped(token)) return false;
    return this.call(async () => {
      const raw = await this.redis.get(UNLOCK_KEY_PREFIX + token);
      const entry = parseEntry(raw);
      const removed = await this.redis.del(UNLOCK_KEY_PREFIX + token);
      if (entry) {
        await this.redis.srem(
          indexKey({ tenantId: entry.tenant_id, principal: entry.principal }),
          token,
        );
      }
      if (removed > 0) {
        this.logger?.info({ token: tokenFingerprint(token) }, "keyring locked");
      }
      return removed > 0;
    });
  }

  /** Forgets every live token of `who` (PIN change, recovery, reset); returns how many. */
  async dropAll(who: UnlockPrincipal): Promise<number> {
    return this.call(async () => {
      const index = indexKey(who);
      const tokens = await this.redis.smembers(index);
      let dropped = 0;
      for (const token of tokens) dropped += await this.redis.del(UNLOCK_KEY_PREFIX + token);
      await this.redis.del(index);
      if (tokens.length > 0)
        this.logger?.info({ dropped }, "every unlock of the principal dropped");
      return dropped;
    });
  }

  /** Takes the per-principal attempt mutex; `false` when another PIN check holds it. */
  async acquireAttemptLock(who: UnlockPrincipal): Promise<boolean> {
    const result = await this.call(() =>
      this.redis.set(attemptLockKey(who), "1", "EX", ATTEMPT_LOCK_S, "NX"),
    );
    return result === "OK";
  }

  async releaseAttemptLock(who: UnlockPrincipal): Promise<void> {
    await this.call(() => this.redis.del(attemptLockKey(who)));
  }

  /** The entry of `token` when it is `who`'s; `null` otherwise (never says why). */
  private async entryOf(token: string, who: UnlockPrincipal): Promise<Entry | null> {
    const raw = await this.call(() => this.redis.get(UNLOCK_KEY_PREFIX + token));
    const entry = parseEntry(raw);
    if (!entry) return null;
    if (entry.tenant_id !== who.tenantId || entry.principal !== who.principal) return null;
    return entry;
  }

  /** Runs one Redis operation; a client that does not answer is `EncryptionUnavailableError`. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.logger?.warn({ err: error }, "unlock store unavailable (redis)");
      throw new EncryptionUnavailableError("the unlock store (redis) does not answer");
    }
  }
}

/** 32 bytes as base64url: 43 characters of the url-safe alphabet. */
export function isTokenShaped(token: string): boolean {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

function indexKey(who: UnlockPrincipal): string {
  return `${UNLOCK_INDEX_PREFIX}${who.tenantId}:${who.principal}`;
}

function attemptLockKey(who: UnlockPrincipal): string {
  return `${ATTEMPT_LOCK_PREFIX}${who.tenantId}:${who.principal}`;
}

function parseEntry(raw: string | null): Entry | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Entry>;
    if (
      typeof value.tenant_id !== "string" ||
      typeof value.principal !== "string" ||
      typeof value.keyring_id !== "string" ||
      typeof value.mk !== "string"
    ) {
      return null;
    }
    return value as Entry;
  } catch {
    return null;
  }
}

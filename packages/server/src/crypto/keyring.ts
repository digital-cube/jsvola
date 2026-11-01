/**
 * The `keyring` provider's pure parts (plan 6.2, `docs/CRYPTO.md` § keyring; the Notes model
 * of `docs/notes-crypto-for-vola.md` § 1, § 3, § 6.5, taken as it is). No I/O here: the
 * service (`services/keyrings.ts`) owns the rows, the Redis store (`services/unlock.ts`) the
 * tokens.
 *
 * ```
 * PIN          ──Argon2id(salt, secret = pepper)──► KEK_pin ──AES-256-GCM──► mk_pin_ct
 * recovery key ──Argon2id(recovery_salt, pepper)──► KEK_rec ──AES-256-GCM──► mk_recovery_ct
 * MK (32 B random, one per keyring) ──AES-256-GCM, AAD "<file id>:key:keyring:<keyring id>"──► fk_ct
 * ```
 *
 * The pepper is a line of `VOLA_PEPPER_FILE` (same format as the key file: base64 32-byte
 * lines, the first active): with it a database dump cannot even start a brute force over the
 * 10⁶ PINs; without the pepper file the provider is unavailable. Rotation is prepending a
 * line; an unlock tries every line and re-wraps under the active one when an older one
 * opened (the lazy rule of the tenant provider). The Argon2 parameters are stored PER KEYRING
 * (`KeyringKdf`), so raising them changes new wraps only.
 */
import { createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  PIN_LENGTH,
  type PinInvalidReason,
  RECOVERY_KEY_BYTES,
  RECOVERY_KEY_GROUP_LENGTH,
  RECOVERY_KEY_GROUPS,
} from "@vola/core";
import argon2 from "argon2";
import type { KeyringKdf } from "../db/schema.js";
import { aeadOpen, aeadSeal, assertKey, KEY_BYTES, NONCE_BYTES, TAG_BYTES } from "./aead.js";
import { IntegrityError, LockedError } from "./errors.js";
import { type KeyLine, KID_BYTES, keyId } from "./tenant.js";
import { type Unwrapped, type WrapContext, type WrapProvider, wrapAad } from "./wrap.js";

// --- Argon2id ----------------------------------------------------------------------------

/** RFC 9106's second recommended profile: 64 MiB, 3 passes, 1 lane — what Notes runs. */
export const ARGON2_MEMORY_KIB = 65536;
export const ARGON2_ITERATIONS = 3;
export const ARGON2_LANES = 1;
export const SALT_BYTES = 16;
export const DEFAULT_PEPPER_FILE = "/run/secrets/vola.pepper";

/** The cost parameters of a KDF; the defaults are the constants above. */
export interface KdfCost {
  m: number;
  t: number;
  p: number;
}

export const DEFAULT_KDF_COST: KdfCost = {
  m: ARGON2_MEMORY_KIB,
  t: ARGON2_ITERATIONS,
  p: ARGON2_LANES,
};

/** A fresh `kdf` record for a keyring: a random salt and the cost given (default: the constants). */
export function freshKdf(pepper: KeyLine, cost: KdfCost = DEFAULT_KDF_COST): KeyringKdf {
  return {
    alg: "argon2id",
    salt: randomBytes(SALT_BYTES).toString("base64"),
    m: cost.m,
    t: cost.t,
    p: cost.p,
    pepper_line: pepper.kid.toString("hex"),
  };
}

/** The salt of a `kdf` record as bytes; `IntegrityError` for a record that is not one. */
export function kdfSalt(kdf: KeyringKdf): Buffer {
  if (kdf.alg !== "argon2id" || typeof kdf.salt !== "string") {
    throw new IntegrityError("kdf record is not argon2id");
  }
  const salt = Buffer.from(kdf.salt, "base64");
  if (salt.length !== SALT_BYTES) throw new IntegrityError("kdf salt has the wrong length");
  return salt;
}

/**
 * KEK = Argon2id(`secret` as UTF-8, `salt`, pepper as the Argon2 `secret`, `cost`) → 32 B.
 * Runs in libuv's thread pool (node-argon2), never on the event loop.
 */
export async function deriveKek(
  secret: string,
  salt: Buffer,
  pepper: Buffer,
  cost: KdfCost,
): Promise<Buffer> {
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_BYTES) {
    throw new TypeError(`salt must be ${SALT_BYTES} bytes`);
  }
  return argon2.hash(secret, {
    raw: true,
    type: argon2.argon2id,
    salt,
    secret: assertKey(pepper, "pepper"),
    memoryCost: cost.m,
    timeCost: cost.t,
    parallelism: cost.p,
    hashLength: KEY_BYTES,
  });
}

// --- the master key ----------------------------------------------------------------------

/** A fresh 32-byte master key. */
export function newMasterKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** `<keyring id>:mk:pin` / `<keyring id>:mk:recovery` — a wrap cannot move between keyrings or purposes. */
export function mkAad(keyringId: string, purpose: "pin" | "recovery"): Buffer {
  return Buffer.from(`${keyringId}:mk:${purpose}`, "utf8");
}

/** MK → `nonce ∥ ct ∥ tag` (60 B) under `kek`, bound to `aad`. */
export function wrapMasterKey(kek: Buffer, mk: Buffer, aad: Buffer): Buffer {
  return aeadSeal(kek, assertKey(mk, "master key"), aad);
}

/** The inverse of `wrapMasterKey`; `IntegrityError` for a wrong KEK — which is "a wrong PIN". */
export function unwrapMasterKey(kek: Buffer, ct: Buffer, aad: Buffer): Buffer {
  const mk = aeadOpen(kek, ct, aad);
  if (mk.length !== KEY_BYTES) throw new IntegrityError("master key has the wrong length");
  return mk;
}

/** The length of a wrapped master key. */
export const MK_CT_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES;

// --- the PIN -----------------------------------------------------------------------------

/**
 * Why `pin` is not acceptable, or `null` when it is: exactly `PIN_LENGTH` ASCII digits
 * (`length`, `digits`), and not trivial (`trivial`: all the same digit, or a run going up
 * or down by one — `123456`, `654321`, `000000`). The same words as the Notes client.
 */
export function pinInvalidReason(pin: string): PinInvalidReason | null {
  if (typeof pin !== "string" || pin.length !== PIN_LENGTH) return "length";
  if (!/^[0-9]+$/.test(pin)) return "digits";
  if (isTrivialPin(pin)) return "trivial";
  return null;
}

/** All the same digit, or consecutive digits up or down (`123456`, `987654`). */
export function isTrivialPin(pin: string): boolean {
  const digits = [...pin].map(Number);
  if (digits.every((d) => d === digits[0])) return true;
  const up = digits.every((d, i) => i === 0 || d === (digits[i - 1] as number) + 1);
  const down = digits.every((d, i) => i === 0 || d === (digits[i - 1] as number) - 1);
  return up || down;
}

/** Only the SHAPE (length and digits): what an unlock checks before touching the keyring — a PIN entered is compared, not judged. */
export function hasPinShape(pin: unknown): pin is string {
  return typeof pin === "string" && pin.length === PIN_LENGTH && /^[0-9]+$/.test(pin);
}

// --- the recovery key --------------------------------------------------------------------

/** RFC 4648 base32 alphabet. */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_KEY_CHARS = RECOVERY_KEY_GROUPS * RECOVERY_KEY_GROUP_LENGTH;

/** `bytes` as base32 without padding. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * A fresh recovery key: 160 random bits as 32 base32 characters in 8 groups of 4, joined
 * with `-` (`K7QM-2P9X-…`). Shown to the user ONCE; never stored.
 */
export function newRecoveryKey(): string {
  const chars = base32Encode(randomBytes(RECOVERY_KEY_BYTES));
  const groups: string[] = [];
  for (let i = 0; i < RECOVERY_KEY_GROUPS; i++) {
    groups.push(chars.slice(i * RECOVERY_KEY_GROUP_LENGTH, (i + 1) * RECOVERY_KEY_GROUP_LENGTH));
  }
  return groups.join("-");
}

/**
 * What the user typed, as the key it means: upper case, spaces and dashes dropped, `0` read
 * as `O` and `1` as `I` (neither is in the alphabet, both are what a person types for them).
 */
export function normalizeRecoveryKey(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I");
}

/** `true` when the normalised key has the right length and alphabet (what is checked before any KDF runs). */
export function isRecoveryKeyShaped(normalized: string): boolean {
  return normalized.length === RECOVERY_KEY_CHARS && /^[A-Z2-7]+$/.test(normalized);
}

// --- brute force -------------------------------------------------------------------------

/** Wrong PINs that cost no waiting (`attempts < FREE_ATTEMPTS`). */
export const FREE_ATTEMPTS = 3;
/** From this many wrong PINs in a row the lock-out is an hour, doubling with each one. */
export const LOCKOUT_AT = 10;
export const LOCKOUT_BASE_S = 3600;
/** The waits before the lock-out, by attempt (index = attempts; the first two are free). */
const EARLY_DELAYS_S: readonly number[] = [0, 0, 0, 1, 5];
const PLATEAU_S = 30;
/** Beyond this the doubling would overflow a Date; two years is "forever" for a PIN. */
const MAX_DELAY_S = 2 * 365 * 24 * 3600;

/**
 * How long the keyring stays locked after `attempts` wrong PINs in a row — the Notes table
 * (`crypto.py::attempt_delay_s`): 1–2 → 0, 3 → 1 s, 4 → 5 s, 5–9 → 30 s, 10 → 1 h, then
 * doubling (11 → 2 h, 12 → 4 h, …).
 */
export function attemptDelayS(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts <= 0) return 0;
  if (attempts < EARLY_DELAYS_S.length) return EARLY_DELAYS_S[attempts] as number;
  if (attempts < LOCKOUT_AT) return PLATEAU_S;
  const doublings = attempts - LOCKOUT_AT;
  if (doublings > 40) return MAX_DELAY_S;
  return Math.min(MAX_DELAY_S, LOCKOUT_BASE_S * 2 ** doublings);
}

// --- the file key under the master key --------------------------------------------------

/** `nonce (12) ∥ ct (32) ∥ tag (16)` = 60 bytes: a file key wrapped under a master key. */
export const KEYRING_FK_CT_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES;

/**
 * The `keyring` provider: FK under the keyring's master key, AAD
 * `<file id>:key:keyring:<keyring id>`. The master key arrives in `ctx.unlock` — resolved
 * from the request's `X-Vola-Unlock` by the service — and `ctx.keyringId` names the keyring;
 * without either the file is simply locked (`LockedError` → `423`). There is no key hint and
 * no lazy re-wrap: a master key never rotates (a PIN change re-wraps the MASTER key, not a
 * file key), so an `fk_ct` written once is final until the row is gone.
 */
export class KeyringWrapProvider implements WrapProvider {
  readonly mode = "keyring" as const;

  async wrap(fk: Buffer, ctx: WrapContext): Promise<Buffer> {
    const { mk, keyringId } = material(ctx);
    return aeadSeal(mk, assertKey(fk, "file key"), wrapAad(this.mode, ctx.fileId, keyringId));
  }

  async unwrap(fkCt: Buffer, ctx: WrapContext): Promise<Unwrapped> {
    if (!Buffer.isBuffer(fkCt) || fkCt.length !== KEYRING_FK_CT_BYTES) {
      throw new IntegrityError("wrapped key has the wrong length");
    }
    const { mk, keyringId } = material(ctx);
    return { fk: aeadOpen(mk, fkCt, wrapAad(this.mode, ctx.fileId, keyringId)) };
  }
}

function material(ctx: WrapContext): { mk: Buffer; keyringId: string } {
  if (!ctx.keyringId) throw new LockedError("no keyring for this file");
  if (!ctx.unlock) throw new LockedError("no unlock for this keyring");
  return { mk: assertKey(ctx.unlock, "master key"), keyringId: ctx.keyringId };
}

// --- the master key in Redis -------------------------------------------------------------

/** The HKDF salt of the key the key file wraps unlock entries with. */
export const UNLOCK_KEK_SALT = "vola-unlock-kek";

/** HKDF-SHA256(key line, salt `vola-unlock-kek`, info = tenant id) → 32 B. */
export function deriveUnlockKek(keyLine: Buffer, tenantId: string): Buffer {
  if (!tenantId) throw new TypeError("a tenant id is required");
  return Buffer.from(
    hkdfSync("sha256", assertKey(keyLine, "key line"), UNLOCK_KEK_SALT, tenantId, KEY_BYTES),
  );
}

/**
 * MK → `kid (4) ∥ nonce ∥ ct ∥ tag` under the ACTIVE line of `VOLA_KEY_FILE` (the tenant
 * provider's file), bound to `aad` (the token): what the unlock store keeps in Redis, so a
 * dump of Redis without the key file opens nothing.
 */
export function wrapForStore(line: KeyLine, mk: Buffer, tenantId: string, aad: Buffer): Buffer {
  return Buffer.concat([
    line.kid,
    aeadSeal(deriveUnlockKek(line.key, tenantId), assertKey(mk, "master key"), aad),
  ]);
}

/** The inverse of `wrapForStore`, trying the hinted line first and then every other one. */
export function unwrapFromStore(
  lines: readonly KeyLine[],
  sealed: Buffer,
  tenantId: string,
  aad: Buffer,
): Buffer {
  if (!Buffer.isBuffer(sealed) || sealed.length !== KID_BYTES + MK_CT_BYTES) {
    throw new IntegrityError("stored master key has the wrong length");
  }
  const kid = sealed.subarray(0, KID_BYTES);
  const body = sealed.subarray(KID_BYTES);
  const order = [
    ...lines.filter((l) => l.kid.equals(kid)),
    ...lines.filter((l) => !l.kid.equals(kid)),
  ];
  for (const line of order) {
    try {
      return aeadOpen(deriveUnlockKek(line.key, tenantId), body, aad);
    } catch (error) {
      if (error instanceof IntegrityError) continue;
      throw error;
    }
  }
  throw new IntegrityError("stored master key opens under no key line");
}

/** `true` when two secrets of the same length are equal, in constant time. */
export function secretsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The `kid` of a pepper line as `KeyringKdf.pepper_line` stores it. */
export function pepperLineId(pepper: Buffer): string {
  return keyId(pepper).toString("hex");
}

/** SHA-256 of a token, hex: how an unlock token appears in a log line (never the token). */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

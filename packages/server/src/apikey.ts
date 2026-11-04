import { createHash, timingSafeEqual as nodeTimingSafeEqual, randomBytes } from "node:crypto";
import { KEY_SECRET_LENGTH, type KeyEnv, type KeyPrefix, parseApiKey } from "@vol-a/core";

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** `length` uniformly distributed base62 characters from `crypto.randomBytes` (rejection sampling). */
export function randomBase62(length: number): string {
  const limit = 256 - (256 % BASE62.length); // 248: bytes ≥ 248 would skew the distribution
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out += BASE62[byte % BASE62.length];
    }
  }
  return out;
}

export interface GeneratedApiKey {
  /** The plaintext `vola_<env>_<32 base62>`: shown once, never stored. */
  key: string;
  prefix: KeyPrefix;
  last4: string;
  /** SHA-256 of `key`, lowercase hex: what the database stores. */
  keyHash: string;
}

/** Mints a key for `env`. */
export function generateApiKey(env: KeyEnv): GeneratedApiKey {
  const key = `vola_${env}_${randomBase62(KEY_SECRET_LENGTH)}`;
  const parts = parseApiKey(key);
  if (!parts) throw new Error("generated key does not match the key format");
  return { key, prefix: parts.prefix, last4: parts.last4, keyHash: hashApiKey(key) };
}

/** SHA-256 of the plaintext as lowercase hex. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && nodeTimingSafeEqual(left, right);
}

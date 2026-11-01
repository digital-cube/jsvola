/**
 * AES-256-GCM through `node:crypto`, the only primitive this package uses: a 32-byte key, a
 * 12-byte nonce, a 16-byte tag, additional authenticated data on every call. Nothing here is
 * home-made cryptography; this file only fixes the byte layout the rest of the package shares.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { IntegrityError } from "./errors.js";

export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

/** A fresh 32-byte key (`FK`): `randomBytes`, never derived, never reused for another file. */
export function newFileKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Throws unless `key` is exactly 32 bytes. */
export function assertKey(key: Buffer, what = "key"): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new TypeError(`${what} must be ${KEY_BYTES} bytes`);
  }
  return key;
}

/** `ct ∥ tag` of `plaintext` under `key`, `nonce` and `aad` (the nonce is NOT included). */
export function gcmEncrypt(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ct = cipher.update(plaintext);
  cipher.final();
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

/** The plaintext of `ct ∥ tag`; `IntegrityError` when the tag does not verify. */
export function gcmDecrypt(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new IntegrityError("ciphertext shorter than a tag");
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    const plain = decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES));
    decipher.final();
    return plain;
  } catch {
    throw new IntegrityError("authentication tag mismatch");
  }
}

/**
 * A self-contained sealed record: `nonce(12) ∥ ct ∥ tag(16)` with a random nonce, bound to
 * `aad`. Used for the wrapped file key and for the encrypted metadata — small records whose
 * nonce has to travel with them.
 */
export function aeadSeal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  return Buffer.concat([nonce, gcmEncrypt(assertKey(key), nonce, plaintext, aad)]);
}

/** Opens what `aeadSeal` produced; `IntegrityError` for a short record or a bad tag. */
export function aeadOpen(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (!Buffer.isBuffer(sealed) || sealed.length < NONCE_BYTES + TAG_BYTES) {
    throw new IntegrityError("sealed record too short");
  }
  return gcmDecrypt(
    assertKey(key),
    sealed.subarray(0, NONCE_BYTES),
    sealed.subarray(NONCE_BYTES),
    aad,
  );
}

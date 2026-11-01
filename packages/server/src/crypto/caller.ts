/**
 * The `caller` wrap provider (plan 6.3, `docs/CRYPTO.md` § 9): the file key is wrapped under
 * a 32-byte key the CALLER sends with every request in `X-Vola-Content-Key`, and the server
 * keeps nothing but `fk_ct`. There is no key file line, no keyring, no Redis entry: a dump of
 * everything vola holds — database, disk, Redis, key file, pepper file — opens no `caller`
 * file. The flip side (`notes-crypto-for-vola.md` § 6.3): recovery, rotation, a share grant
 * made by the server and a derivative made by the worker do not exist for this mode; the
 * caller is the key management.
 *
 * `fk_ct` = `nonce (12) ∥ ct (32) ∥ tag (16)` = 60 B under the caller key, AAD
 * `<file id>:key:caller:<tenant id>`. A wrong key is an `IntegrityError` (→ the one fixed
 * `409 vola_integrity` sentence); a request without the key is a `LockedError` (→ `423
 * vola_locked`, the same answer a `keyring` file gives without its unlock). Nothing here logs,
 * stores or copies the key beyond the one request; the auth layer zeroes it afterwards.
 */
import { aeadOpen, aeadSeal, assertKey, KEY_BYTES, NONCE_BYTES, TAG_BYTES } from "./aead.js";
import { IntegrityError, LockedError } from "./errors.js";
import { type Unwrapped, type WrapContext, type WrapProvider, wrapAad } from "./wrap.js";

/** `nonce (12) ∥ ct (32) ∥ tag (16)`. */
export const CALLER_FK_CT_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES;

/**
 * Parses `X-Vola-Content-Key`: standard or URL-safe base64 of exactly 32 bytes. `null` for an
 * absent header; `RangeError` for anything that is not a key (the route answers `400`).
 */
export function parseContentKey(raw: string | null | undefined): Buffer | null {
  if (raw === undefined || raw === null) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    throw new RangeError("X-Vola-Content-Key: base64 of 32 bytes is required");
  }
  const key = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== KEY_BYTES) {
    throw new RangeError("X-Vola-Content-Key: base64 of 32 bytes is required");
  }
  return key;
}

/** The `caller` provider (see the module comment). */
export class CallerWrapProvider implements WrapProvider {
  readonly mode = "caller" as const;

  async wrap(fk: Buffer, ctx: WrapContext): Promise<Buffer> {
    const key = requireCallerKey(ctx);
    return aeadSeal(key, assertKey(fk, "file key"), wrapAad(this.mode, ctx.fileId, ctx.tenantId));
  }

  async unwrap(fkCt: Buffer, ctx: WrapContext): Promise<Unwrapped> {
    if (!Buffer.isBuffer(fkCt) || fkCt.length !== CALLER_FK_CT_BYTES) {
      throw new IntegrityError("wrapped key has the wrong length");
    }
    const key = requireCallerKey(ctx);
    const fk = aeadOpen(key, fkCt, wrapAad(this.mode, ctx.fileId, ctx.tenantId));
    if (fk.length !== KEY_BYTES) throw new IntegrityError("file key has the wrong length");
    // Never `rewrapped`: there is no "active key" to move to — the caller holds the only one.
    return { fk };
  }
}

function requireCallerKey(ctx: WrapContext): Buffer {
  if (!ctx.callerKey) throw new LockedError("no caller key on this request");
  return assertKey(ctx.callerKey, "caller key");
}

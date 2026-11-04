/**
 * How a file key is wrapped — the ONE thing the three encryption modes differ in. The blob
 * format (`format.ts`) and the metadata record (`meta.ts`) are the same under every mode;
 * a provider only turns `FK` into `fk_ct` and back:
 *
 * - `tenant` (this phase, `tenant.ts`): under a KEK derived from the server's key file and
 *   the tenant id — protects a dump of disk and database;
 * - `keyring` (phase 6.2): under a principal's master key, itself behind a PIN;
 * - `caller` (phase 6.3, `caller.ts`): under a key the caller sends with every request, kept
 *   nowhere.
 *
 * `client` (6.3) has NO provider: the client wrapped the key itself and the server never opens
 * it — `fk_ct` and the blob are opaque bytes handed back as they came.
 *
 * The wrap AAD is `<file id>:key:<mode>:<tenant id | keyring id>`, so an `fk_ct` cannot be
 * moved to another file, another mode or another tenant: a transfer between tenants has to
 * re-wrap (`services/transfer.ts`).
 */
import type { FileEncryption } from "@vol-a/core";

/** What a provider needs to know about the request and the file; request-scoped material joins later. */
export interface WrapContext {
  fileId: string;
  tenantId: string;
  /** Phase 6.2: the keyring an `encryption = keyring` file belongs to. */
  keyringId?: string | null | undefined;
  /** Phase 6.2: the unlock token's material (the master key of the keyring). */
  unlock?: Buffer | undefined;
  /** Phase 6.3: the 32-byte key the caller sent in `X-Vola-Content-Key`. */
  callerKey?: Buffer | undefined;
}

export interface Unwrapped {
  fk: Buffer;
  /**
   * A fresh `fk_ct` under the CURRENT key when the stored one used an older key (the key
   * file was rotated): the caller stores it, so old keys retire lazily (the Notes pepper rule).
   */
  rewrapped?: Buffer | undefined;
}

export interface WrapProvider {
  readonly mode: FileEncryption;
  /** `fk` → `fk_ct`, bound to `ctx` through the AAD. */
  wrap(fk: Buffer, ctx: WrapContext): Promise<Buffer>;
  /** `fk_ct` → `fk`; `IntegrityError` when it does not open under this context. */
  unwrap(fkCt: Buffer, ctx: WrapContext): Promise<Unwrapped>;
}

/** `<file id>:key:<mode>:<scope>` — the scope is the tenant id (`tenant`, `caller`) or the keyring id (`keyring`). */
export function wrapAad(mode: FileEncryption, fileId: string, scopeId: string): Buffer {
  return Buffer.from(`${fileId}:key:${mode}:${scopeId}`, "utf8");
}

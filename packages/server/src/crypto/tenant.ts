/**
 * The `tenant` wrap provider — encryption at rest with a key the SERVER holds.
 *
 * `VOLA_KEY_FILE` (default `/run/secrets/vola.key`) holds one base64 32-byte key per line;
 * the FIRST line is the active key, every other line is an older one that still opens what
 * it wrapped. Rotation is prepending a line (`docs/CRYPTO.md`): a wrapped key that opens
 * with an older line is handed back re-wrapped under the active one and the caller stores it,
 * so old lines retire lazily — exactly the pepper rule of the Notes model this follows.
 *
 * KEK of a tenant = HKDF-SHA256(key line, salt `vola-tenant-kek`, info = tenant id, 32 B):
 * one file, one KEK per tenant, and an `fk_ct` of one tenant is noise under another's KEK.
 *
 * `fk_ct` = `kid (4 B) ∥ nonce (12 B) ∥ ct (32 B) ∥ tag (16 B)` = 64 bytes. `kid` is the first
 * four bytes of SHA-256(key line): a HINT which line wrapped it — `keys-status` counts them,
 * `unwrap` tries that line first and then every other one — never a secret (a key cannot be
 * recovered from its hash prefix) and not authenticated (a wrong hint just costs a try).
 *
 * Without the file nothing here works and the server still starts: every call is an
 * `EncryptionUnavailableError` (→ `503 encryption_unavailable`) until the file appears — it is
 * looked for again on every call, so no restart is needed after it is put in place.
 */
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { aeadOpen, aeadSeal, assertKey, KEY_BYTES } from "./aead.js";
import { EncryptionUnavailableError, IntegrityError } from "./errors.js";
import { type Unwrapped, type WrapContext, type WrapProvider, wrapAad } from "./wrap.js";

export const TENANT_KEK_SALT = "vola-tenant-kek";
export const KID_BYTES = 4;
export const DEFAULT_KEY_FILE = "/run/secrets/vola.key";
/** `kid (4) ∥ nonce (12) ∥ ct (32) ∥ tag (16)`. */
export const TENANT_FK_CT_BYTES = KID_BYTES + 12 + KEY_BYTES + 16;

export interface KeyLine {
  /** 0 = the active key. */
  index: number;
  key: Buffer;
  kid: Buffer;
}

/** A key file that exists but cannot be used (a line that is not a base64 32-byte key). */
export class KeyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyFileError";
  }
}

/** The first four bytes of SHA-256(key). */
export function keyId(key: Buffer): Buffer {
  return createHash("sha256").update(key).digest().subarray(0, KID_BYTES);
}

/** One fresh key line: 32 random bytes, standard base64. */
export function generateKeyLine(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/**
 * The lines of a key file: standard base64 of exactly 32 bytes each, one per line; blank
 * lines and `#` comments are skipped. `KeyFileError` for anything else, and for a file
 * without a single key.
 */
export function parseKeyFile(text: string): KeyLine[] {
  const lines: KeyLine[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, lineNo) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(line)) {
      throw new KeyFileError(`line ${lineNo + 1} is not base64`);
    }
    const key = Buffer.from(line, "base64");
    if (key.length !== KEY_BYTES) {
      throw new KeyFileError(`line ${lineNo + 1} does not decode to ${KEY_BYTES} bytes`);
    }
    const hex = key.toString("hex");
    if (seen.has(hex)) throw new KeyFileError(`line ${lineNo + 1} repeats an earlier key`);
    seen.add(hex);
    lines.push({ index: lines.length, key, kid: keyId(key) });
  });
  if (lines.length === 0) throw new KeyFileError("the key file holds no key");
  return lines;
}

/** HKDF-SHA256(key line, salt = "vola-tenant-kek", info = tenant id) → 32 bytes. */
export function deriveTenantKek(keyLine: Buffer, tenantId: string): Buffer {
  if (!tenantId) throw new TypeError("a tenant id is required");
  return Buffer.from(
    hkdfSync("sha256", assertKey(keyLine, "key line"), TENANT_KEK_SALT, tenantId, KEY_BYTES),
  );
}

/** Where the lines come from; the file by default, memory in tests. */
export interface KeySource {
  /** The parsed lines; `EncryptionUnavailableError` when there are none to be had. */
  lines(): Promise<KeyLine[]>;
}

/**
 * `VOLA_KEY_FILE` on disk, parsed once and re-read when its mtime changes (one `stat` per
 * call). A missing or unreadable file is `EncryptionUnavailableError` on every call until it
 * is fixed; a present but malformed file too (with the `KeyFileError` message in the log).
 */
export class KeyFile implements KeySource {
  private cached: { mtimeMs: number; size: number; lines: KeyLine[] } | null = null;

  constructor(
    readonly path: string,
    private readonly log?: { warn: (obj: object, msg: string) => void } | undefined,
  ) {}

  async lines(): Promise<KeyLine[]> {
    let info: { mtimeMs: number; size: number };
    try {
      const s = await stat(this.path);
      info = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (error) {
      this.cached = null;
      throw new EncryptionUnavailableError(
        `key file ${this.path} is not readable (${(error as NodeJS.ErrnoException).code ?? "error"})`,
      );
    }
    if (this.cached && this.cached.mtimeMs === info.mtimeMs && this.cached.size === info.size) {
      return this.cached.lines;
    }
    let lines: KeyLine[];
    try {
      lines = parseKeyFile(await readFile(this.path, "utf8"));
    } catch (error) {
      this.cached = null;
      this.log?.warn({ path: this.path, err: error }, "key file unusable");
      throw new EncryptionUnavailableError(`key file ${this.path} is unusable`);
    }
    this.cached = { ...info, lines };
    return lines;
  }
}

/** A `KeySource` over fixed lines (tests, embedded use). */
export class StaticKeys implements KeySource {
  private readonly parsed: KeyLine[];
  constructor(lines: string[]) {
    this.parsed = parseKeyFile(lines.join("\n"));
  }
  async lines(): Promise<KeyLine[]> {
    return this.parsed;
  }
}

/** The `tenant` provider (see the module comment). */
export class TenantWrapProvider implements WrapProvider {
  readonly mode = "tenant" as const;

  constructor(readonly keys: KeySource) {}

  async wrap(fk: Buffer, ctx: WrapContext): Promise<Buffer> {
    const [active] = await this.keys.lines();
    if (!active) throw new EncryptionUnavailableError("no active key");
    return this.wrapWith(active, fk, ctx);
  }

  private wrapWith(line: KeyLine, fk: Buffer, ctx: WrapContext): Buffer {
    const kek = deriveTenantKek(line.key, ctx.tenantId);
    return Buffer.concat([
      line.kid,
      aeadSeal(kek, assertKey(fk, "file key"), wrapAad(this.mode, ctx.fileId, ctx.tenantId)),
    ]);
  }

  async unwrap(fkCt: Buffer, ctx: WrapContext): Promise<Unwrapped> {
    if (!Buffer.isBuffer(fkCt) || fkCt.length !== TENANT_FK_CT_BYTES) {
      throw new IntegrityError("wrapped key has the wrong length");
    }
    const lines = await this.keys.lines();
    const kid = fkCt.subarray(0, KID_BYTES);
    const sealed = fkCt.subarray(KID_BYTES);
    const aad = wrapAad(this.mode, ctx.fileId, ctx.tenantId);
    // The hinted line first, then every other one (a hint is not trusted, only tried first).
    const order = [
      ...lines.filter((l) => l.kid.equals(kid)),
      ...lines.filter((l) => !l.kid.equals(kid)),
    ];
    for (const line of order) {
      let fk: Buffer;
      try {
        fk = aeadOpen(deriveTenantKek(line.key, ctx.tenantId), sealed, aad);
      } catch (error) {
        if (error instanceof IntegrityError) continue;
        throw error;
      }
      return line.index === 0
        ? { fk }
        : { fk, rewrapped: this.wrapWith(lines[0] as KeyLine, fk, ctx) };
    }
    throw new IntegrityError("wrapped key opens under no key line");
  }
}

/** The `kid` of an `fk_ct` the tenant provider produced (for `keys-status`). */
export function kidOf(fkCt: Buffer): Buffer {
  return fkCt.subarray(0, KID_BYTES);
}

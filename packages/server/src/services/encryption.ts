/**
 * The encryption side of the file services (plans 6.1 and 6.2; `docs/CRYPTO.md`): which
 * wrap providers exist, which mode an upload gets, how a stored row's file key and metadata
 * are opened — and how the crypto layer's failures become HTTP: `IntegrityError` →
 * `409 vola_integrity` with its one fixed sentence, `EncryptionUnavailableError` →
 * `503 encryption_unavailable`, `LockedError` → `423 vola_locked`. For a `keyring` file the
 * master key comes from the request's `X-Vola-Unlock` (the tenant context) through the
 * `UnlockStore`; a token that is not the principal's, not this keyring's, expired or absent
 * is the same `423`. Nothing here logs a name, a MIME type, a key or a token.
 */
import {
  ENCRYPTION_UNAVAILABLE_CODE,
  FILE_ENCRYPTIONS,
  type FileEncryption,
  INTEGRITY_ERROR_CODE,
  LOCKED_CODE,
} from "@vola/core";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { currentContext } from "../context.js";
import {
  DEFAULT_SEGMENT_BYTES,
  EncryptionUnavailableError,
  type FileMeta,
  INTEGRITY_MESSAGE,
  IntegrityError,
  KeyFile,
  type KeyLine,
  KeyringWrapProvider,
  type KeySource,
  KID_BYTES,
  LockedError,
  openMeta,
  TenantWrapProvider,
  type WrapContext,
  type WrapProvider,
} from "../crypto/index.js";
import type { Database } from "../db/index.js";
import { type FileRow, files, tenants } from "../db/schema.js";
import { VolaError } from "../errors.js";
import type { ResolvedUnlock, UnlockStore } from "./unlock.js";

/** The modes this release accepts on an upload (`caller` arrives with 6.3). */
export const AVAILABLE_ENCRYPTIONS: readonly FileEncryption[] = ["none", "tenant", "keyring"];

/** `423 vola_locked` — one answer for every missing, expired, foreign or wrong token. */
export function keyringLocked(): VolaError {
  return new VolaError(
    LOCKED_CODE,
    423,
    "the keyring is locked: unlock it and send the token in X-Vola-Unlock",
  );
}

/** `503 encryption_unavailable`. */
export function encryptionUnavailable(mode: string): VolaError {
  return new VolaError(
    ENCRYPTION_UNAVAILABLE_CODE,
    503,
    `encryption mode "${mode}" is not available: the server has no key material for it`,
  );
}

/** `409 vola_integrity` — always the same sentence, never a detail. */
export function integrityFailure(): VolaError {
  return new VolaError(INTEGRITY_ERROR_CODE, 409, INTEGRITY_MESSAGE);
}

/** What a stored encrypted row opens to. */
export interface OpenedFile {
  fk: Buffer;
  meta: FileMeta;
}

export interface EncryptionServiceOptions {
  db: Database;
  providers: WrapProvider[];
  /** Segment size of new blobs. Default 1 MiB. */
  segmentSize?: number | undefined;
  /** The unlock tokens of the `keyring` provider; without one that mode is `503`. */
  unlocks?: UnlockStore | null | undefined;
  logger?: FastifyBaseLogger | undefined;
}

/** What `wrapNewKey` hands back: the wrapped key and, for `keyring`, the keyring it is under. */
export interface WrappedKey {
  fkCt: Buffer;
  keyringId: string | null;
}

/**
 * The providers by mode plus the row-level operations the routes and services share. One per
 * plugin instance; the CLI builds its own for `transfer` and `keys-status`.
 */
export class EncryptionService {
  readonly db: Database;
  readonly segmentSize: number;
  /** The token store of the `keyring` provider (`null`: no Redis, the mode is `503`). */
  readonly unlocks: UnlockStore | null;
  private readonly providers = new Map<FileEncryption, WrapProvider>();
  private readonly logger: FastifyBaseLogger | undefined;

  constructor(options: EncryptionServiceOptions) {
    this.db = options.db;
    this.segmentSize = options.segmentSize ?? DEFAULT_SEGMENT_BYTES;
    this.unlocks = options.unlocks ?? null;
    this.logger = options.logger;
    for (const provider of options.providers) this.providers.set(provider.mode, provider);
  }

  /** The provider of `mode`, or `null` when the mode has none (configured) here. */
  provider(mode: FileEncryption): WrapProvider | null {
    return this.providers.get(mode) ?? null;
  }

  /**
   * The `encryption` an upload asked for: `undefined` when it named none (the folder policy
   * or the tenant default applies), `none` / `tenant` / `keyring` otherwise; `501
   * not_implemented` for `caller` (phase 6.3), `422 validation_error` for anything else.
   */
  parseMode(raw: string | undefined | null): FileEncryption | undefined {
    if (raw === undefined || raw === null || raw.trim() === "") return undefined;
    const value = raw.trim().toLowerCase();
    if (!(FILE_ENCRYPTIONS as readonly string[]).includes(value)) {
      throw new VolaError(
        "validation_error",
        422,
        `encryption: one of ${AVAILABLE_ENCRYPTIONS.join(", ")}`,
      );
    }
    const mode = value as FileEncryption;
    if (!AVAILABLE_ENCRYPTIONS.includes(mode)) {
      throw new VolaError(
        "not_implemented",
        501,
        `encryption "${mode}" arrives with a later phase (caller: 6.3)`,
      );
    }
    return mode;
  }

  /**
   * The mode of an upload: a folder policy (`policyKeyringId`, 6.2) makes it `keyring` and
   * refuses an explicit other mode (`422`); else the explicit one; else the tenant's
   * `default_encryption`.
   */
  async resolveMode(
    tenantId: string,
    explicit: FileEncryption | undefined,
    policyKeyringId: string | null = null,
  ): Promise<FileEncryption> {
    if (policyKeyringId) {
      if (explicit !== undefined && explicit !== "keyring") {
        throw new VolaError(
          "validation_error",
          422,
          `encryption: this folder's policy encrypts every upload under a keyring; "${explicit}" is not possible here`,
        );
      }
      return "keyring";
    }
    if (explicit !== undefined) return explicit;
    const [row] = await this.db
      .select({ mode: tenants.defaultEncryption })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const mode = (row?.mode ?? "none") as FileEncryption;
    return AVAILABLE_ENCRYPTIONS.includes(mode) ? mode : "none";
  }

  /**
   * Fails fast — before a single byte is staged — when `mode` cannot be served: no provider,
   * or the provider's key material is missing (`503`; for `keyring`: no Redis, no key file).
   */
  async assertAvailable(mode: FileEncryption): Promise<WrapProvider> {
    const provider = this.provider(mode);
    if (!provider) throw encryptionUnavailable(mode);
    try {
      if (provider instanceof TenantWrapProvider) await provider.keys.lines();
      if (provider instanceof KeyringWrapProvider) {
        if (!this.unlocks) throw encryptionUnavailable(mode);
        await this.unlocks.assertAvailable();
      }
    } catch (error) {
      throw this.translate(error, mode);
    }
    return provider;
  }

  /**
   * `assertAvailable` plus, for `keyring`, the unlock an upload needs: the request's token
   * must open (`423` otherwise) and, when the folder policy names a keyring, it must be THAT
   * keyring's. Checked before a byte is read. Returns the keyring the upload will be under.
   */
  async assertUploadable(mode: FileEncryption, keyringId?: string | null): Promise<string | null> {
    await this.assertAvailable(mode);
    if (mode !== "keyring") return null;
    const unlock = await this.currentUnlock();
    unlock.mk.fill(0);
    if (keyringId && keyringId !== unlock.keyringId) throw keyringLocked();
    return unlock.keyringId;
  }

  /**
   * The master key behind the request's `X-Vola-Unlock` for its `X-User-Id` and tenant.
   * Anything short of that — no context, no principal, no token, a token that is not theirs
   * or has expired — is `423 vola_locked`; Redis not answering is `503`. The caller zeroes
   * the key.
   */
  async currentUnlock(): Promise<ResolvedUnlock> {
    if (!this.unlocks) throw encryptionUnavailable("keyring");
    const context = currentContext();
    if (!context?.tenantId || !context.userId || !context.unlockToken) throw keyringLocked();
    let resolved: ResolvedUnlock | null;
    try {
      resolved = await this.unlocks.resolve(context.unlockToken, {
        tenantId: context.tenantId,
        principal: context.userId,
      });
    } catch (error) {
      throw this.translate(error, "keyring");
    }
    if (!resolved) throw keyringLocked();
    return resolved;
  }

  /**
   * `fk` → `fk_ct` for a new file (`503` when the mode cannot be served). For `keyring` the
   * master key comes from the request's unlock (`423` without one); `ctx.keyringId`, when
   * given (a folder policy), must be the unlocked keyring — the one the key is wrapped under
   * is returned either way.
   */
  async wrapNewKey(mode: FileEncryption, fk: Buffer, ctx: WrapContext): Promise<WrappedKey> {
    const provider = await this.assertAvailable(mode);
    let unlock: ResolvedUnlock | null = null;
    if (mode === "keyring") {
      unlock = await this.currentUnlock();
      if (ctx.keyringId && ctx.keyringId !== unlock.keyringId) {
        unlock.mk.fill(0);
        throw keyringLocked();
      }
      ctx = { ...ctx, keyringId: unlock.keyringId, unlock: unlock.mk };
    }
    try {
      return { fkCt: await provider.wrap(fk, ctx), keyringId: ctx.keyringId ?? null };
    } catch (error) {
      throw this.translate(error, mode);
    } finally {
      unlock?.mk.fill(0);
    }
  }

  /**
   * The file key of a stored row (`503` without key material, `409` when `fk_ct` does not
   * open, `423` for a `keyring` file the request holds no unlock for — a token of ANOTHER
   * keyring counts as none). A key that opened under an older key-file line is re-wrapped
   * under the active one and the row updated — the lazy rotation.
   */
  async fileKey(
    row: Pick<FileRow, "id" | "tenantId" | "encryption" | "fkCt" | "keyringId">,
  ): Promise<Buffer> {
    const mode = row.encryption as FileEncryption;
    const provider = this.provider(mode);
    if (!provider) throw encryptionUnavailable(mode);
    if (!row.fkCt) {
      this.logger?.warn({ file: row.id }, "encrypted file without a wrapped key");
      throw integrityFailure();
    }
    const ctx: WrapContext = { fileId: row.id, tenantId: row.tenantId, keyringId: row.keyringId };
    let unlock: ResolvedUnlock | null = null;
    if (mode === "keyring") {
      unlock = await this.currentUnlock();
      if (!row.keyringId || unlock.keyringId !== row.keyringId) {
        unlock.mk.fill(0);
        throw keyringLocked();
      }
      ctx.unlock = unlock.mk;
    }
    let fk: Buffer;
    let rewrapped: Buffer | undefined;
    try {
      ({ fk, rewrapped } = await provider.unwrap(row.fkCt, ctx));
    } catch (error) {
      throw this.translate(error, mode, row.id);
    } finally {
      unlock?.mk.fill(0);
    }
    if (rewrapped) {
      // Best effort: the download must not fail because the rotation write did.
      await this.db
        .update(files)
        .set({ fkCt: rewrapped })
        .where(and(eq(files.id, row.id), eq(files.fkCt, row.fkCt)))
        .then(() => this.logger?.info({ file: row.id }, "file key re-wrapped under the active key"))
        .catch((error: unknown) =>
          this.logger?.warn({ err: error, file: row.id }, "file key not re-wrapped"),
        );
    }
    return fk;
  }

  /** The file key and the decrypted metadata of a stored encrypted row (`503` / `409`). */
  async open(
    row: Pick<FileRow, "id" | "tenantId" | "encryption" | "fkCt" | "metaCt" | "keyringId">,
  ): Promise<OpenedFile> {
    const fk = await this.fileKey(row);
    if (!row.metaCt) {
      this.logger?.warn({ file: row.id }, "encrypted file without metadata");
      throw integrityFailure();
    }
    try {
      return { fk, meta: openMeta(fk, row.id, row.metaCt) };
    } catch (error) {
      throw this.translate(error, row.encryption, row.id);
    }
  }

  /**
   * The metadata of a row for a LISTING: the real name and type when the server can open
   * them, `null` when it cannot (no key material, no unlock for a `keyring` file, a row
   * seeded without `meta_ct`, a damaged record) — a list never fails because of one file;
   * the row then keeps its mask.
   */
  async reveal(
    row: Pick<FileRow, "id" | "tenantId" | "encryption" | "fkCt" | "metaCt" | "keyringId">,
  ): Promise<FileMeta | null> {
    if (row.encryption === "none") return null;
    if (!this.provider(row.encryption as FileEncryption) || !row.fkCt || !row.metaCt) return null;
    try {
      return (await this.open(row)).meta;
    } catch (error) {
      if (error instanceof VolaError) return null;
      throw error;
    }
  }

  /**
   * Re-wraps the key of a `tenant` file for another tenant (the admin transfer): opens it
   * under the source tenant, wraps it under the destination. `503` / `409` as `fileKey`.
   */
  async rewrapForTenant(
    row: Pick<FileRow, "id" | "tenantId" | "encryption" | "fkCt" | "keyringId">,
    toTenantId: string,
  ): Promise<Buffer> {
    const provider = await this.assertAvailable("tenant");
    if (!row.fkCt) throw integrityFailure();
    try {
      const { fk } = await provider.unwrap(row.fkCt, { fileId: row.id, tenantId: row.tenantId });
      return await provider.wrap(fk, { fileId: row.id, tenantId: toTenantId });
    } catch (error) {
      throw this.translate(error, "tenant", row.id);
    }
  }

  /** The crypto layer's errors as HTTP errors; anything else passes through. */
  translate(error: unknown, mode: string, fileId?: string): unknown {
    if (error instanceof IntegrityError) {
      this.logger?.warn({ file: fileId, reason: error.reason }, "integrity failure");
      return integrityFailure();
    }
    if (error instanceof LockedError) {
      this.logger?.info({ file: fileId, reason: error.reason }, "keyring locked");
      return keyringLocked();
    }
    if (error instanceof EncryptionUnavailableError) {
      this.logger?.warn({ mode, reason: error.message }, "encryption unavailable");
      return encryptionUnavailable(mode);
    }
    return error;
  }
}

/** What `keys-status` reports: how many wrapped keys depend on which line of the key file. */
export interface KeyUsage {
  /** The line (0 = active), or `null` for a `kid` no line of the file has (a removed key!). */
  line: number | null;
  kid: string;
  files: number;
}

/**
 * Counts `tenant`-encrypted files by the `kid` of their `fk_ct` and maps each to a line of
 * `lines`. A `kid` without a line means files nobody can open any more — the one thing an
 * operator must see before deleting a line.
 */
export async function tenantKeyUsage(db: Database, lines: readonly KeyLine[]): Promise<KeyUsage[]> {
  const rows = await db
    .select({
      kid: sql<Buffer>`substring(${files.fkCt} from 1 for ${sql.raw(String(KID_BYTES))})`,
      n: sql<number>`count(*)`,
    })
    .from(files)
    .where(and(eq(files.encryption, "tenant"), isNotNull(files.fkCt)))
    .groupBy(sql`1`);
  const byKid = new Map(lines.map((l) => [l.kid.toString("hex"), l.index]));
  return rows
    .map((row) => {
      const kid = Buffer.from(row.kid).toString("hex");
      return { line: byKid.get(kid) ?? null, kid, files: Number(row.n) };
    })
    .sort((a, b) => (a.line ?? 1e9) - (b.line ?? 1e9) || a.kid.localeCompare(b.kid));
}

export interface CreateEncryptionServiceOptions {
  db: Database;
  /** `config.keyFile`. */
  keyFile: string;
  /** The key source instead of the file (tests). */
  keys?: KeySource | undefined;
  /** The token store of the `keyring` provider; absent: that mode answers `503`. */
  unlocks?: UnlockStore | null | undefined;
  segmentSize?: number | undefined;
  logger?: FastifyBaseLogger | undefined;
}

/**
 * The service of a deployment: the `tenant` provider on `VOLA_KEY_FILE` and the `keyring`
 * provider over `unlocks` (a Redis-backed `UnlockStore`; without one every `keyring` file
 * is `503 encryption_unavailable`).
 */
export function createEncryptionService(
  options: CreateEncryptionServiceOptions,
): EncryptionService {
  const keys = options.keys ?? new KeyFile(options.keyFile, options.logger);
  return new EncryptionService({
    db: options.db,
    providers: [new TenantWrapProvider(keys), new KeyringWrapProvider()],
    unlocks: options.unlocks,
    segmentSize: options.segmentSize,
    logger: options.logger,
  });
}

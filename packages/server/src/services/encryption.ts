/**
 * The encryption side of the file services (plan 6.1; `docs/CRYPTO.md`): which wrap
 * providers exist, which mode an upload gets, how a stored row's file key and metadata are
 * opened — and how the crypto layer's two failures become HTTP: `IntegrityError` →
 * `409 vola_integrity` with its one fixed sentence, `EncryptionUnavailableError` →
 * `503 encryption_unavailable`. Nothing here logs a name, a MIME type or a key.
 */
import {
  ENCRYPTION_UNAVAILABLE_CODE,
  FILE_ENCRYPTIONS,
  type FileEncryption,
  INTEGRITY_ERROR_CODE,
} from "@vola/core";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  DEFAULT_SEGMENT_BYTES,
  EncryptionUnavailableError,
  type FileMeta,
  INTEGRITY_MESSAGE,
  IntegrityError,
  KeyFile,
  type KeyLine,
  type KeySource,
  KID_BYTES,
  openMeta,
  TenantWrapProvider,
  type WrapContext,
  type WrapProvider,
} from "../crypto/index.js";
import type { Database } from "../db/index.js";
import { type FileRow, files, tenants } from "../db/schema.js";
import { VolaError } from "../errors.js";

/** The modes this release accepts on an upload. */
export const AVAILABLE_ENCRYPTIONS: readonly FileEncryption[] = ["none", "tenant"];

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
  logger?: FastifyBaseLogger | undefined;
}

/**
 * The providers by mode plus the row-level operations the routes and services share. One per
 * plugin instance; the CLI builds its own for `transfer` and `keys-status`.
 */
export class EncryptionService {
  readonly db: Database;
  readonly segmentSize: number;
  private readonly providers = new Map<FileEncryption, WrapProvider>();
  private readonly logger: FastifyBaseLogger | undefined;

  constructor(options: EncryptionServiceOptions) {
    this.db = options.db;
    this.segmentSize = options.segmentSize ?? DEFAULT_SEGMENT_BYTES;
    this.logger = options.logger;
    for (const provider of options.providers) this.providers.set(provider.mode, provider);
  }

  /** The provider of `mode`, or `null` when the mode has none (configured) here. */
  provider(mode: FileEncryption): WrapProvider | null {
    return this.providers.get(mode) ?? null;
  }

  /**
   * The `encryption` an upload asked for: `undefined` when it named none (the tenant default
   * applies), `none` / `tenant` otherwise; `501 not_implemented` for `keyring` / `caller`
   * (phases 6.2 / 6.3), `422 validation_error` for anything else.
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
        `encryption "${mode}" arrives with a later phase (keyring: 6.2, caller: 6.3)`,
      );
    }
    return mode;
  }

  /** The mode of an upload: the explicit one, else the tenant's `default_encryption`. */
  async resolveMode(
    tenantId: string,
    explicit: FileEncryption | undefined,
  ): Promise<FileEncryption> {
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
   * or the provider's key material is missing (`503`).
   */
  async assertAvailable(mode: FileEncryption): Promise<WrapProvider> {
    const provider = this.provider(mode);
    if (!provider) throw encryptionUnavailable(mode);
    if (provider instanceof TenantWrapProvider) {
      try {
        await provider.keys.lines();
      } catch (error) {
        throw this.translate(error, mode);
      }
    }
    return provider;
  }

  /** `fk` → `fk_ct` for a new file (`503` when the mode cannot be served). */
  async wrapNewKey(mode: FileEncryption, fk: Buffer, ctx: WrapContext): Promise<Buffer> {
    const provider = await this.assertAvailable(mode);
    try {
      return await provider.wrap(fk, ctx);
    } catch (error) {
      throw this.translate(error, mode);
    }
  }

  /**
   * The file key of a stored row (`503` without key material, `409` when `fk_ct` does not
   * open). A key that opened under an older key-file line is re-wrapped under the active one
   * and the row updated — the lazy rotation.
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
    let fk: Buffer;
    let rewrapped: Buffer | undefined;
    try {
      ({ fk, rewrapped } = await provider.unwrap(row.fkCt, ctx));
    } catch (error) {
      throw this.translate(error, mode, row.id);
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
   * them, `null` when it cannot (no key material, a row seeded without `meta_ct`, a damaged
   * record) — a list never fails because of one file; the row then keeps its mask.
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
  segmentSize?: number | undefined;
  logger?: FastifyBaseLogger | undefined;
}

/** The service of a deployment: the `tenant` provider on `VOLA_KEY_FILE`. */
export function createEncryptionService(
  options: CreateEncryptionServiceOptions,
): EncryptionService {
  const keys = options.keys ?? new KeyFile(options.keyFile, options.logger);
  return new EncryptionService({
    db: options.db,
    providers: [new TenantWrapProvider(keys)],
    segmentSize: options.segmentSize,
    logger: options.logger,
  });
}

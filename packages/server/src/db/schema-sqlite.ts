/**
 * The SQLite schema of JSVola: the tables of `./schema-postgres.ts` (read the documentation
 * there), column for column, on `drizzle-orm/sqlite-core`. `pnpm db:generate` writes its
 * migrations into `../../drizzle-sqlite`. The row types are the PostgreSQL ones (checked at
 * the end of the file), so the services see one shape whichever database they run on:
 *
 * - `uuid`, `varchar` → TEXT (ids stay UUID v7 from the application);
 * - `timestamp with time zone` → INTEGER, epoch milliseconds (`Date` in TypeScript);
 * - `boolean` → INTEGER 0/1;
 * - `jsonb` and `text[]` (`vola_apikey.scopes`) → TEXT holding JSON;
 * - `bytea` → BLOB (`Buffer`); `bigint`, `smallint` → INTEGER;
 * - `vola_file_metadata.ocr_tsv` (tsvector) is not there: SQLite has no OCR search.
 *
 * The CHECK constraints are the PostgreSQL ones, with `GLOB` / `instr` where PostgreSQL uses a
 * regular expression (SQLite has no `~` without an extension); the partial unique indexes
 * are the same.
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type * as pg from "./schema-postgres.js";
import type { KeyringKdf } from "./schema-postgres.js";
import { uuidv7 } from "./uuid.js";

/** Now, in epoch milliseconds: the `defaultNow()` of these tables. */
const NOW_MS = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

const id = () => text("id").primaryKey().$defaultFn(uuidv7);
const uuid = (name: string) => text(name);
const varchar = (name: string, _options: { length: number }) => text(name);
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
const createdAt = () => timestamp("created_at").notNull().default(NOW_MS);
const boolean = (name: string) => integer(name, { mode: "boolean" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
const bytea = (name: string) => blob(name, { mode: "buffer" });
const bigint = (name: string) => integer(name, { mode: "number" });
const smallint = (name: string) => integer(name, { mode: "number" });

/** `^[a-z][a-z0-9_]*$` without a regular expression. */
const instanceTypeCheck = (column: AnySQLiteColumn) =>
  sql`${column} glob '[a-z]*' and ${column} not glob '*[^a-z0-9_]*'`;

export const tenants = sqliteTable(
  "vola_tenant",
  {
    id: id(),
    slug: varchar("slug", { length: 64 }).notNull().unique(),
    name: varchar("name", { length: 200 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    defaultEncryption: varchar("default_encryption", { length: 16 }).notNull().default("none"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "vola_tenant_default_encryption_check",
      sql`${t.defaultEncryption} in ('none', 'tenant', 'keyring', 'caller')`,
    ),
  ],
);

export const apiKeys = sqliteTable(
  "vola_apikey",
  {
    id: id(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull().unique(),
    prefix: varchar("prefix", { length: 16 }).notNull(),
    last4: varchar("last4", { length: 4 }).notNull(),
    scopes: json<string[]>("scopes").notNull(),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    createdBy: varchar("created_by", { length: 255 }),
  },
  (t) => [
    index("vola_apikey_tenant_idx").on(t.tenantId),
    check("vola_apikey_prefix_check", sql`${t.prefix} in ('vola_live', 'vola_test', 'vola_admin')`),
    check("vola_apikey_admin_check", sql`(${t.tenantId} is null) = ${t.isAdmin}`),
  ],
);

export const folders = sqliteTable(
  "vola_folder",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    instanceType: varchar("instance_type", { length: 100 }).notNull(),
    instanceId: uuid("instance_id").notNull(),
    parentId: uuid("parent_id").references((): AnySQLiteColumn => folders.id, {
      onDelete: "cascade",
    }),
    name: varchar("name", { length: 255 }).notNull(),
    path: text("path").notNull(),
    defaultKeyringId: uuid("default_keyring_id"),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull().default(NOW_MS),
    deletedAt: timestamp("deleted_at"),
    deletedBy: varchar("deleted_by", { length: 255 }),
  },
  (t) => [
    uniqueIndex("vola_folder_path_live_uq")
      .on(t.tenantId, t.instanceType, t.instanceId, t.path)
      .where(sql`${t.deletedAt} is null`),
    index("vola_folder_parent_idx").on(t.tenantId, t.instanceType, t.instanceId, t.parentId),
    check("vola_folder_instance_type_check", instanceTypeCheck(t.instanceType)),
    // `<> '' and !~ '(^/|/$|//)'`.
    check(
      "vola_folder_path_check",
      sql`${t.path} <> '' and ${t.path} not glob '/*' and ${t.path} not glob '*/' and instr(${t.path}, '//') = 0`,
    ),
  ],
);

export const files = sqliteTable(
  "vola_file",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    instanceType: varchar("instance_type", { length: 100 }).notNull(),
    instanceId: uuid("instance_id").notNull(),
    slug: varchar("slug", { length: 100 }),
    hash: varchar("hash", { length: 64 }).notNull(),
    size: bigint("size").notNull(),
    filename: varchar("filename", { length: 255 }).notNull(),
    extension: varchar("extension", { length: 50 }),
    mimeType: varchar("mime_type", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    metadata: json<Record<string, unknown>>("metadata").notNull().default({}),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    parentId: uuid("parent_id").references((): AnySQLiteColumn => files.id, {
      onDelete: "set null",
    }),
    isPublic: boolean("is_public").notNull().default(false),
    isGlobalPublic: boolean("is_global_public").notNull().default(false),
    encryption: varchar("encryption", { length: 16 }).notNull().default("none"),
    encFormat: smallint("enc_format"),
    keyringId: uuid("keyring_id"),
    fkCt: bytea("fk_ct"),
    metaCt: bytea("meta_ct"),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull().default(NOW_MS),
    deletedAt: timestamp("deleted_at"),
    deletedBy: varchar("deleted_by", { length: 255 }),
    lastAccessedAt: timestamp("last_accessed_at"),
    lastAccessedBy: varchar("last_accessed_by", { length: 255 }),
  },
  (t) => [
    index("vola_file_instance_idx").on(t.tenantId, t.instanceType, t.instanceId),
    index("vola_file_hash_idx").on(t.hash),
    index("vola_file_folder_idx").on(t.folderId),
    index("vola_file_parent_idx").on(t.parentId),
    index("vola_file_keyring_idx").on(t.keyringId),
    uniqueIndex("vola_file_slug_live_uq")
      .on(t.tenantId, t.instanceType, t.instanceId, t.slug)
      .where(sql`${t.deletedAt} is null and ${t.slug} is not null`),
    check("vola_file_instance_type_check", instanceTypeCheck(t.instanceType)),
    // `~ '^[a-f0-9]{64}$'`.
    check("vola_file_hash_check", sql`length(${t.hash}) = 64 and ${t.hash} not glob '*[^a-f0-9]*'`),
    check("vola_file_size_check", sql`${t.size} >= 0`),
    check(
      "vola_file_encryption_check",
      sql`${t.encryption} in ('none', 'tenant', 'keyring', 'caller', 'client')`,
    ),
  ],
);

export const uploads = sqliteTable(
  "vola_upload",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    instanceType: varchar("instance_type", { length: 100 }).notNull(),
    instanceId: uuid("instance_id").notNull(),
    folderPath: text("folder_path"),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    parentId: uuid("parent_id").references(() => files.id, { onDelete: "set null" }),
    slug: varchar("slug", { length: 100 }),
    filename: varchar("filename", { length: 255 }).notNull(),
    declaredMime: varchar("declared_mime", { length: 255 }),
    metadata: json<Record<string, unknown>>("metadata").notNull().default({}),
    length: bigint("length").notNull(),
    offset: bigint("offset").notNull().default(0),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at").notNull(),
    completedFileId: uuid("completed_file_id").references(() => files.id, {
      onDelete: "set null",
    }),
    encryption: varchar("encryption", { length: 16 }),
    encState: json<Record<string, unknown>>("enc_state"),
  },
  (t) => [
    index("vola_upload_tenant_idx").on(t.tenantId),
    index("vola_upload_expires_idx").on(t.expiresAt),
    check("vola_upload_instance_type_check", instanceTypeCheck(t.instanceType)),
    check("vola_upload_length_check", sql`${t.length} >= 0`),
    check("vola_upload_offset_check", sql`${t.offset} >= 0 and ${t.offset} <= ${t.length}`),
  ],
);

export const processingJobs = sqliteTable(
  "vola_processing_job",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 20 }).notNull(),
    params: json<Record<string, unknown>>("params").notNull().default({}),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    attempts: smallint("attempts").notNull().default(0),
    error: varchar("error", { length: 500 }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    uniqueIndex("vola_processing_job_identity_uq").on(t.fileId, t.kind, t.params),
    index("vola_processing_job_tenant_status_idx").on(t.tenantId, t.status),
    check("vola_processing_job_kind_check", sql`${t.kind} in ('THUMBNAIL', 'OCR')`),
    check(
      "vola_processing_job_status_check",
      sql`${t.status} in ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED')`,
    ),
    check("vola_processing_job_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

export const fileMetadata = sqliteTable(
  "vola_file_metadata",
  {
    fileId: uuid("file_id")
      .primaryKey()
      .references(() => files.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ocrText: text("ocr_text"),
    ocrLang: varchar("ocr_lang", { length: 64 }),
    ocrPages: integer("ocr_pages"),
    ocrAt: timestamp("ocr_at"),
    ocrCt: bytea("ocr_ct"),
  },
  (t) => [
    index("vola_file_metadata_tenant_idx").on(t.tenantId),
    check("vola_file_metadata_ocr_pages_check", sql`${t.ocrPages} is null or ${t.ocrPages} >= 0`),
  ],
);

export const shareLinks = sqliteTable(
  "vola_share_link",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    scope: varchar("scope", { length: 20 }).notNull().default("PUBLIC_LINK"),
    passwordHash: text("password_hash"),
    expiresAt: timestamp("expires_at"),
    maxDownloads: integer("max_downloads"),
    downloadCount: integer("download_count").notNull().default(0),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at"),
    fkShareCt: bytea("fk_share_ct"),
  },
  (t) => [
    index("vola_share_link_tenant_idx").on(t.tenantId),
    index("vola_share_link_file_idx").on(t.fileId),
    index("vola_share_link_folder_idx").on(t.folderId),
    check("vola_share_link_target_check", sql`(${t.fileId} is null) <> (${t.folderId} is null)`),
    check(
      "vola_share_link_scope_check",
      sql`${t.scope} in ('PUBLIC_LINK', 'TENANT', 'INSTANCE_VIEWERS', 'EMAIL')`,
    ),
    check(
      "vola_share_link_max_downloads_check",
      sql`${t.maxDownloads} is null or ${t.maxDownloads} > 0`,
    ),
    check("vola_share_link_download_count_check", sql`${t.downloadCount} >= 0`),
  ],
);

export const accessTokens = sqliteTable(
  "vola_access_token",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    principal: varchar("principal", { length: 255 }).notNull(),
    fileIds: json<string[]>("file_ids"),
    instanceType: varchar("instance_type", { length: 100 }),
    instanceId: uuid("instance_id"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [
    index("vola_access_token_tenant_expires_idx").on(t.tenantId, t.expiresAt),
    index("vola_access_token_apikey_idx").on(t.apiKeyId),
    check(
      "vola_access_token_target_check",
      sql`(${t.fileIds} is null) <> (${t.instanceType} is null) and (${t.instanceType} is null) = (${t.instanceId} is null)`,
    ),
  ],
);

export const tenantStats = sqliteTable(
  "vola_tenant_stats",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    scope: varchar("scope", { length: 10 }).notNull(),
    instanceType: varchar("instance_type", { length: 100 }),
    instanceId: uuid("instance_id"),
    totalFiles: bigint("total_files").notNull().default(0),
    totalBytes: bigint("total_bytes").notNull().default(0),
    byKind: json<Record<string, number>>("by_kind").notNull().default({}),
    oldestAt: timestamp("oldest_at"),
    newestAt: timestamp("newest_at"),
    computedAt: timestamp("computed_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("vola_tenant_stats_tenant_uq").on(t.tenantId).where(sql`${t.scope} = 'tenant'`),
    uniqueIndex("vola_tenant_stats_instance_uq")
      .on(t.tenantId, t.instanceType, t.instanceId)
      .where(sql`${t.scope} = 'instance'`),
    index("vola_tenant_stats_computed_idx").on(t.computedAt),
    check("vola_tenant_stats_scope_check", sql`${t.scope} in ('tenant', 'instance')`),
    check(
      "vola_tenant_stats_instance_check",
      sql`(${t.scope} = 'tenant' and ${t.instanceType} is null and ${t.instanceId} is null) or (${t.scope} = 'instance' and ${t.instanceType} is not null and ${t.instanceId} is not null)`,
    ),
    check("vola_tenant_stats_totals_check", sql`${t.totalFiles} >= 0 and ${t.totalBytes} >= 0`),
  ],
);

export const keyrings = sqliteTable(
  "vola_keyring",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    principal: varchar("principal", { length: 255 }).notNull(),
    kdf: json<KeyringKdf>("kdf").notNull(),
    mkPinCt: bytea("mk_pin_ct").notNull(),
    mkRecoveryCt: bytea("mk_recovery_ct").notNull(),
    recoverySalt: bytea("recovery_salt").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until"),
    pinSetAt: timestamp("pin_set_at").notNull().default(NOW_MS),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    uniqueIndex("vola_keyring_principal_live_uq")
      .on(t.tenantId, t.principal)
      .where(sql`${t.deletedAt} is null`),
    check("vola_keyring_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

// --- one row shape for both databases ----------------------------------------------------

/** `true` when `A` and `B` are the same type. */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Compiles only while every table here reads (and writes) the rows its PostgreSQL twin does —
 * the services are typed against those. `ocr_tsv` is the one PostgreSQL-only column.
 */
export const SAME_ROWS: {
  [K in keyof typeof pg & keyof SqliteTables]: (typeof pg)[K] extends { $inferSelect: infer P }
    ? Same<Omit<P, "ocrTsv">, SqliteTables[K]["$inferSelect"]> extends true
      ? Same<
          Omit<(typeof pg)[K] extends { $inferInsert: infer I } ? I : never, "ocrTsv">,
          SqliteTables[K]["$inferInsert"]
        >
      : false
    : never;
} = {
  tenants: true,
  apiKeys: true,
  folders: true,
  files: true,
  uploads: true,
  processingJobs: true,
  fileMetadata: true,
  shareLinks: true,
  accessTokens: true,
  tenantStats: true,
  keyrings: true,
};

interface SqliteTables {
  tenants: typeof tenants;
  apiKeys: typeof apiKeys;
  folders: typeof folders;
  files: typeof files;
  uploads: typeof uploads;
  processingJobs: typeof processingJobs;
  fileMetadata: typeof fileMetadata;
  shareLinks: typeof shareLinks;
  accessTokens: typeof accessTokens;
  tenantStats: typeof tenantStats;
  keyrings: typeof keyrings;
}

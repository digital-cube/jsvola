/**
 * The tables the services query, of the database this process speaks. They are the
 * PostgreSQL tables of `./schema-postgres.ts` until `connect` opens a SQLite database, which
 * swaps in the twins of `./schema-sqlite.ts` (`useSchemaOf`) — ES module bindings are live, so
 * every importer sees the swap. Both have the same row types; the TypeScript type is the
 * PostgreSQL one either way.
 *
 * Read a table (`files.createdAt`) when a query is built, never into a module-level constant:
 * a column captured at import time stays a PostgreSQL column on SQLite.
 */
import * as pg from "./schema-postgres.js";
import * as sqlite from "./schema-sqlite.js";

export type {
  ApiKeyRow,
  FileMetadataRow,
  FileRow,
  FolderRow,
  KeyringKdf,
  KeyringRow,
  ProcessingJobRow,
  ShareLinkRow,
  TenantRow,
  TenantStatsRow,
  UploadRow,
} from "./schema-postgres.js";
export { OCR_TSV_MAX_CHARS } from "./schema-postgres.js";

export let tenants = pg.tenants;
export let apiKeys = pg.apiKeys;
export let folders = pg.folders;
export let files = pg.files;
export let uploads = pg.uploads;
export let processingJobs = pg.processingJobs;
export let fileMetadata = pg.fileMetadata;
export let shareLinks = pg.shareLinks;
export let tenantStats = pg.tenantStats;
export let keyrings = pg.keyrings;

/** Which schema the bindings above hold. */
let current: "postgres" | "sqlite" = "postgres";

/** Points every table binding at the schema of `dialect`. */
export function useSchemaOf(dialect: "postgres" | "sqlite"): void {
  if (dialect === current) return;
  const s = (dialect === "sqlite" ? sqlite : pg) as unknown as typeof pg;
  tenants = s.tenants;
  apiKeys = s.apiKeys;
  folders = s.folders;
  files = s.files;
  uploads = s.uploads;
  processingJobs = s.processingJobs;
  fileMetadata = s.fileMetadata;
  shareLinks = s.shareLinks;
  tenantStats = s.tenantStats;
  keyrings = s.keyrings;
  current = dialect;
}

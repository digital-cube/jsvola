import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ConfigError } from "../config.js";
import type { Dialect } from "./dialect.js";
import { openPostgres, postgresDialect } from "./postgres.js";
import type * as schema from "./schema.js";

export type { Dialect, DialectCapabilities, Executor } from "./dialect.js";

/**
 * The database the services query: drizzle's query builder over the server's schema, with no
 * driver in the type (no pool, no driver result shapes). What is not portable SQL goes through
 * `dialect`.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
  db: Database;
  /** The dialect `db` speaks. */
  dialect: Dialect;
  close(): Promise<void>;
}

/**
 * The dialect of this server's schema, for the queries that need one. A process speaks one
 * dialect: the tables of `./schema.ts` are dialect objects, imported at module scope.
 */
export const dialect: Dialect = postgresDialect;

/** The database URL schemes `connect` opens, and the opener of each. */
const OPENERS: Record<string, (url: string, options: { max?: number }) => DatabaseHandle> = {
  postgres: openPostgres,
  postgresql: openPostgres,
};

/**
 * Opens a pooled connection; the URL scheme picks the database (`postgres://` or
 * `postgresql://`, the only one so far). Call `close()` on shutdown.
 *
 * @throws ConfigError for a URL of any other scheme.
 */
export function connect(url: string, options: { max?: number } = {}): DatabaseHandle {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase();
  const open = scheme === undefined ? undefined : OPENERS[scheme];
  if (!open) {
    // Only the scheme: the rest of the URL may carry a password.
    throw new ConfigError([
      `database URL: ${scheme === undefined ? "no scheme" : `unsupported scheme "${scheme}:"`}` +
        ` (supported: ${Object.keys(OPENERS)
          .map((s) => `${s}://`)
          .join(", ")})`,
    ]);
  }
  return open(url, options);
}

/** The generated SQL migrations shipped with this package. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Applies every pending migration (idempotent). */
export async function runMigrations(db: Database): Promise<void> {
  await dialect.migrate(db, MIGRATIONS_FOLDER);
}

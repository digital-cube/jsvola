import { fileURLToPath } from "node:url";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { ConfigError } from "../config.js";
import type { Dialect } from "./dialect.js";
import { openPostgres, postgresDialect } from "./postgres.js";
import { useSchemaOf } from "./schema.js";
import type * as schema from "./schema-postgres.js";
import { openSqlite, sqliteDialect } from "./sqlite.js";

export type { Dialect, DialectCapabilities, Executor } from "./dialect.js";

/**
 * The database the services query: drizzle's query builder over the server's schema, with no
 * driver in the type (no pool, no driver result shapes). What is not portable SQL goes through
 * `dialect`. On SQLite the object is drizzle's SQLite database behind the same type: the
 * services use only what both builders have, and the rest through `dialect`.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DatabaseHandle {
  db: Database;
  /** The dialect `db` speaks. */
  dialect: Dialect;
  close(): Promise<void>;
}

/**
 * The dialect of this process, for the queries that need one. A process speaks one dialect:
 * the first `connect` decides it (PostgreSQL until then) and points the tables of
 * `./schema.ts` at its schema. A live binding: importers see the change.
 */
export let dialect: Dialect = postgresDialect;

interface Opener {
  dialect: Dialect;
  open: (url: string, options: { max?: number }) => DatabaseHandle;
}
const POSTGRES: Opener = { dialect: postgresDialect, open: openPostgres };
const SQLITE: Opener = { dialect: sqliteDialect, open: openSqlite };
/** The database URL schemes `connect` opens, and the opener and dialect of each. */
const OPENERS: Record<string, Opener> = { postgres: POSTGRES, postgresql: POSTGRES, file: SQLITE };

/** Handles open right now; the dialect may change only while there are none. */
let open = 0;

/** The opener of `url`'s scheme; `:memory:` is SQLite. */
function openerOf(url: string): Opener {
  if (url === ":memory:") return SQLITE;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase();
  const opener = scheme === undefined ? undefined : OPENERS[scheme];
  if (!opener) {
    // Only the scheme: the rest of the URL may carry a password.
    throw new ConfigError([
      `database URL: ${scheme === undefined ? "no scheme" : `unsupported scheme "${scheme}:"`}` +
        " (supported: postgres://, postgresql://, file:<path>, :memory:)",
    ]);
  }
  return opener;
}

/** The dialect a database URL selects, without opening anything. */
export function dialectOf(url: string): Dialect {
  return openerOf(url).dialect;
}

/**
 * Opens the database `url` names; the scheme picks it: `postgres://` / `postgresql://` (a
 * pooled connection, `max` connections) or `file:<path>` / `:memory:` (SQLite). Call
 * `close()` on shutdown.
 *
 * @throws ConfigError for a URL of any other scheme, or for a second dialect while handles
 *   of the first are open.
 */
export function connect(url: string, options: { max?: number } = {}): DatabaseHandle {
  const opener = openerOf(url);
  if (opener.dialect !== dialect) {
    if (open > 0) {
      throw new ConfigError([
        `database URL: this process already uses ${dialect.name}; one process speaks one dialect`,
      ]);
    }
    dialect = opener.dialect;
    useSchemaOf(dialect.name);
  }
  const handle = opener.open(url, options);
  open++;
  let closed = false;
  return {
    ...handle,
    close: async () => {
      if (closed) return;
      closed = true;
      open--;
      await handle.close();
    },
  };
}

/** The generated SQL migrations shipped with this package, for PostgreSQL. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
/** The same for SQLite. */
export const SQLITE_MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle-sqlite", import.meta.url),
);

/** Applies every pending migration of the process's dialect (idempotent). */
export async function runMigrations(db: Database): Promise<void> {
  await dialect.migrate(
    db,
    dialect.name === "sqlite" ? SQLITE_MIGRATIONS_FOLDER : MIGRATIONS_FOLDER,
  );
}

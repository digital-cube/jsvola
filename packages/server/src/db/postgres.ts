import { type AnyColumn, ilike, like, type SQL, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { type Dialect, errorCode } from "./dialect.js";
import type { Database, DatabaseHandle } from "./index.js";
import * as schema from "./schema.js";
import { fileMetadata } from "./schema-postgres.js";

/** SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";
/** SQLSTATE of `SELECT … FOR UPDATE NOWAIT` finding the row locked. */
const LOCK_NOT_AVAILABLE = "55P03";
/** A JSON key spelled into the SQL as a literal (as the queries always did), never a parameter. */
const JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const renderer = new PgDialect();

const lockKey = async (tx: Pick<Database, "execute">, key: string): Promise<void> => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
};

/** PostgreSQL: advisory locks, SQLSTATE codes, `FILTER`, `->>`, `jsonb`, `ILIKE`, `tsquery`. */
export const postgresDialect: Dialect = {
  name: "postgres",
  capabilities: { ocrSearch: true, rowLocks: true },

  lockContentHash: lockKey,
  lockKey,

  isUniqueViolation: (error) => errorCode(error) === UNIQUE_VIOLATION,
  isLockNotAvailable: (error) => errorCode(error) === LOCK_NOT_AVAILABLE,

  countWhere: (condition) => sql<number>`count(*) filter (where ${condition})`,
  jsonText(column, field) {
    if (!JSON_KEY.test(field)) throw new Error(`not a plain JSON key: ${JSON.stringify(field)}`);
    return sql<string | null>`${column} ->> ${sql.raw(`'${field}'`)}`;
  },
  jsonEquals: (column, value) => sql`${column} = ${JSON.stringify(value)}::jsonb`,
  like: (column, pattern) => like(column as never, pattern),
  ilike: (column, pattern) => ilike(column as never, pattern),
  ocrMatch: (words) => sql`${fileMetadata.ocrTsv} @@ plainto_tsquery('simple', ${words})`,

  forUpdateNoWait: <Q>(query: Q): Q =>
    (query as { for(strength: "update", config: { noWait: boolean }): Q }).for("update", {
      noWait: true,
    }),

  onConflictDoNothing: <Q>(insert: Q, config: { target: AnyColumn[]; where: SQL }): Q =>
    (insert as { onConflictDoNothing(c: typeof config): Q }).onConflictDoNothing(config),

  async migrate(db, migrationsFolder) {
    // Every PostgreSQL `Database` this package opens is a node-postgres one (`openPostgres`).
    await migrate(db as NodePgDatabase<typeof schema>, { migrationsFolder });
  },
  render: (query: SQL) => renderer.sqlToQuery(query),
};

/** Opens a node-postgres pool on `url`. */
export function openPostgres(url: string, options: { max?: number }): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 });
  // A dropped idle connection must not crash the process; the next query reconnects.
  pool.on("error", () => {});
  const db: Database = drizzle(pool, { schema });
  return { db, dialect: postgresDialect, close: () => pool.end() };
}

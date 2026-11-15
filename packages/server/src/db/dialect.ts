import type { AnyColumn, SQL, SQLWrapper } from "drizzle-orm";
import type { Database } from "./index.js";

/**
 * The dialect seam: everything the server says to its database that is not portable SQL.
 * Services, routes and UDC sources write their queries with drizzle's query builder and reach
 * for this interface for the rest — locks, error classification, and the handful of
 * expressions every database spells differently. One implementation per supported database
 * (`./postgres.ts`, `./sqlite.ts`); nothing outside `db/` imports a driver or a dialect module.
 */
export interface Dialect {
  /** Name of the database, for logs and error messages. */
  readonly name: "postgres" | "sqlite";
  /** What this database can do that another might not. */
  readonly capabilities: DialectCapabilities;

  /**
   * Serialises the writers of the same content hash until the end of the transaction `tx`
   * (a blob is committed, re-referenced or purged by one of them at a time).
   */
  lockContentHash(tx: Executor, hash: string): Promise<void>;
  /** The same transaction-scoped lock, on any string key (e.g. one instance's folder tree). */
  lockKey(tx: Executor, key: string): Promise<void>;

  /** `error` (or the driver error drizzle wrapped in it) is a unique-constraint violation. */
  isUniqueViolation(error: unknown): boolean;
  /** `error` is a `FOR UPDATE NOWAIT` that found the row locked by another transaction. */
  isLockNotAvailable(error: unknown): boolean;

  /** `count(*)` of the rows of the group where `condition` holds. */
  countWhere(condition: SQL | SQLWrapper): SQL<number>;
  /** The text of the top-level `field` of a JSON column; `null` when absent. */
  jsonText(column: AnyColumn | SQL, field: string): SQL<string | null>;
  /** A JSON column equals `value` (as a JSON document, not as text). */
  jsonEquals(column: AnyColumn | SQL, value: unknown): SQL;
  /** Case-sensitive `LIKE`, `\\` escaping `%`, `_` and itself (PostgreSQL's default). */
  like(column: AnyColumn | SQL, pattern: string): SQL;
  /** Case-insensitive `LIKE`, with the same escape. */
  ilike(column: AnyColumn | SQL, pattern: string): SQL;
  /**
   * The OCR search of `words`: a condition on the `vola_file_metadata` row of the query
   * (joined, possibly NULL) that holds when its `ocr_text` contains every word — lower-cased,
   * no stemming, no ranking. The words are data, never query syntax: what a user types
   * cannot change the meaning of the search or fail the statement. No word at all (only
   * punctuation, say) matches nothing. PostgreSQL: `ocr_tsv @@ plainto_tsquery('simple', …)`;
   * SQLite: the FTS5 index `vola_file_ocr_fts` (`drizzle-sqlite/0001_ocr_fts.sql`).
   */
  ocrMatch(words: string): SQL;

  /**
   * `query` (a SELECT of a transaction) holding its rows until the end of the transaction,
   * failing at once (`isLockNotAvailable`) when another transaction holds them. Where
   * `capabilities.rowLocks` is false the query is returned as it is.
   */
  forUpdateNoWait<Q>(query: Q): Q;
  /**
   * `insert` … `on conflict (target) where … do nothing`: the conflict on a PARTIAL unique
   * index is skipped (the row is not inserted, nothing returned).
   */
  onConflictDoNothing<Q>(insert: Q, config: { target: AnyColumn[]; where: SQL }): Q;

  /** Applies every pending migration shipped with the package (idempotent). */
  migrate(db: Database, migrationsFolder: string): Promise<void>;
  /** The SQL text and parameters of `query` in this dialect — for tests and diagnostics. */
  render(query: SQL): { sql: string; params: unknown[] };
}

export interface DialectCapabilities {
  /**
   * Full-text search of OCR text (the `ocr` filter with words); off, it is refused. True on
   * both supported databases: a SQLite without FTS5 is refused when it is opened.
   */
  readonly ocrSearch: boolean;
  /**
   * `SELECT … FOR UPDATE NOWAIT` holds rows across a long transaction while other
   * transactions go on. Without it (SQLite: one writer at a time) the server keeps a long
   * piece of work — a tus PATCH streaming its body — out of any transaction and guards its
   * row in memory, which is sound because such a database has one server process.
   */
  readonly rowLocks: boolean;
}

/** What a lock runs on: the database or a transaction of it. */
export type Executor = Pick<Database, "execute">;

/** The driver's error `code` of `error`, or of the driver error drizzle wrapped in its `cause`. */
export const errorCode = (error: unknown): string | undefined =>
  (error as { code?: string } | undefined)?.code ??
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

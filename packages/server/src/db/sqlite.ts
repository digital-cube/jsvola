import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { type SQL, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import {
  drizzle,
  SQLiteProxyTransaction,
  type SqliteRemoteDatabase,
} from "drizzle-orm/sqlite-proxy";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import { ConfigError } from "../config.js";
import { type Dialect, errorCode } from "./dialect.js";
import type { Database, DatabaseHandle } from "./index.js";

/**
 * How long a statement waits for the database: in this process for the transaction that
 * holds the writer, in SQLite (`busy_timeout`) for another process (a `vola` CLI command next
 * to the running server).
 */
export const SQLITE_BUSY_TIMEOUT_MS = 10_000;

/** SQLite's extended result codes the server tells apart, by the name SQLite gives them. */
const RESULT_CODES: Record<number, string> = {
  5: "SQLITE_BUSY",
  517: "SQLITE_BUSY_SNAPSHOT",
  6: "SQLITE_LOCKED",
  19: "SQLITE_CONSTRAINT",
  275: "SQLITE_CONSTRAINT_CHECK",
  787: "SQLITE_CONSTRAINT_FOREIGNKEY",
  1299: "SQLITE_CONSTRAINT_NOTNULL",
  1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
  2067: "SQLITE_CONSTRAINT_UNIQUE",
};
const UNIQUE_CODES = new Set(["SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"]);
/** A JSON key spelled into the SQL as a literal, never a parameter (as on PostgreSQL). */
const JSON_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * The case folding of `ilike`: SQLite's own `lower()` and `LIKE` fold ASCII only, this one
 * folds every letter (`Ž` → `ž`) the way JavaScript does.
 */
const CASEFOLD = "vola_casefold";

/** A failed statement, with SQLite's name of the result code in `code` (`SQLITE_CONSTRAINT_UNIQUE`). */
export class SqliteError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly errcode: number,
  ) {
    super(message);
    this.name = "SqliteError";
  }
}

const renderer = new SQLiteAsyncDialect();

/**
 * SQLite: one server process and one writer. No advisory locks — every transaction starts
 * with `BEGIN IMMEDIATE` and the handle runs one at a time, so the writers of a content hash
 * are serialised by the transaction itself. `LIKE` is case-sensitive on these connections
 * (`PRAGMA case_sensitive_like`) and escapes with `\`, as on PostgreSQL; `ilike` folds case
 * with JavaScript's `toLowerCase`, so it is not ASCII-only. No full-text search of OCR text.
 */
export const sqliteDialect: Dialect = {
  name: "sqlite",
  capabilities: { ocrSearch: false, rowLocks: false },

  // The transaction already holds the only writer (`BEGIN IMMEDIATE`, one at a time).
  lockContentHash: async () => {},
  lockKey: async () => {},

  isUniqueViolation: (error) => UNIQUE_CODES.has(errorCode(error) ?? ""),
  // No row locks, so nothing is ever "locked by another transaction".
  isLockNotAvailable: () => false,

  countWhere: (condition) => sql<number>`count(*) filter (where ${condition})`,
  jsonText(column, field) {
    if (!JSON_KEY.test(field)) throw new Error(`not a plain JSON key: ${JSON.stringify(field)}`);
    return sql<string | null>`${column} ->> ${sql.raw(`'$.${field}'`)}`;
  },
  jsonEquals: (column, value) => sql`json(${column}) = json(${JSON.stringify(value)})`,
  like: (column, pattern) => sql`${column} like ${pattern} escape '\\'`,
  ilike: (column, pattern) =>
    sql`${sql.raw(CASEFOLD)}(${column}) like ${sql.raw(CASEFOLD)}(${pattern}) escape '\\'`,
  ocrMatch() {
    throw new Error("SQLite has no full-text search of OCR text (capabilities.ocrSearch)");
  },
  forUpdateNoWait: (query) => query,
  // drizzle spells a target's WHERE after `do nothing` on SQLite, which SQLite refuses; a
  // conflict-target-less `do nothing` skips a conflict on any unique index — the same here,
  // where the partial index is the only one a generated id can conflict with.
  onConflictDoNothing: <Q>(insert: Q): Q =>
    (insert as { onConflictDoNothing(): Q }).onConflictDoNothing(),

  async migrate(db, migrationsFolder) {
    const state = stateOf(db);
    await migrate(
      db as unknown as SqliteRemoteDatabase,
      async (queries) => {
        await state.inTransaction(async () => {
          for (const query of queries) state.exec(query, [], "run");
        });
      },
      { migrationsFolder },
    );
  },
  render: (query: SQL) => renderer.sqlToQuery(query),
};

/** The file a `file:` URL names (relative to the working directory), or `:memory:`. */
export function sqlitePath(url: string): string {
  if (url === ":memory:" || url === "file::memory:") return ":memory:";
  if (!/^file:/i.test(url)) throw new ConfigError([`database URL: not a file: URL`]);
  let rest = url.slice("file:".length);
  if (rest.startsWith("//")) {
    // `file:///abs/path.db`: an empty host only.
    if (!rest.startsWith("///")) {
      throw new ConfigError(["database URL: file:// with a host is not supported"]);
    }
    rest = decodeURIComponent(rest.slice(2));
  }
  if (rest === "") throw new ConfigError(["database URL: file: needs a path"]);
  return resolve(rest);
}

type Method = "run" | "all" | "get" | "values";
type Mode = Method | "objects";

/** The transaction of the async context, when it is one of this handle's. */
interface TxContext {
  owner: SqliteState;
  active: boolean;
  tx?: unknown;
}

const context = new AsyncLocalStorage<TxContext>();
const states = new WeakMap<object, SqliteState>();

const stateOf = (db: unknown): SqliteState => {
  const state = states.get(db as object);
  if (!state) throw new Error("not a database opened by openSqlite");
  return state;
};

/** A FIFO gate around the writer: one transaction (or one statement outside any) at a time. */
class Gate {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  acquire(timeoutMs: number): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(grant);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(
          new SqliteError(
            `database is busy: no turn at the writer within ${timeoutMs} ms`,
            "SQLITE_BUSY",
            5,
          ),
        );
      }, timeoutMs);
      this.waiters.push(grant);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.held = false;
  }
}

/** A value as SQLite binds it: a `Date` is epoch milliseconds (the timestamp columns), a boolean 0/1. */
function bindable(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/** A value as the services read it: a BLOB is a `Buffer`, as node-postgres hands out `bytea`. */
function readable(value: unknown): unknown {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value;
}

const readableRow = (row: unknown): unknown =>
  Array.isArray(row)
    ? row.map(readable)
    : row && typeof row === "object"
      ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, readable(v)]))
      : row;

function wrapError(error: unknown): unknown {
  const e = error as { errcode?: number; message?: string } | undefined;
  if (typeof e?.errcode !== "number") return error;
  const code = RESULT_CODES[e.errcode] ?? `SQLITE_${e.errcode}`;
  const wrapped = new SqliteError(e.message ?? "SQLite error", code, e.errcode);
  wrapped.cause = error;
  return wrapped;
}

/** A read the second connection may answer: it never writes. */
const READ_ONLY = /^\s*select\b/i;

class SqliteState {
  readonly gate = new Gate();
  private readonly cache = new Map<string, StatementSync>();

  constructor(
    readonly writer: DatabaseSync,
    /** A read-only connection for SELECTs outside transactions (WAL); none for `:memory:`. */
    readonly reader: DatabaseSync | null,
  ) {}

  /** Runs one statement on `conn` (the writer by default), synchronously. */
  exec(text: string, params: unknown[], mode: Mode, conn: DatabaseSync = this.writer) {
    const key = `${conn === this.writer ? "w" : "r"}:${mode === "objects" ? "o" : "a"}:${text}`;
    let stmt = this.cache.get(key);
    if (!stmt) {
      try {
        stmt = conn.prepare(text);
      } catch (error) {
        throw wrapError(error);
      }
      if (mode !== "objects") stmt.setReturnArrays(true);
      if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, stmt);
    }
    const args = params.map(bindable) as never[];
    try {
      switch (mode) {
        case "run": {
          const r = stmt.run(...args);
          return { rows: [], changes: Number(r.changes), rowCount: Number(r.changes) };
        }
        case "get": {
          const row = stmt.get(...args);
          return { rows: row === undefined ? undefined : readableRow(row) };
        }
        default:
          return { rows: stmt.all(...args).map(readableRow) };
      }
    } catch (error) {
      throw wrapError(error);
    }
  }

  /** `true` while the current async context is inside one of this handle's transactions. */
  private inOwnTransaction(): boolean {
    const ctx = context.getStore();
    return ctx?.owner === this && ctx.active;
  }

  /** A statement from drizzle (or `execute`): inside our transaction, on a free reader, or at its turn. */
  async statement(text: string, params: unknown[], mode: Mode) {
    if (this.inOwnTransaction()) return this.exec(text, params, mode);
    if (this.reader && READ_ONLY.test(text)) return this.exec(text, params, mode, this.reader);
    await this.gate.acquire(SQLITE_BUSY_TIMEOUT_MS);
    try {
      return this.exec(text, params, mode);
    } finally {
      this.gate.release();
    }
  }

  /** Runs `work` as one `BEGIN IMMEDIATE` … `COMMIT` on the writer, at its turn. */
  async inTransaction<T>(work: () => Promise<T>, ctx?: TxContext): Promise<T> {
    await this.gate.acquire(SQLITE_BUSY_TIMEOUT_MS);
    const store: TxContext = ctx ?? { owner: this, active: true };
    try {
      return await context.run(store, async () => {
        this.exec("begin immediate", [], "run");
        try {
          const result = await work();
          this.exec("commit", [], "run");
          return result;
        } catch (error) {
          if (this.writer.isTransaction) this.exec("rollback", [], "run");
          throw error;
        }
      });
    } finally {
      store.active = false;
      this.gate.release();
    }
  }

  /** The transaction the current async context runs in, when it is one of ours. */
  currentTx(): unknown {
    const ctx = context.getStore();
    return ctx?.owner === this && ctx.active ? ctx.tx : undefined;
  }

  close(): void {
    this.cache.clear();
    this.reader?.close();
    this.writer.close();
  }
}

function openConnection(path: string, readOnly: boolean): DatabaseSync {
  const conn = new DatabaseSync(path, { readOnly });
  conn.exec(`pragma busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  if (!readOnly) {
    if (path !== ":memory:") conn.exec("pragma journal_mode = wal");
    conn.exec("pragma synchronous = normal");
  }
  conn.exec("pragma foreign_keys = on");
  conn.exec("pragma case_sensitive_like = on");
  conn.function(CASEFOLD, { deterministic: true }, (value) =>
    value === null ? null : String(value).toLowerCase(),
  );
  return conn;
}

/**
 * Opens the SQLite database `url` names (`file:<path>`, `file:///abs/path`, `:memory:`),
 * creating the file and its directory when missing: a writer connection in WAL mode with
 * `foreign_keys = ON` and a busy timeout, and a read-only connection for the SELECTs that run
 * outside a transaction. Statements and transactions of the handle take turns at the writer.
 */
export function openSqlite(url: string): DatabaseHandle {
  const path = sqlitePath(url);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const writer = openConnection(path, false);
  const reader = path === ":memory:" ? null : openConnection(path, true);
  const state = new SqliteState(writer, reader);

  const remote = drizzle(
    (text, params, method: Method) => state.statement(text, params, method) as never,
    { casing: undefined },
  );
  const db = remote as unknown as Database & Record<string, unknown>;

  // Transactions: `BEGIN IMMEDIATE`, one at a time; one opened inside another (on `db`, as
  // PostgreSQL code may do from another pool connection) is a savepoint of the outer one.
  db.transaction = (async (work: (tx: unknown) => Promise<unknown>) => {
    const outer = state.currentTx() as
      | { transaction(w: (tx: unknown) => Promise<unknown>): Promise<unknown> }
      | undefined;
    if (outer) return outer.transaction(work);
    const ctx: TxContext = { owner: state, active: true };
    return state.inTransaction(async () => {
      const tx = transactionOf(remote, state);
      ctx.tx = tx;
      return work(tx);
    }, ctx);
  }) as never;
  db.execute = execute(state) as never;

  states.set(db, state);
  return {
    db,
    dialect: sqliteDialect,
    close: async () => {
      // Wait for the transaction in flight, then close both connections.
      await state.gate.acquire(SQLITE_BUSY_TIMEOUT_MS).catch(() => undefined);
      state.close();
    },
  };
}

/** `execute`: raw SQL with the rows as objects, like node-postgres' `QueryResult`. */
const execute = (state: SqliteState) => async (query: SQL) => {
  const { sql: text, params } = renderer.sqlToQuery(query);
  return state.statement(text, params, "objects");
};

/**
 * A drizzle transaction object over `remote`'s session, for the `BEGIN` this module already
 * issued: the class drizzle's proxy driver hands to a transaction callback, so
 * `tx.transaction` (a savepoint) and `tx.rollback()` behave as drizzle documents.
 */
function transactionOf(remote: SqliteRemoteDatabase, state: SqliteState): unknown {
  const { session } = remote as unknown as {
    session: ConstructorParameters<typeof SQLiteProxyTransaction>[2] & {
      dialect: ConstructorParameters<typeof SQLiteProxyTransaction>[1];
      schema: ConstructorParameters<typeof SQLiteProxyTransaction>[3];
    };
  };
  const tx = new SQLiteProxyTransaction("async", session.dialect, session, session.schema);
  Object.assign(tx, { execute: execute(state) });
  return tx;
}

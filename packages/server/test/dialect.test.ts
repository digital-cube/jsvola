import { isNull, type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { connect, type DatabaseHandle, type Executor } from "../src/db/index.js";
import { postgresDialect as dialect } from "../src/db/postgres.js";
import { fileMetadata, files, keyrings, processingJobs } from "../src/db/schema.js";
import { SqliteError, sqliteDialect, sqlitePath } from "../src/db/sqlite.js";
import { onSqlite } from "./helpers.js";

// The PostgreSQL dialect's helpers are pure: they render the same SQL whichever schema the
// process holds (the column names are the same), so they are checked on both runs.
const text = (query: SQL) => dialect.render(query).sql;
const sqliteText = (query: SQL) => sqliteDialect.render(query).sql;

describe("connect", () => {
  it.each(["sqlite:///var/vola.db", "mysql://vola:secret@localhost/vola", "ftp://u:secret@h/x"])(
    "refuses %s with a configuration error naming only the scheme",
    (url) => {
      let error: unknown;
      try {
        connect(url);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toContain(`unsupported scheme "${url.split(":")[0]}:"`);
      expect(message).toContain("postgres://, postgresql://, file:<path>, :memory:");
      expect(message).not.toContain("secret");
    },
  );

  it("refuses a URL without a scheme", () => {
    expect(() => connect("localhost:5432/vola")).toThrow(ConfigError);
    expect(() => connect("/var/vola.db")).toThrow(/no scheme/);
  });

  // PostgreSQL only: on the SQLite run the process speaks SQLite.
  it
    .skipIf(onSqlite)
    .each([
      "postgres://vola:vola@localhost:5432/vola",
      "POSTGRESQL://vola:vola@localhost:5432/vola",
    ])("opens %s as PostgreSQL (lazily: no connection until a query)", async (url) => {
    const handle = connect(url, { max: 1 });
    expect(handle.dialect).toBe(dialect);
    expect(handle.dialect.name).toBe("postgres");
    expect(handle).not.toHaveProperty("pool");
    await handle.close();
  });
});

describe("postgres dialect", () => {
  it("can search OCR text", () => {
    expect(dialect.capabilities.ocrSearch).toBe(true);
  });

  it("classifies unique violations and NOWAIT lock failures, also wrapped by drizzle", () => {
    expect(dialect.isUniqueViolation({ code: "23505" })).toBe(true);
    expect(dialect.isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(dialect.isUniqueViolation({ code: "55P03" })).toBe(false);
    expect(dialect.isUniqueViolation(new Error("boom"))).toBe(false);
    expect(dialect.isUniqueViolation(undefined)).toBe(false);
    expect(dialect.isLockNotAvailable({ cause: { code: "55P03" } })).toBe(true);
    expect(dialect.isLockNotAvailable({ code: "23505" })).toBe(false);
  });

  it("spells the expressions exactly as the queries did", () => {
    expect(text(sql`${dialect.countWhere(isNull(files.deletedAt))}`)).toBe(
      'count(*) filter (where "vola_file"."deleted_at" is null)',
    );
    expect(text(sql`${dialect.jsonText(keyrings.kdf, "pepper_line")}`)).toBe(
      `"vola_keyring"."kdf" ->> 'pepper_line'`,
    );
    const equals = dialect.render(dialect.jsonEquals(processingJobs.params, { size: 256 }));
    expect(equals.sql).toBe('"vola_processing_job"."params" = $1::jsonb');
    expect(equals.params).toEqual(['{"size":256}']);
    expect(text(dialect.ilike(files.filename, "%a%"))).toBe('"vola_file"."filename" ilike $1');
    const match = dialect.render(dialect.ocrMatch(fileMetadata.ocrTsv, "invoice 2026"));
    expect(match.sql).toBe(`"vola_file_metadata"."ocr_tsv" @@ plainto_tsquery('simple', $1)`);
    expect(match.params).toEqual(["invoice 2026"]);
  });

  it("refuses a JSON key it would have to spell into the SQL unescaped", () => {
    expect(() => dialect.jsonText(keyrings.kdf, "x'; drop table files; --")).toThrow(
      /not a plain JSON key/,
    );
  });

  it("locks a content hash, or any key, with a transaction-scoped advisory lock", async () => {
    const seen: string[] = [];
    const tx = {
      execute: async (query: SQL) => {
        const { sql: q, params } = dialect.render(query);
        seen.push(`${q} ${JSON.stringify(params)}`);
        return [];
      },
    } as unknown as Executor;
    await dialect.lockContentHash(tx, "abc");
    await dialect.lockKey(tx, "t/i/1");
    expect(seen).toEqual([
      'select pg_advisory_xact_lock(hashtextextended($1, 0)) ["abc"]',
      'select pg_advisory_xact_lock(hashtextextended($1, 0)) ["t/i/1"]',
    ]);
  });
});

// PostgreSQL only: the database of the run is PostgreSQL.
describe.skipIf(onSqlite)("postgres dialect against the database", () => {
  let handle: DatabaseHandle;
  beforeAll(() => {
    handle = connect(loadConfig().testDatabaseUrl, { max: 2 });
  });
  afterAll(async () => {
    await handle.close();
  });

  it("holds the hash lock until the transaction ends", async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const first = handle.db.transaction(async (tx) => {
      await handle.dialect.lockContentHash(tx, "dialect-test-hash");
      locked();
      await held;
      order.push("first done");
    });
    await isLocked;
    const second = handle.db.transaction(async (tx) => {
      await handle.dialect.lockContentHash(tx, "dialect-test-hash");
      order.push("second locked");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first done", "second locked"]);
  });

  it("evaluates the expressions on PostgreSQL", async () => {
    const one = (query: SQL) => sql`select ${query} as v`;
    const rows = async (query: SQL) =>
      ((await handle.db.execute(one(query))) as unknown as { rows: { v: unknown }[] }).rows;
    expect(
      await rows(sql`(select ${dialect.countWhere(sql`x > 1`)} from (values (1), (2), (3)) t(x))`),
    ).toEqual([{ v: "2" }]);
    expect(await rows(dialect.jsonText(sql`'{"pepper_line":"k1"}'::jsonb`, "pepper_line"))).toEqual(
      [{ v: "k1" }],
    );
    expect(await rows(dialect.jsonEquals(sql`'{"b":2,"a":1}'::jsonb`, { a: 1, b: 2 }))).toEqual([
      { v: true },
    ]);
    expect(await rows(dialect.ilike(sql`'Invoice.PDF'`, "%.pdf"))).toEqual([{ v: true }]);
    expect(
      await rows(
        dialect.ocrMatch(sql`to_tsvector('simple', 'the invoice of 2026')`, "invoice 2026"),
      ),
    ).toEqual([{ v: true }]);
  });
});

describe("sqlite dialect", () => {
  it("has no OCR search and no row locks", () => {
    expect(sqliteDialect.name).toBe("sqlite");
    expect(sqliteDialect.capabilities).toEqual({ ocrSearch: false, rowLocks: false });
    expect(() => sqliteDialect.ocrMatch(sql`x`, "words")).toThrow(/no full-text search/);
  });

  it("reads file: URLs and :memory:", () => {
    expect(sqlitePath(":memory:")).toBe(":memory:");
    expect(sqlitePath("file::memory:")).toBe(":memory:");
    expect(sqlitePath("file:///var/lib/vola/vola.db")).toBe("/var/lib/vola/vola.db");
    expect(sqlitePath("file:/var/lib/vola/my%20vola.db")).toBe("/var/lib/vola/my%20vola.db");
    expect(sqlitePath("file:///var/lib/vola/my%20vola.db")).toBe("/var/lib/vola/my vola.db");
    expect(sqlitePath("file:var/vola.db")).toBe(`${process.cwd()}/var/vola.db`);
    expect(() => sqlitePath("file://host/vola.db")).toThrow(ConfigError);
    expect(() => sqlitePath("file:")).toThrow(ConfigError);
  });

  it("classifies SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY as unique violations, also wrapped", () => {
    const unique = new SqliteError("UNIQUE constraint failed", "SQLITE_CONSTRAINT_UNIQUE", 2067);
    const pk = new SqliteError("PRIMARY KEY failed", "SQLITE_CONSTRAINT_PRIMARYKEY", 1555);
    const check = new SqliteError("CHECK constraint failed", "SQLITE_CONSTRAINT_CHECK", 275);
    expect(sqliteDialect.isUniqueViolation(unique)).toBe(true);
    expect(sqliteDialect.isUniqueViolation({ cause: unique })).toBe(true);
    expect(sqliteDialect.isUniqueViolation(pk)).toBe(true);
    expect(sqliteDialect.isUniqueViolation(check)).toBe(false);
    expect(sqliteDialect.isUniqueViolation({ code: "23505" })).toBe(false);
    expect(sqliteDialect.isLockNotAvailable({ code: "55P03" })).toBe(false);
  });

  it("spells the expressions in SQLite's SQL", () => {
    expect(sqliteText(sql`${sqliteDialect.countWhere(isNull(files.deletedAt))}`)).toBe(
      'count(*) filter (where "vola_file"."deleted_at" is null)',
    );
    expect(sqliteText(sql`${sqliteDialect.jsonText(keyrings.kdf, "pepper_line")}`)).toBe(
      `"vola_keyring"."kdf" ->> '$.pepper_line'`,
    );
    const equals = sqliteDialect.render(
      sqliteDialect.jsonEquals(processingJobs.params, { size: 256 }),
    );
    expect(equals.sql).toBe('json("vola_processing_job"."params") = json(?)');
    expect(equals.params).toEqual(['{"size":256}']);
    expect(sqliteText(sqliteDialect.like(files.filename, "a\\_%"))).toBe(
      `"vola_file"."filename" like ? escape '\\'`,
    );
    expect(sqliteText(sqliteDialect.ilike(files.filename, "%a%"))).toBe(
      `vola_casefold("vola_file"."filename") like vola_casefold(?) escape '\\'`,
    );
    expect(() => sqliteDialect.jsonText(keyrings.kdf, "x'; --")).toThrow(/not a plain JSON key/);
  });

  it("needs no lock statements: the transaction holds the one writer", async () => {
    const tx = {
      execute: () => Promise.reject(new Error("no SQL expected")),
    } as unknown as Executor;
    await sqliteDialect.lockContentHash(tx, "abc");
    await sqliteDialect.lockKey(tx, "t/i/1");
  });
});

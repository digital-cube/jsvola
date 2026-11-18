import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { connect, runMigrations, SQLITE_MIGRATIONS_FOLDER } from "../src/db/index.js";
import { fileMetadata, files, folders, OCR_TSV_MAX_CHARS } from "../src/db/schema.js";
import { sqlitePath } from "../src/db/sqlite.js";
import { resolveJobsMode } from "../src/jobs/availability.js";
import { ProcessingQueue } from "../src/jobs/queue.js";
import { findFileMetadata, saveOcrResult } from "../src/services/ocr.js";
import { createTenant } from "../src/services/tenants.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { pngFixture } from "./fixtures.js";
import {
  bearer,
  config,
  type Fixture,
  onSqlite,
  setupFixture,
  testDatabase,
  truncate,
} from "./helpers.js";
import { httpClient } from "./http.js";
import { fileUpload, multipartHeaders } from "./multipart.js";

const TYPE = "tickets";

describe("SQLite configuration", () => {
  it("lets the worker and OCR run on a SQLite file, refuses VOLA_WORKER_ENABLED=true on :memory:", () => {
    for (const url of ["file:var/vola.db", "file:///var/lib/vola/vola.db"]) {
      const on = loadConfig({
        VOLA_DATABASE_URL: url,
        VOLA_REDIS_URL: "redis://localhost:6379",
        VOLA_WORKER_ENABLED: "true",
        VOLA_OCR_ENABLED: "1",
      });
      expect(on.worker.enabled).toBe(true);
      expect(on.ocr.enabled).toBe(true);
    }
    for (const url of [":memory:", "file::memory:"]) {
      expect(() => loadConfig({ VOLA_DATABASE_URL: url, VOLA_WORKER_ENABLED: "true" })).toThrow(
        /VOLA_WORKER_ENABLED=true cannot work on :memory:/,
      );
      const auto = loadConfig({ VOLA_DATABASE_URL: url, VOLA_REDIS_URL: "redis://localhost:6379" });
      expect(auto.databaseUrl).toBe(url);
      expect(auto.worker.enabled).toBe("auto");
    }
    expect(() => loadConfig({ VOLA_DATABASE_URL: "mysql://h/db" })).toThrow(ConfigError);
  });

  it("runs jobs through the worker on a SQLite file, inline on :memory:", () => {
    const logged: unknown[] = [];
    const log = { info: (o: unknown) => logged.push(o), error: (o: unknown) => logged.push(o) };
    expect(resolveJobsMode({ enabled: "auto", redisUrl: "redis://x", memoryDatabase: false })).toBe(
      "async",
    );
    expect(
      resolveJobsMode({ enabled: "auto", redisUrl: "redis://x", memoryDatabase: true, log }),
    ).toBe("sync");
    expect(resolveJobsMode({ enabled: false, redisUrl: "redis://x", memoryDatabase: true })).toBe(
      "sync",
    );
    expect(() =>
      resolveJobsMode({ enabled: true, redisUrl: "redis://x", memoryDatabase: true }),
    ).toThrow(ConfigError);
    expect(logged).toEqual([expect.objectContaining({ reason: "in-memory SQLite database" })]);
  });
});

describe.runIf(onSqlite)("SQLite database", () => {
  const handle = testDatabase();
  let fx: Fixture;
  let root: string;
  let storage: FilesystemBackend;
  let http: ReturnType<typeof httpClient>;

  beforeAll(async () => {
    await truncate(handle);
    root = await mkdtemp(join(tmpdir(), "vola-sqlite-"));
    storage = new FilesystemBackend(join(root, "storage"));
    fx = await setupFixture(handle, { storage, uploadSweepIntervalMs: 0 });
    http = httpClient(fx.app, fx.full.key, TYPE);
  });
  afterAll(async () => {
    await fx.app.close();
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });

  it("applies the migrations to an empty file, twice without harm", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vola-sqlite-migrate-"));
    const fresh = connect(`file:${join(dir, "nested", "vola.db")}`);
    try {
      await runMigrations(fresh.db);
      await runMigrations(fresh.db);
      const tables = (await fresh.db.execute(
        sql`select name from sqlite_master where type = 'table' and name like 'vola\\_%' escape '\\' order by name`,
      )) as unknown as { rows: { name: string }[] };
      expect(tables.rows.map((r) => r.name)).toEqual([
        "vola_access_token",
        "vola_apikey",
        "vola_file",
        "vola_file_metadata",
        "vola_file_ocr_fts",
        "vola_file_ocr_fts_config",
        "vola_file_ocr_fts_data",
        "vola_file_ocr_fts_doc",
        "vola_file_ocr_fts_docsize",
        "vola_file_ocr_fts_idx",
        "vola_folder",
        "vola_keyring",
        "vola_processing_job",
        "vola_share_link",
        "vola_tenant",
        "vola_tenant_stats",
        "vola_upload",
      ]);
      const pragmas = (await fresh.db.execute(
        sql`select * from pragma_journal_mode(), pragma_foreign_keys()`,
      )) as unknown as { rows: Record<string, unknown>[] };
      expect(pragmas.rows[0]).toEqual({ journal_mode: "wal", foreign_keys: 1 });
      // The partial unique index and the CHECK constraints came along.
      const index = (await fresh.db.execute(
        sql`select sql from sqlite_master where name = 'vola_folder_path_live_uq'`,
      )) as unknown as { rows: { sql: string }[] };
      expect(index.rows[0]?.sql).toMatch(/WHERE "vola_folder"."deleted_at" is null/);
    } finally {
      await fresh.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ends two concurrent uploads of the same content as one blob", async () => {
    const data = Buffer.from(`same bytes ${randomUUID()}`);
    const hash = createHash("sha256").update(data).digest("hex");
    const instanceId = randomUUID();
    const [a, b] = await Promise.all([
      http.upload(data, "a.txt", { instanceId }),
      http.upload(data, "b.txt", { instanceId }),
    ]);
    expect(a.response.statusCode).toBe(201);
    expect(b.response.statusCode).toBe(201);
    const rows = await handle.db.select().from(files).where(eq(files.hash, hash));
    expect(rows).toHaveLength(2);
    expect((await stat(storage.blobPath(hash))).size).toBe(data.length);
    const blobs = await readdir(join(root, "storage", "blobs"), { recursive: true });
    expect(blobs.filter((name) => name.endsWith(hash))).toHaveLength(1);
  });

  it("keeps one live file per slug under concurrent upserts", async () => {
    const instanceId = randomUUID();
    const upsert = (body: string) =>
      fx.app.inject({
        method: "PUT",
        url: `/vola/files/${TYPE}/${instanceId}/slug/avatar`,
        headers: multipartHeaders(bearer(fx.full.key)),
        payload: fileUpload("avatar.txt", Buffer.from(body)),
      });
    const answers = await Promise.all([upsert("one"), upsert("two"), upsert("three")]);
    for (const answer of answers) expect(answer.statusCode, answer.body).toBeLessThan(300);
    const live = await handle.db
      .select()
      .from(files)
      .where(
        and(eq(files.instanceId, instanceId), eq(files.slug, "avatar"), isNull(files.deletedAt)),
      );
    expect(live).toHaveLength(1);
  });

  it("answers a folder-name collision with 409 folder_exists, as on PostgreSQL", async () => {
    const instanceId = randomUUID();
    const F = (path: string) => `/vola/folders/${TYPE}/${instanceId}/${path}`;
    // Creating the same path twice at once: one folder.
    const created = await Promise.all([http.post(F("docs/x")), http.post(F("docs/x"))]);
    expect(created.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    const live = await handle.db
      .select()
      .from(folders)
      .where(and(eq(folders.instanceId, instanceId), isNull(folders.deletedAt)));
    expect(live.map((f) => f.path).sort()).toEqual(["docs", "docs/x"]);
    // Two renames to one name at once: the unique index refuses the second.
    await http.post(F("docs/y"));
    const renamed = await Promise.all([
      http.patch(F("docs/x"), { name: "z" }),
      http.patch(F("docs/y"), { name: "z" }),
    ]);
    expect(renamed.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const refused = renamed.find((r) => r.statusCode === 409);
    expect(refused?.json().error.code).toBe("folder_exists");
  });

  it("with a job queue: queues the OCR and thumbnail jobs, and keeps the upload sweep itself", async () => {
    expect(config.redisUrl, "VOLA_REDIS_URL is needed for this test").toBeTruthy();
    const queue = new ProcessingQueue({
      redisUrl: config.redisUrl as string,
      prefix: `vola-sqlite-${randomUUID().slice(0, 8)}`,
    });
    const app = await buildApp({
      config,
      db: handle.db,
      logger: false,
      storage,
      jobs: queue,
      uploadSweepIntervalMs: 60_000,
      statsRefreshIntervalMs: 0,
    });
    try {
      await app.ready();
      const queued = httpClient(app, fx.full.key, TYPE);
      const { response } = await queued.upload(await pngFixture(), "scan.png");
      expect(response.statusCode).toBe(201);
      expect(response.json().processing_status).toBe("PENDING");
      const kinds = (await handle.db.execute(
        sql`select kind from vola_processing_job where file_id = ${response.json().id} order by kind`,
      )) as unknown as { rows: { kind: string }[] };
      expect([...new Set(kinds.rows.map((r) => r.kind))]).toEqual(["OCR", "THUMBNAIL"]);
      // The upload a PATCH holds lives in this process's memory: the worker must not sweep.
      expect(await queue.queue.getJobSchedulers()).toEqual([]);
    } finally {
      await app.close();
      await queue.queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
  });

  it("records no processing job without a queue: thumbnails render inline", async () => {
    const { response } = await http.upload(Buffer.from("%PDF-1.4\n%%EOF\n"), "scan.pdf");
    expect(response.statusCode).toBe(201);
    expect(response.json().processing_status).toBeNull();
    const jobs = (await handle.db.execute(
      sql`select count(*) as n from vola_processing_job where file_id = ${response.json().id}`,
    )) as unknown as { rows: { n: number }[] };
    expect(jobs.rows[0]?.n).toBe(0);
  });

  it("keeps one dialect per process", () => {
    expect(() => connect("postgres://vola:vola@localhost:5432/vola")).toThrow(
      /already uses sqlite/,
    );
  });

  it("reports the database healthy", async () => {
    const ready = await fx.app.inject({ method: "GET", url: "/vola/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ok", checks: { database: "ok" } });
  });

  it("matches LIKE case-sensitively with \\ escapes, and ilike beyond ASCII", async () => {
    const { sqliteDialect: d } = await import("../src/db/sqlite.js");
    const v = async (expr: ReturnType<typeof d.like>) =>
      (
        (await handle.db.execute(sql`select ${expr} as v`)) as unknown as {
          rows: { v: number }[];
        }
      ).rows[0]?.v;
    expect(await v(d.like(sql`'Docs/a'`, "docs/%"))).toBe(0);
    expect(await v(d.like(sql`'docs/a'`, "docs/%"))).toBe(1);
    expect(await v(d.like(sql`'a_b'`, "a\\_b"))).toBe(1);
    expect(await v(d.like(sql`'axb'`, "a\\_b"))).toBe(0);
    expect(await v(d.ilike(sql`'ŽUTO.PDF'`, "%žuto%"))).toBe(1);
    expect(await v(d.countWhere(sql`1`) as never)).toBe(1);
    expect(await v(d.jsonText(sql`'{"k":"v"}'`, "k") as never)).toBe("v" as never);
    expect(await v(d.jsonEquals(sql`'{ "a": 1 }'`, { a: 1 }))).toBe(1);
  });
});

describe.runIf(onSqlite)("SQLite OCR search (FTS5)", () => {
  const handle = testDatabase();
  let fx: Fixture;
  let root: string;
  const instanceId = randomUUID();

  beforeAll(async () => {
    await truncate(handle);
    root = await mkdtemp(join(tmpdir(), "vola-sqlite-fts-"));
    fx = await setupFixture(handle, {
      storage: new FilesystemBackend(join(root, "storage")),
      uploadSweepIntervalMs: 0,
    });
  });
  afterAll(async () => {
    await fx.app.close();
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A file of the instance, with `text` as its OCR text (none for `null`). */
  async function scanned(text: string | null, name = "scan.png"): Promise<string> {
    const [row] = await handle.db
      .insert(files)
      .values({
        tenantId: fx.tenant.id,
        instanceType: TYPE,
        instanceId,
        hash: createHash("sha256").update(randomUUID()).digest("hex"),
        size: 1,
        filename: name,
        mimeType: "image/png",
        kind: "image",
      })
      .returning();
    const id = (row as { id: string }).id;
    if (text !== null) await ocrSaved(id, text);
    return id;
  }
  const ocrSaved = (fileId: string, text: string) =>
    saveOcrResult(handle.db, {
      fileId,
      tenantId: fx.tenant.id,
      text,
      lang: "eng+srp",
      pages: 1,
      at: new Date(),
    });

  /** The ids the files list answers for `ocr <op> <value>` within the instance. */
  async function found(op: string, value?: unknown): Promise<string[]> {
    const answer = await fx.app.inject({
      method: "POST",
      url: "/vola/udc/list",
      headers: { ...bearer(fx.readOnly.key), "x-udc-message-id": "m1" },
      payload: {
        collection: "files",
        filter: {
          and: [
            { field: "instance_type", op: "eq", value: TYPE },
            { field: "instance_id", op: "eq", value: instanceId },
            { field: "ocr", op, ...(value === undefined ? {} : { value }) },
          ],
        },
        page: { limit: 100 },
      },
    });
    expect(answer.statusCode).toBe(200);
    const body = answer.json() as { kind: string; payload: { rows: { id: string }[] } };
    expect(body.kind, JSON.stringify(body.payload)).toBe("udc.list.ok");
    return body.payload.rows.map((r) => r.id).sort();
  }
  const sorted = (...ids: string[]) => [...ids].sort();

  let invoice: string;
  let racun: string;
  let operators: string;
  let none: string;

  beforeAll(async () => {
    invoice = await scanned("INVOICE No. 2026-117\nTotal due: 42 EUR\fPage two: payment terms");
    racun = await scanned("Račun broj 7 — Čačak, Žička 12");
    operators = await scanned('Notes: "quoted" a OR b, NEAR the end; minus-sign and star*');
    none = await scanned(null, "photo.png");
  });

  it("finds a file by one word, and by several (every word must occur)", async () => {
    expect(await found("contains", "invoice")).toEqual([invoice]);
    expect(await found("contains", "total 42 eur")).toEqual([invoice]);
    // A word on the second page of a PDF (pages are joined with a form feed).
    expect(await found("contains", "payment")).toEqual([invoice]);
    expect(await found("contains", "invoice payment čačak")).toEqual([]);
    // `eq <words>` is the same search, `neq` its complement (a file without text included).
    expect(await found("eq", "invoice")).toEqual([invoice]);
    expect(await found("neq", "invoice")).toEqual(sorted(racun, operators, none));
  });

  it("is case-insensitive, beyond ASCII", async () => {
    expect(await found("contains", "InVoIcE")).toEqual([invoice]);
    expect(await found("contains", "ČAČAK račun")).toEqual([racun]);
    expect(await found("contains", "žička")).toEqual([racun]);
  });

  it("keeps diacritics: č and c are different letters, as in PostgreSQL's simple configuration", async () => {
    expect(await found("contains", "Čačak")).toEqual([racun]);
    expect(await found("contains", "cacak")).toEqual([]);
    expect(await found("contains", "racun")).toEqual([]);
    expect(await found("contains", "zicka")).toEqual([]);
  });

  it("treats FTS5 syntax in the input as plain text: no other meaning, no SQL error", async () => {
    // `OR` is a word that has to be there, not an operator: the invoice has neither.
    expect(await found("contains", "a OR b")).toEqual([operators]);
    expect(await found("contains", "invoice OR quoted")).toEqual([]);
    expect(await found("contains", '"quoted"')).toEqual([operators]);
    expect(await found("contains", 'quoted"')).toEqual([operators]);
    expect(await found("contains", "NEAR(quoted end)")).toEqual([operators]);
    expect(await found("contains", "star*")).toEqual([operators]);
    // A prefix query would have found "star"; no prefix search here.
    expect(await found("contains", "sta*")).toEqual([]);
    expect(await found("contains", "-sign minus")).toEqual([operators]);
    expect(await found("contains", "ocr_text:notes")).toEqual([]);
    expect(await found("contains", "^notes")).toEqual([operators]);
    expect(await found("contains", "notes AND NOT end")).toEqual([]);
    expect(await found("contains", "(notes")).toEqual([operators]);
    expect(await found("contains", "'; drop table vola_file; --")).toEqual([]);
    expect((await handle.db.select().from(files)).length).toBeGreaterThan(0);
    // Nothing but punctuation: no word, nothing found (PostgreSQL: an empty tsquery).
    expect(await found("contains", '" * : -')).toEqual([]);
    expect(await found("contains", "   ")).toEqual([]);
  });

  it("selects files with or without text through the yes/no forms", async () => {
    const withText = sorted(invoice, racun, operators);
    expect(await found("eq", true)).toEqual(withText);
    expect(await found("is_not_null")).toEqual(withText);
    expect(await found("eq", false)).toEqual([none]);
    expect(await found("is_null")).toEqual([none]);
    expect(await found("neq", true)).toEqual([none]);
  });

  it("follows an update and a delete of ocr_text", async () => {
    const id = await scanned("first version receipt");
    expect(await found("contains", "receipt")).toEqual([id]);
    // A second OCR pass replaces the text: the old words go, the new ones are found.
    await ocrSaved(id, "second version contract");
    expect(await found("contains", "receipt")).toEqual([]);
    expect(await found("contains", "contract")).toEqual([id]);
    // Text set to NULL (an encrypted pass keeps it sealed in ocr_ct): out of the index.
    await handle.db.update(fileMetadata).set({ ocrText: null }).where(eq(fileMetadata.fileId, id));
    expect(await found("contains", "contract")).toEqual([]);
    await ocrSaved(id, "third version contract");
    expect(await found("contains", "contract")).toEqual([id]);
    // The sidecar row deleted, and the file purged (the row cascades): gone from the index.
    await handle.db.delete(fileMetadata).where(eq(fileMetadata.fileId, id));
    expect(await found("contains", "contract")).toEqual([]);
    await ocrSaved(id, "fourth version contract");
    await handle.db.delete(files).where(eq(files.id, id));
    expect(await found("contains", "contract")).toEqual([]);
    const entries = (await handle.db.execute(
      sql`select (select count(*) from vola_file_ocr_fts_doc) as docs, (select count(*) from vola_file_metadata where coalesce(ocr_text, '') <> '') as texts`,
    )) as unknown as { rows: { docs: number; texts: number }[] };
    expect(entries.rows[0]?.docs).toBe(entries.rows[0]?.texts);
  });

  it("indexes the first 500000 characters, as ocr_tsv does", async () => {
    const id = await scanned(`${"lorem ".repeat(100_000)}needle`);
    expect(OCR_TSV_MAX_CHARS).toBe(500_000);
    expect(await found("contains", "lorem")).toContain(id);
    expect(await found("contains", "needle")).toEqual([]);
  });
});

describe.runIf(onSqlite)("SQLite OCR index migration", () => {
  it("indexes the text that is already there when the migration runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vola-sqlite-fts-migrate-"));
    // The migrations up to the one before the index.
    const before = join(dir, "migrations");
    await cp(SQLITE_MIGRATIONS_FOLDER, before, { recursive: true });
    const journal = JSON.parse(await readFile(join(before, "meta", "_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => e.tag === "0000_init");
    await writeFile(join(before, "meta", "_journal.json"), JSON.stringify(journal));
    const db = connect(`file:${join(dir, "vola.db")}`);
    try {
      await db.dialect.migrate(db.db, before);
      const tenant = await createTenant(db.db, { slug: "pre", name: "Pre" });
      const [file] = await db.db
        .insert(files)
        .values({
          tenantId: tenant.id,
          instanceType: TYPE,
          instanceId: randomUUID(),
          hash: "0".repeat(64),
          size: 1,
          filename: "old.png",
          mimeType: "image/png",
          kind: "image",
        })
        .returning();
      const fileId = (file as { id: string }).id;
      await db.db
        .insert(fileMetadata)
        .values({ fileId, tenantId: tenant.id, ocrText: "Imported before the index existed" });
      await runMigrations(db.db);
      const hits = await db.db
        .select({ id: fileMetadata.fileId })
        .from(fileMetadata)
        .where(db.dialect.ocrMatch("imported INDEX"));
      expect(hits).toEqual([{ id: fileId }]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(onSqlite)("SQLite: server and worker writing to one file", () => {
  // Two handles on the test file: two connections, which SQLite locks against each other
  // exactly as it locks two processes — and, below, a second process for real.
  const server = testDatabase();
  const worker = testDatabase();
  let tenantId: string;
  let fileIds: string[];

  beforeAll(async () => {
    await truncate(server);
    tenantId = (await createTenant(server.db, { slug: "busy", name: "Busy" })).id;
    const rows = await server.db
      .insert(files)
      .values(
        Array.from({ length: 40 }, (_, i) => ({
          tenantId,
          instanceType: TYPE,
          instanceId: randomUUID(),
          hash: createHash("sha256").update(`busy ${i}`).digest("hex"),
          size: 1,
          filename: `scan-${i}.png`,
          mimeType: "image/png",
          kind: "image",
        })),
      )
      .returning({ id: files.id });
    fileIds = rows.map((r) => r.id);
  });
  afterAll(async () => {
    await worker.close();
    await server.close();
  });

  const save = (handle: typeof server, fileId: string, text: string) =>
    saveOcrResult(handle.db, { fileId, tenantId, text, lang: "eng", pages: 1, at: new Date() });

  it("interleaves the writes of both without SQLITE_BUSY", async () => {
    const work: Promise<unknown>[] = [];
    for (const [i, fileId] of fileIds.entries()) {
      // The worker stores OCR text; the server, at the same time, runs transactions.
      work.push(save(worker, fileId, `busy text ${i}`));
      work.push(
        server.db.transaction(async (tx) => {
          await tx
            .update(files)
            .set({ filename: `renamed-${i}.png` })
            .where(eq(files.id, fileId));
          await new Promise((resolve) => setTimeout(resolve, 2));
        }),
      );
    }
    const results = await Promise.allSettled(work);
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const hits = await server.db
      .select({ id: fileMetadata.fileId })
      .from(fileMetadata)
      .where(server.dialect.ocrMatch("busy text"));
    expect(hits).toHaveLength(fileIds.length);
  });

  it("waits for a transaction another connection holds open without stopping the event loop", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let begun!: () => void;
      const isBegun = new Promise<void>((resolve) => {
        begun = resolve;
      });
      const held = server.db.transaction(async (tx) => {
        await tx
          .update(files)
          .set({ filename: "held.png" })
          .where(eq(files.id, fileIds[0] as string));
        begun();
        await released;
      });
      await isBegun;
      const write = save(worker, fileIds[1] as string, "written while held");
      const before = ticks;
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The waiting writer did not block this process: the timer kept firing.
      expect(ticks - before).toBeGreaterThan(20);
      release();
      await held;
      await write;
      expect((await findFileMetadata(server.db, fileIds[1] as string))?.ocrText).toBe(
        "written while held",
      );
    } finally {
      clearInterval(timer);
    }
  });

  it("waits for another PROCESS holding the write lock, then writes", async () => {
    const path = sqlitePath(config.testDatabaseUrl);
    // A child holding BEGIN IMMEDIATE for 500 ms, sleeping synchronously inside it.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("pragma busy_timeout = 10000");
db.exec("begin immediate");
db.prepare("update vola_file_metadata set ocr_lang = 'child' where file_id = ?").run(process.argv[2]);
process.stdout.write("locked\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
db.exec("commit");
db.close();`,
        path,
        fileIds[2] as string,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    const started = Date.now();
    await save(server, fileIds[3] as string, "after the child");
    expect(Date.now() - started).toBeGreaterThan(200);
    expect(await exited).toBe(0);
    expect((await findFileMetadata(server.db, fileIds[3] as string))?.ocrText).toBe(
      "after the child",
    );
    expect((await findFileMetadata(server.db, fileIds[2] as string))?.ocrLang).toBe("child");
  });
});

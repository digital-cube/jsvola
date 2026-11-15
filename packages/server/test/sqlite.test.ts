import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { connect, runMigrations } from "../src/db/index.js";
import { files, folders } from "../src/db/schema.js";
import { resolveJobsMode } from "../src/jobs/availability.js";
import type { ProcessingQueue } from "../src/jobs/queue.js";
import { FilesystemBackend } from "../src/storage/index.js";
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
  it("refuses VOLA_WORKER_ENABLED=true (and VOLA_OCR_ENABLED=true) at start", () => {
    for (const url of ["file:var/vola.db", "file:///var/lib/vola/vola.db", ":memory:"]) {
      expect(() => loadConfig({ VOLA_DATABASE_URL: url, VOLA_WORKER_ENABLED: "true" })).toThrow(
        /VOLA_WORKER_ENABLED=true needs PostgreSQL/,
      );
      expect(() => loadConfig({ VOLA_DATABASE_URL: url, VOLA_OCR_ENABLED: "1" })).toThrow(
        /VOLA_OCR_ENABLED=true needs PostgreSQL/,
      );
      const auto = loadConfig({ VOLA_DATABASE_URL: url, VOLA_REDIS_URL: "redis://localhost:6379" });
      expect(auto.databaseUrl).toBe(url);
      expect(auto.worker.enabled).toBe("auto");
    }
    // PostgreSQL keeps every combination.
    expect(
      loadConfig({ VOLA_DATABASE_URL: "postgres://a:b@h/db", VOLA_WORKER_ENABLED: "true" }).worker
        .enabled,
    ).toBe(true);
    expect(() => loadConfig({ VOLA_DATABASE_URL: "mysql://h/db" })).toThrow(ConfigError);
  });

  it("runs every job inline on SQLite, whatever Redis says", () => {
    const logged: unknown[] = [];
    const log = { info: (o: unknown) => logged.push(o), error: (o: unknown) => logged.push(o) };
    expect(resolveJobsMode({ enabled: "auto", redisUrl: "redis://x", sqlite: true, log })).toBe(
      "sync",
    );
    expect(resolveJobsMode({ enabled: false, redisUrl: "redis://x", sqlite: true })).toBe("sync");
    expect(() => resolveJobsMode({ enabled: true, redisUrl: "redis://x", sqlite: true })).toThrow(
      ConfigError,
    );
    expect(resolveJobsMode({ enabled: "auto", redisUrl: "redis://x", sqlite: false })).toBe(
      "async",
    );
    expect(logged).toEqual([expect.objectContaining({ reason: "SQLite database" })]);
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
        "vola_apikey",
        "vola_file",
        "vola_file_metadata",
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

  it("refuses the OCR text search of the files list as unsupported_op, not a 500", async () => {
    const answer = await fx.app.inject({
      method: "POST",
      url: "/vola/udc/list",
      headers: { ...bearer(fx.readOnly.key), "x-udc-message-id": "m1" },
      payload: {
        collection: "files",
        filter: {
          and: [
            { field: "instance_type", op: "eq", value: TYPE },
            { field: "ocr", op: "contains", value: "invoice" },
          ],
        },
      },
    });
    expect(answer.statusCode).toBe(200);
    const body = answer.json() as { kind: string; payload: { code: string; message: string } };
    expect(body.kind).toBe("udc.list.err");
    expect(body.payload.code).toBe("unsupported_op");
    expect(body.payload.message).toMatch(/not supported on this database \(sqlite\)/);
    // The yes/no flag still works: no file has OCR text here.
    const flag = await fx.app.inject({
      method: "POST",
      url: "/vola/udc/list",
      headers: { ...bearer(fx.readOnly.key), "x-udc-message-id": "m2" },
      payload: {
        collection: "files",
        filter: {
          and: [
            { field: "instance_type", op: "eq", value: TYPE },
            { field: "ocr", op: "eq", value: true },
          ],
        },
      },
    });
    expect(flag.json()).toMatchObject({ kind: "udc.list.ok", payload: { rows: [] } });
  });

  it("records no processing job: thumbnails render inline", async () => {
    const { response } = await http.upload(Buffer.from("%PDF-1.4\n%%EOF\n"), "scan.pdf");
    expect(response.statusCode).toBe(201);
    expect(response.json().processing_status).toBeNull();
    const jobs = (await handle.db.execute(
      sql`select count(*) as n from vola_processing_job`,
    )) as unknown as { rows: { n: number }[] };
    expect(jobs.rows[0]?.n).toBe(0);
  });

  it("refuses a job queue (the worker) when the app is built on SQLite", async () => {
    const queue = { queue: { name: "q" }, prefix: "p" } as unknown as ProcessingQueue;
    await expect(
      buildApp({ config, db: handle.db, logger: false, storage, jobs: queue }),
    ).rejects.toThrow(/needs PostgreSQL/);
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

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileInfoSchema, StorageStatsSchema, TenantStatsSchema } from "@vola/core";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { files, tenantStats } from "../src/db/schema.js";
import { ProcessingQueue, REFRESH_STATS_JOB } from "../src/jobs/queue.js";
import { ProcessingWorker } from "../src/jobs/worker.js";
import {
  computeStats,
  getStats,
  readStats,
  refreshStaleStats,
  type StatsDeps,
} from "../src/services/stats.js";
import { createTenant } from "../src/services/tenants.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { pdfFixture, pngFixture, waitFor } from "./fixtures.js";
import {
  bearer,
  config,
  type Fixture,
  mintKey,
  setupFixture,
  testDatabase,
  truncate,
} from "./helpers.js";
import { httpClient } from "./http.js";

const handle = testDatabase(5);
let fx: Fixture;
let app: FastifyInstance;
let root: string;
let uploadsPath: string;
let storage: FilesystemBackend;
let http: ReturnType<typeof httpClient>;
let other: { tenantId: string; slug: string; key: string };

const TYPE = "tickets";

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-stats-"));
  uploadsPath = join(root, "uploads");
  storage = new FilesystemBackend(root);
  fx = await setupFixture(handle, { storage, uploadsPath, uploadSweepIntervalMs: 0 });
  app = fx.app;
  await app.ready();
  http = httpClient(app, fx.full.key, TYPE);
  const tenant = await createTenant(handle.db, { slug: "other" });
  const key = await mintKey(handle, tenant.id, "other-full", "live", ["files:read", "files:write"]);
  other = { tenantId: tenant.id, slug: tenant.slug, key: key.key };
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

async function uploaded(
  data: Buffer,
  filename: string,
  options: { instanceId?: string; key?: string; contentType?: string } = {},
) {
  const { response, instanceId } = await http.upload(data, filename, options);
  expect(response.statusCode, response.body).toBe(201);
  return { info: FileInfoSchema.parse(response.json()), instanceId };
}

const tenantStatsOf = async (key = fx.full.key, query = "") => {
  const response = await http.get(`/vola/stats/tenant${query}`, {}, key);
  expect(response.statusCode, response.body).toBe(200);
  return TenantStatsSchema.parse(response.json());
};

describe("GET /stats/tenant and /stats/instance", () => {
  it("aggregates the live files of the tenant: count, bytes, by kind, oldest and newest", async () => {
    const instanceId = randomUUID();
    const png = await pngFixture();
    const sizes = [
      (await uploaded(png, "a.png", { instanceId })).info.size,
      (await uploaded(png, "b.png", { instanceId })).info.size, // the same bytes: one blob, two files
      (await uploaded(pdfFixture(), "c.pdf", { instanceId })).info.size,
      (await uploaded(Buffer.from("hello world"), "d.txt", { instanceId })).info.size,
    ];
    const stats = await tenantStatsOf(fx.full.key, "?recompute=1");
    expect(stats).toMatchObject({
      tenant_id: fx.tenant.id,
      scope: "tenant",
      instance_type: null,
      instance_id: null,
      total_files: 4,
      total_bytes: sizes.reduce((a, b) => a + b, 0),
      by_kind: { image: 2, document: 1, text: 1 },
    });
    expect(stats.oldest_at).not.toBeNull();
    expect(stats.newest_at).not.toBeNull();
    expect(new Date(stats.oldest_at as string).getTime()).toBeLessThanOrEqual(
      new Date(stats.newest_at as string).getTime(),
    );
    expect(Date.now() - new Date(stats.computed_at).getTime()).toBeLessThan(10_000);
  });

  it("scopes an instance to its own files while the tenant snapshot covers all of them", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await uploaded(Buffer.from("a1"), "a1.txt", { instanceId: a });
    await uploaded(Buffer.from("a2"), "a2.txt", { instanceId: a });
    await uploaded(Buffer.from("b1"), "b1.txt", { instanceId: b });
    const ra = await http.get(`/vola/stats/instance/${TYPE}/${a}?recompute=1`);
    const rb = await http.get(`/vola/stats/instance/${TYPE}/${b}`);
    expect(ra.statusCode, ra.body).toBe(200);
    expect(TenantStatsSchema.parse(ra.json())).toMatchObject({
      scope: "instance",
      instance_type: TYPE,
      instance_id: a,
      total_files: 2,
      total_bytes: 4,
      by_kind: { text: 2 },
    });
    expect(TenantStatsSchema.parse(rb.json())).toMatchObject({ instance_id: b, total_files: 1 });
    expect((await tenantStatsOf(fx.full.key, "?recompute=1")).total_files).toBeGreaterThanOrEqual(
      7,
    );
    // An unknown instance has an (empty) snapshot of its own; a bad instance is 422.
    const empty = await http.get(`/vola/stats/instance/${TYPE}/${randomUUID()}`);
    expect(TenantStatsSchema.parse(empty.json())).toMatchObject({
      total_files: 0,
      total_bytes: 0,
      by_kind: {},
      oldest_at: null,
      newest_at: null,
    });
    expect((await http.get(`/vola/stats/instance/Tickets/${a}`)).statusCode).toBe(422);
    expect((await http.get(`/vola/stats/instance/${TYPE}/not-a-uuid`)).statusCode).toBe(422);
  });

  it("is computed lazily on the first read, then served from the snapshot until ?recompute=1", async () => {
    const tenant = await createTenant(handle.db, { slug: "lazy" });
    const key = (await mintKey(handle, tenant.id, "lazy", "live", ["files:read", "files:write"]))
      .key;
    expect(await readStats({ db: handle.db }, { tenantId: tenant.id, scope: "tenant" })).toBeNull();
    const instanceId = randomUUID();
    await uploaded(Buffer.from("one"), "one.txt", { instanceId, key });

    const first = await tenantStatsOf(key);
    expect(first.total_files).toBe(1);
    expect(await handle.db.$count(tenantStats, eq(tenantStats.tenantId, tenant.id))).toBe(1);

    await uploaded(Buffer.from("two"), "two.txt", { instanceId, key });
    const cached = await tenantStatsOf(key);
    expect(cached.total_files).toBe(1);
    expect(cached.computed_at).toBe(first.computed_at);
    const fresh = await tenantStatsOf(key, "?recompute=1");
    expect(fresh.total_files).toBe(2);
    expect(fresh.computed_at).not.toBe(first.computed_at);
    expect(await handle.db.$count(tenantStats, eq(tenantStats.tenantId, tenant.id))).toBe(1);
  });

  it("recomputes a snapshot older than staleAfterMs on read (no worker)", async () => {
    const tenant = await createTenant(handle.db, { slug: "stale" });
    let now = new Date(); // real time: an old fixed date would look stale to the refresh test below
    const deps: StatsDeps = { db: handle.db, now: () => now, staleAfterMs: 60_000 };
    const target = { tenantId: tenant.id, scope: "tenant" } as const;
    const first = await getStats(deps, target);
    expect(first.computed_at).toBe(now.toISOString());
    now = new Date(now.getTime() + 30_000);
    expect((await getStats(deps, target)).computed_at).toBe(first.computed_at);
    now = new Date(now.getTime() + 31_000);
    expect((await getStats(deps, target)).computed_at).toBe(now.toISOString());
  });

  it("leaves soft-deleted files out, after a recompute", async () => {
    const tenant = await createTenant(handle.db, { slug: "softdel" });
    const key = (await mintKey(handle, tenant.id, "softdel", "live", ["files:read", "files:write"]))
      .key;
    const instanceId = randomUUID();
    const { info } = await uploaded(Buffer.from("x"), "x.txt", { instanceId, key });
    await uploaded(Buffer.from("yy"), "y.txt", { instanceId, key });
    expect((await tenantStatsOf(key, "?recompute=1")).total_files).toBe(2);
    await http.del(`/vola/files/${TYPE}/${instanceId}/${info.id}`, {}, key);
    const after = await tenantStatsOf(key, "?recompute=1");
    expect(after).toMatchObject({ total_files: 1, total_bytes: 2, by_kind: { text: 1 } });
  });

  it("isolates tenants, needs files:read, and an admin key needs X-Tenant-Slug", async () => {
    await uploaded(Buffer.from("ours"), "ours.txt");
    const theirs = await tenantStatsOf(other.key, "?recompute=1");
    expect(theirs).toMatchObject({ tenant_id: other.tenantId, total_files: 0, by_kind: {} });

    expect((await app.inject({ method: "GET", url: "/vola/stats/tenant" })).statusCode).toBe(401);
    const noScope = await mintKey(handle, fx.tenant.id, "folders-only", "live", ["folders:read"]);
    const forbidden = await http.get("/vola/stats/tenant", {}, noScope.key);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.required).toEqual(["files:read"]);

    const noTenant = await http.get("/vola/stats/tenant", {}, fx.admin.key);
    expect(noTenant.statusCode).toBe(400);
    expect(noTenant.json().error.code).toBe("tenant_required");
    const asAdmin = await http.get(
      "/vola/stats/tenant?recompute=1",
      { "x-tenant-slug": other.slug },
      fx.admin.key,
    );
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json().tenant_id).toBe(other.tenantId);
  });
});

describe("GET /stats/storage", () => {
  it("gives a tenant its logical bytes and distinct blobs, an admin the disk too", async () => {
    const tenant = await createTenant(handle.db, { slug: "store" });
    const key = (await mintKey(handle, tenant.id, "store", "live", ["files:read", "files:write"]))
      .key;
    const same = Buffer.from("same bytes twice");
    const instanceId = randomUUID();
    await uploaded(same, "one.bin", { instanceId, key });
    await uploaded(same, "two.bin", { instanceId, key });
    await uploaded(Buffer.from("different"), "three.bin", { instanceId, key });

    const mine = await http.get("/vola/stats/storage", {}, key);
    expect(mine.statusCode, mine.body).toBe(200);
    const tenantView = StorageStatsSchema.parse(mine.json());
    expect(tenantView).toMatchObject({
      scope: "tenant",
      tenant_id: tenant.id,
      files: 3,
      logical_bytes: same.length * 2 + 9,
      unique_blobs: 2,
      unique_bytes: same.length + 9,
      physical: null,
    });

    // An admin with the tenant selected: the same numbers plus the disk.
    await mkdir(uploadsPath, { recursive: true });
    await writeFile(join(uploadsPath, `${randomUUID()}.part`), Buffer.alloc(100));
    const adminTenant = await http.get(
      "/vola/stats/storage",
      { "x-tenant-slug": tenant.slug },
      fx.admin.key,
    );
    expect(adminTenant.statusCode, adminTenant.body).toBe(200);
    const adminView = StorageStatsSchema.parse(adminTenant.json());
    expect(adminView).toMatchObject({
      scope: "tenant",
      tenant_id: tenant.id,
      files: 3,
      unique_blobs: 2,
    });
    expect(adminView.physical).not.toBeNull();
    const physical = adminView.physical as NonNullable<typeof adminView.physical>;
    expect(physical.uploads).toEqual({ bytes: 100, count: 1 });
    expect(physical.blobs.count).toBeGreaterThanOrEqual(2);
    expect(physical.blobs.bytes).toBeGreaterThanOrEqual(same.length + 9);
    // Thumbnails rendered in this suite's earlier tests (sync mode) live next to their blobs.
    expect(physical.derived.count).toBeGreaterThanOrEqual(0);

    // An admin without a tenant: the whole deployment.
    const all = await http.get("/vola/stats/storage", {}, fx.admin.key);
    expect(all.statusCode, all.body).toBe(200);
    const deployment = StorageStatsSchema.parse(all.json());
    expect(deployment.scope).toBe("deployment");
    expect(deployment.tenant_id).toBeNull();
    const liveRows = await handle.db.$count(files);
    expect(deployment.files).toBeLessThanOrEqual(liveRows);
    expect(deployment.files).toBeGreaterThan(tenantView.files);
    expect(deployment.unique_blobs).toBeLessThanOrEqual(deployment.files);
    expect(deployment.physical?.blobs.count).toBe(physical.blobs.count);
    // The physical blob count matches the distinct hashes of EVERY row (deleted ones keep their blob).
    const [distinct] = await handle.db
      .select({ hashes: sql<string>`count(distinct ${files.hash})` })
      .from(files);
    expect(physical.blobs.count).toBe(Number(distinct?.hashes));
  });
});

describe("refreshStaleStats", () => {
  it("recomputes stale snapshots of tenants with activity since, leaves idle ones alone", async () => {
    const busy = await createTenant(handle.db, { slug: "busy" });
    const idle = await createTenant(handle.db, { slug: "idle" });
    const busyKey = (await mintKey(handle, busy.id, "busy", "live", ["files:read", "files:write"]))
      .key;
    const past = new Date(Date.now() - 2 * 3_600_000);
    const then: StatsDeps = { db: handle.db, now: () => past };
    await computeStats(then, { tenantId: busy.id, scope: "tenant" });
    await computeStats(then, { tenantId: idle.id, scope: "tenant" });
    const instanceId = randomUUID();
    await computeStats(then, {
      tenantId: busy.id,
      scope: "instance",
      instanceType: TYPE,
      instanceId,
    });
    await computeStats(then, {
      tenantId: busy.id,
      scope: "instance",
      instanceType: TYPE,
      instanceId: randomUUID(), // another instance of the busy tenant: no activity there
    });
    await uploaded(Buffer.from("activity"), "act.txt", { instanceId, key: busyKey });

    const deps: StatsDeps = { db: handle.db };
    const nothingStale = await refreshStaleStats(deps, { ttlMs: 3 * 3_600_000 });
    expect(nothingStale).toEqual({ stale: 0, refreshed: 0 });
    const result = await refreshStaleStats(deps, { ttlMs: 3_600_000 });
    expect(result).toEqual({ stale: 4, refreshed: 2 });
    const busyNow = await readStats(deps, { tenantId: busy.id, scope: "tenant" });
    expect(busyNow?.totalFiles).toBe(1);
    expect(busyNow?.computedAt.getTime()).toBeGreaterThan(past.getTime());
    const idleNow = await readStats(deps, { tenantId: idle.id, scope: "tenant" });
    expect(idleNow?.computedAt.getTime()).toBe(past.getTime());
    const instanceNow = await readStats(deps, {
      tenantId: busy.id,
      scope: "instance",
      instanceType: TYPE,
      instanceId,
    });
    expect(instanceNow?.totalFiles).toBe(1);
  });
});

describe.skipIf(!config.redisUrl)("refresh-stats through the worker (real Redis)", () => {
  const redisUrl = config.redisUrl as string;
  const prefix = `vola-test-${randomUUID().slice(0, 8)}`;
  let queue: ProcessingQueue;
  let worker: ProcessingWorker;

  beforeAll(async () => {
    queue = new ProcessingQueue({ redisUrl, prefix });
    worker = new ProcessingWorker({
      redisUrl,
      prefix,
      db: handle.db,
      storage,
      stats: { ttlMs: 3_600_000 },
    });
    await worker.ready();
  });
  afterAll(async () => {
    await worker.close();
    await queue.queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  it("schedules the repeatable job and a run refreshes a stale snapshot with activity", async () => {
    await queue.scheduleStatsRefresh(60_000);
    const schedulers = await queue.queue.getJobSchedulers();
    expect(schedulers.map((s) => s.key ?? s.id)).toContain(REFRESH_STATS_JOB);
    await queue.unscheduleStatsRefresh();
    expect((await queue.queue.getJobSchedulers()).map((s) => s.id)).not.toContain(
      REFRESH_STATS_JOB,
    );

    const tenant = await createTenant(handle.db, { slug: "worker-stats" });
    const key = (await mintKey(handle, tenant.id, "ws", "live", ["files:read", "files:write"])).key;
    const past = new Date(Date.now() - 2 * 3_600_000);
    await computeStats(
      { db: handle.db, now: () => past },
      { tenantId: tenant.id, scope: "tenant" },
    );
    await uploaded(Buffer.from("w"), "w.txt", { key });
    await queue.enqueueStatsRefresh();
    const refreshed = await waitFor(
      async () => {
        const row = await readStats({ db: handle.db }, { tenantId: tenant.id, scope: "tenant" });
        return row && row.computedAt.getTime() > past.getTime() ? row : null;
      },
      { label: "stats refresh by the worker", timeoutMs: 20_000 },
    );
    expect(refreshed.totalFiles).toBe(1);
  });
});

describe("plugin wiring", () => {
  it("exposes the share and stats routes under the prefix with the right auth", async () => {
    expect((await app.inject({ method: "GET", url: "/vola/stats/storage" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/vola/shares" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/vola/s/${"A".repeat(43)}` })).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/vola/stats/storage",
          headers: bearer(fx.readOnly.key),
        })
      ).statusCode,
    ).toBe(200);
  });
});

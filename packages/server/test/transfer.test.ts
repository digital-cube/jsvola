import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileInfoSchema,
  FileListSchema,
  FileVersionsSchema,
  type ShareCreated,
  ShareCreatedSchema,
  SharedFolderListingSchema,
  ShareInfoSchema,
  TenantStatsSchema,
  type TransferRequest,
  type TransferResult,
  TransferResultSchema,
} from "@vola/core";
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit/log.js";
import type { AuditEvent } from "../src/audit/memento.js";
import { files, folders, processingJobs, shareLinks, uploads } from "../src/db/schema.js";
import { LocalFileEventBus } from "../src/events/bus.js";
import { saveOcrResult } from "../src/services/ocr.js";
import { requestJob } from "../src/services/processing.js";
import { readStats } from "../src/services/stats.js";
import { createTenant } from "../src/services/tenants.js";
import { distinctInstances, mapUsers } from "../src/services/transfer.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { bearer, type Fixture, mintKey, setupFixture, testDatabase, truncate } from "./helpers.js";
import { httpClient } from "./http.js";

const handle = testDatabase(5);
let fx: Fixture;
let app: FastifyInstance;
let root: string;
let storage: FilesystemBackend;
let http: ReturnType<typeof httpClient>;
let events: LocalFileEventBus;
let audited: AuditEvent[];
/** The destination tenant and a full key of it. */
let beta: { id: string; slug: string; key: string };

const TYPE = "tickets";
const TRANSFER = "/vola/admin/transfer";

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-transfer-"));
  storage = new FilesystemBackend(root);
  events = new LocalFileEventBus();
  audited = [];
  const audit = new AuditLog({
    sink: {
      async send(event) {
        audited.push(event);
      },
    },
  });
  fx = await setupFixture(handle, { storage, events, audit, uploadSweepIntervalMs: 0 });
  app = fx.app;
  await app.ready();
  http = httpClient(app, fx.full.key, TYPE);
  const tenant = await createTenant(handle.db, { slug: "beta", name: "Beta" });
  const key = await mintKey(handle, tenant.id, "beta-full", "live", [
    "files:read",
    "files:write",
    "folders:read",
    "folders:write",
    "shares:write",
  ]);
  beta = { id: tenant.id, slug: tenant.slug, key: key.key };
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  events.published.length = 0;
  audited.length = 0;
});

// --- helpers -----------------------------------------------------------------------------

async function uploaded(
  data: Buffer,
  filename: string,
  options: {
    instanceId?: string;
    key?: string;
    fields?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
) {
  const { response, instanceId } = await http.upload(data, filename, options);
  expect(response.statusCode, response.body).toBe(201);
  return { info: FileInfoSchema.parse(response.json()), instanceId };
}

async function share(body: Record<string, unknown>, key = fx.full.key): Promise<ShareCreated> {
  const response = await app.inject({
    method: "POST",
    url: "/vola/shares",
    headers: { ...bearer(key), "x-user-id": "igor" },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return ShareCreatedSchema.parse(response.json());
}

async function mkdir(instanceId: string, path: string, key = fx.full.key) {
  const response = await app.inject({
    method: "POST",
    url: `/vola/folders/${TYPE}/${instanceId}/${path}`,
    headers: bearer(key),
  });
  expect([200, 201], response.body).toContain(response.statusCode);
  return response.json() as { id: string; path: string };
}

const transfer = (body: Partial<TransferRequest> & Record<string, unknown>, key = fx.admin.key) =>
  app.inject({ method: "POST", url: TRANSFER, headers: bearer(key), payload: body });

const instance = (instanceId: string) => ({ instance_type: TYPE, instance_id: instanceId });

async function moved(instanceIds: string[], extra: Record<string, unknown> = {}) {
  const response = await transfer({
    from_tenant: fx.tenant.slug,
    to_tenant: beta.slug,
    instances: instanceIds.map(instance),
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(200);
  return TransferResultSchema.parse(response.json());
}

const listOf = async (instanceId: string, key: string, query = "") => {
  const response = await http.get(`/vola/files/${TYPE}/${instanceId}${query}`, {}, key);
  expect(response.statusCode, response.body).toBe(200);
  return FileListSchema.parse(response.json()).files;
};

const fileRow = async (id: string) =>
  (await handle.db.select().from(files).where(eq(files.id, id)))[0];
const folderRow = async (id: string) =>
  (await handle.db.select().from(folders).where(eq(folders.id, id)))[0];
const shareRow = async (id: string) =>
  (await handle.db.select().from(shareLinks).where(eq(shareLinks.id, id)))[0];

// --- the move ----------------------------------------------------------------------------

describe("POST /admin/transfer — what moves", () => {
  it("moves files (versions and the bin), folders, shares, jobs and OCR metadata; tokens keep working", async () => {
    const instanceId = randomUUID();
    const a = await uploaded(Buffer.from("alpha"), "a.txt", {
      instanceId,
      fields: { folder_path: "docs" },
    });
    const b = await uploaded(Buffer.from("beta v1"), "b.txt", { instanceId });
    const b2 = await uploaded(Buffer.from("beta v2"), "b.txt", {
      instanceId,
      fields: { parent_id: b.info.id },
    });
    const c = await uploaded(Buffer.from("gone"), "c.txt", { instanceId });
    const del = await http.del(`/vola/files/${TYPE}/${instanceId}/${c.info.id}`);
    expect(del.statusCode).toBe(200);
    const fileShare = await share({ file_id: b2.info.id });
    const folderShare = await share({
      folder: { instance_type: TYPE, instance_id: instanceId, path: "docs" },
    });
    const { job } = await requestJob(
      { db: handle.db },
      { tenantId: fx.tenant.id, fileId: a.info.id, kind: "OCR", params: {} },
    );
    await saveOcrResult(handle.db, {
      fileId: a.info.id,
      tenantId: fx.tenant.id,
      text: "alpha text",
      lang: "eng",
      pages: 1,
      at: new Date(),
    });

    const result = await moved([instanceId]);
    expect(result).toEqual<TransferResult>({
      from_tenant: "acme",
      to_tenant: "beta",
      instances: 1,
      files: 4,
      folders: 1,
      merged_folders: 0,
      shares: 2,
      jobs: 1,
      metadata: 1,
      uploads: 0,
      dry_run: false,
    });

    // The source sees nothing, the destination everything — the bin included.
    expect(await listOf(instanceId, fx.full.key, "?include_deleted=1")).toEqual([]);
    const live = await listOf(instanceId, beta.key);
    expect(live.map((f) => f.id).sort()).toEqual([a.info.id, b.info.id, b2.info.id].sort());
    expect(live.every((f) => f.tenant_id === beta.id)).toBe(true);
    const all = await listOf(instanceId, beta.key, "?include_deleted=1");
    expect(all.map((f) => f.id)).toContain(c.info.id);
    const versions = await http.get(
      `/vola/files/${TYPE}/${instanceId}/${b2.info.id}/versions`,
      {},
      beta.key,
    );
    expect(FileVersionsSchema.parse(versions.json()).versions.map((v) => v.id)).toEqual([
      b2.info.id,
      b.info.id,
    ]);
    // The folder, with the file still in it, reachable by path on the destination.
    const byPath = await http.get(
      `/vola/files/${TYPE}/${instanceId}/path/docs/a.txt`,
      {},
      beta.key,
    );
    expect(byPath.statusCode, byPath.body).toBe(200);
    expect(byPath.body).toBe("alpha");
    expect((await folderRow(a.info.folder_id as string))?.tenantId).toBe(beta.id);
    // Shares: same token, now the destination's rows.
    for (const s of [fileShare, folderShare]) {
      const row = await shareRow(s.id);
      expect(row?.tenantId).toBe(beta.id);
      const own = await http.get(`/vola/shares/${s.id}`, {}, beta.key);
      expect(own.statusCode).toBe(200);
      expect(ShareInfoSchema.parse(own.json()).tenant_id).toBe(beta.id);
      expect((await http.get(`/vola/shares/${s.id}`)).statusCode).toBe(404);
    }
    const download = await app.inject({ method: "GET", url: `/vola/s/${fileShare.token}` });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.body).toBe("beta v2");
    const listing = await app.inject({ method: "GET", url: `/vola/s/${folderShare.token}` });
    expect(listing.statusCode, listing.body).toBe(200);
    expect(SharedFolderListingSchema.parse(listing.json()).files.map((f) => f.filename)).toEqual([
      "a.txt",
    ]);
    // Jobs and metadata followed.
    const [jobRow] = await handle.db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, job.id));
    expect(jobRow?.tenantId).toBe(beta.id);
    const info = await http.get(
      `/vola/files/${TYPE}/${instanceId}/${a.info.id}/info`,
      {},
      beta.key,
    );
    expect(info.statusCode).toBe(200);
    expect(info.json().ocr).toMatchObject({ status: "PENDING", text_preview: "alpha text" });
    // Both sides were told: `purged` on the source channel, `created` on the destination's.
    const purged = events.published.filter(
      (e) => e.kind === "purged" && e.tenantId === fx.tenant.id,
    );
    const created = events.published.filter((e) => e.kind === "created" && e.tenantId === beta.id);
    expect(purged.map((e) => e.fileId).sort()).toEqual(all.map((f) => f.id).sort());
    expect(created.map((e) => e.fileId).sort()).toEqual(all.map((f) => f.id).sort());
    // And the audit trail has one event with counts, no names.
    const event = audited.find((e) => e.event_type === "VOLA_INSTANCES_TRANSFERRED");
    expect(event).toMatchObject({
      instance_type: "vola_tenant",
      instance_id: "beta",
      actor_type: "api_key",
      actor_id: `key:${fx.admin.apiKey.prefix}…${fx.admin.apiKey.last4}`,
      payload: {
        from_tenant: "acme",
        to_tenant: "beta",
        instances: [instance(instanceId)],
        files: 4,
        folders: 1,
        shares: 2,
      },
    });
    expect(JSON.stringify(event)).not.toContain("a.txt");
  });

  it("is idempotent: a second call finds nothing on the source and reports zeros", async () => {
    const instanceId = randomUUID();
    await uploaded(Buffer.from("once"), "once.txt", { instanceId });
    expect((await moved([instanceId])).files).toBe(1);
    const again = await moved([instanceId]);
    expect(again).toMatchObject({ files: 0, folders: 0, shares: 0, instances: 1 });
    expect(await listOf(instanceId, beta.key)).toHaveLength(1);
  });

  it("moves several instances in one call and leaves unlisted instances where they are", async () => {
    const one = randomUUID();
    const two = randomUUID();
    const stays = randomUUID();
    await uploaded(Buffer.from("1"), "1.txt", { instanceId: one });
    await uploaded(Buffer.from("2"), "2.txt", { instanceId: two });
    await uploaded(Buffer.from("s"), "s.txt", { instanceId: stays });
    const result = await moved([one, two, one]); // the duplicate counts once
    expect(result).toMatchObject({ instances: 2, files: 2 });
    expect(await listOf(stays, fx.full.key)).toHaveLength(1);
    expect(await listOf(stays, beta.key)).toHaveLength(0);
  });
});

describe("POST /admin/transfer — folders", () => {
  it("merges a folder whose path exists on the destination: files and subfolders re-pointed, one row left", async () => {
    const instanceId = randomUUID();
    // The destination already has docs/ with a file of its own.
    const dstDocs = await mkdir(instanceId, "docs", beta.key);
    const theirs = await http.upload(Buffer.from("theirs"), "theirs.txt", {
      instanceId,
      key: beta.key,
      fields: { folder_path: "docs" },
    });
    expect(theirs.response.statusCode).toBe(201);
    // The source has docs/ (with a file), docs/sub (with a file) and other/.
    const mine = await uploaded(Buffer.from("mine"), "mine.txt", {
      instanceId,
      fields: { folder_path: "docs" },
    });
    const deep = await uploaded(Buffer.from("deep"), "deep.txt", {
      instanceId,
      fields: { folder_path: "docs/sub" },
    });
    const otherFile = await uploaded(Buffer.from("other"), "o.txt", {
      instanceId,
      fields: { folder_path: "other" },
    });
    const srcDocsId = mine.info.folder_id as string;
    const srcSubId = deep.info.folder_id as string;
    const docsShare = await share({
      folder: { instance_type: TYPE, instance_id: instanceId, path: "docs" },
    });

    const result = await moved([instanceId]);
    expect(result).toMatchObject({ files: 3, folders: 3, merged_folders: 1, shares: 1 });

    // The source docs/ row is gone; everything that hung off it hangs off the destination's.
    expect(await folderRow(srcDocsId)).toBeUndefined();
    expect((await fileRow(mine.info.id))?.folderId).toBe(dstDocs.id);
    expect(await folderRow(srcSubId)).toMatchObject({ tenantId: beta.id, parentId: dstDocs.id });
    expect(await shareRow(docsShare.id)).toMatchObject({ tenantId: beta.id, folderId: dstDocs.id });
    expect((await folderRow(otherFile.info.folder_id as string))?.tenantId).toBe(beta.id);
    // One docs/ on the destination, with both files; the path lookups work.
    const docsRows = await handle.db
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.tenantId, beta.id),
          eq(folders.instanceId, instanceId),
          eq(folders.path, "docs"),
        ),
      );
    expect(docsRows).toHaveLength(1);
    const listing = await app.inject({ method: "GET", url: `/vola/s/${docsShare.token}` });
    expect(SharedFolderListingSchema.parse(listing.json())).toMatchObject({
      files: [{ filename: "mine.txt" }, { filename: "theirs.txt" }],
      subfolders: [{ name: "sub", path: "sub" }],
    });
    const viaPath = await http.get(
      `/vola/files/${TYPE}/${instanceId}/path/docs/sub/deep.txt`,
      {},
      beta.key,
    );
    expect(viaPath.statusCode, viaPath.body).toBe(200);
  });

  it("revives a deleted destination folder when a live source folder merges into it", async () => {
    const instanceId = randomUUID();
    const dstDocs = await mkdir(instanceId, "docs", beta.key);
    const gone = await app.inject({
      method: "DELETE",
      url: `/vola/folders/${TYPE}/${instanceId}/docs`,
      headers: bearer(beta.key),
    });
    expect(gone.statusCode, gone.body).toBe(200);
    expect((await folderRow(dstDocs.id))?.deletedAt).not.toBeNull();
    const mine = await uploaded(Buffer.from("mine"), "mine.txt", {
      instanceId,
      fields: { folder_path: "docs" },
    });

    const result = await moved([instanceId]);
    expect(result).toMatchObject({ files: 1, folders: 1, merged_folders: 1 });
    const revived = await folderRow(dstDocs.id);
    expect(revived).toMatchObject({ deletedAt: null, deletedBy: null, tenantId: beta.id });
    expect((await fileRow(mine.info.id))?.folderId).toBe(dstDocs.id);
    const viaPath = await http.get(
      `/vola/files/${TYPE}/${instanceId}/path/docs/mine.txt`,
      {},
      beta.key,
    );
    expect(viaPath.statusCode, viaPath.body).toBe(200);
  });

  it("does not revive a destination folder for a deleted source folder, and merges the deleted one too", async () => {
    const instanceId = randomUUID();
    const dstDocs = await mkdir(instanceId, "docs", beta.key);
    await app.inject({
      method: "DELETE",
      url: `/vola/folders/${TYPE}/${instanceId}/docs`,
      headers: bearer(beta.key),
    });
    const mine = await uploaded(Buffer.from("mine"), "mine.txt", {
      instanceId,
      fields: { folder_path: "docs" },
    });
    const srcDocsId = mine.info.folder_id as string;
    const del = await app.inject({
      method: "DELETE",
      url: `/vola/folders/${TYPE}/${instanceId}/docs?recursive=1`,
      headers: bearer(fx.full.key),
    });
    expect(del.statusCode, del.body).toBe(200);

    const result = await moved([instanceId]);
    expect(result).toMatchObject({ files: 1, folders: 1, merged_folders: 1 });
    expect((await folderRow(dstDocs.id))?.deletedAt).not.toBeNull();
    expect(await folderRow(srcDocsId)).toBeUndefined();
    expect(await fileRow(mine.info.id)).toMatchObject({ tenantId: beta.id, folderId: dstDocs.id });
  });
});

describe("POST /admin/transfer — user_map", () => {
  it("rewrites created_by, deleted_by, last_accessed_by and share created_by; unmapped users stay", async () => {
    const instanceId = randomUUID();
    const a = await uploaded(Buffer.from("a"), "a.txt", {
      instanceId,
      headers: { "x-user-id": "alice" },
      fields: { folder_path: "docs" },
    });
    const b = await uploaded(Buffer.from("b"), "b.txt", {
      instanceId,
      headers: { "x-user-id": "carol" },
    });
    const del = await app.inject({
      method: "DELETE",
      url: `/vola/files/${TYPE}/${instanceId}/${b.info.id}`,
      headers: { ...bearer(fx.full.key), "x-user-id": "bob" },
    });
    expect(del.statusCode).toBe(200);
    await handle.db
      .update(files)
      .set({ lastAccessedAt: new Date(), lastAccessedBy: "alice" })
      .where(eq(files.id, a.info.id));
    const s = await share({ file_id: a.info.id }); // created_by "igor"
    const folderDel = await app.inject({
      method: "DELETE",
      url: `/vola/folders/${TYPE}/${instanceId}/docs?recursive=1`,
      headers: { ...bearer(fx.full.key), "x-user-id": "bob" },
    });
    expect(folderDel.statusCode, folderDel.body).toBe(200);

    await moved([instanceId], {
      user_map: { alice: "u-1", bob: "u-2", igor: "u-3", nobody: "u-9" },
    });
    expect(await fileRow(a.info.id)).toMatchObject({
      createdBy: "u-1",
      deletedBy: "u-2",
      lastAccessedBy: "u-1",
    });
    expect(await fileRow(b.info.id)).toMatchObject({ createdBy: "carol", deletedBy: "u-2" });
    expect(await folderRow(a.info.folder_id as string)).toMatchObject({
      createdBy: "u-1",
      deletedBy: "u-2",
    });
    expect((await shareRow(s.id))?.createdBy).toBe("u-3");
  });

  it("mapUsers builds a CASE only for entries that change something", () => {
    const text = (map: Record<string, string>) =>
      new PgDialect().sqlToQuery(mapUsers(files.createdBy, map)).sql;
    expect(text({})).not.toContain("case");
    expect(text({ a: "a" })).not.toContain("case");
    expect(text({ a: "b", c: "c" })).toContain("case");
  });

  it("distinctInstances keeps the first of a duplicate and lower-cases ids", () => {
    const id = randomUUID();
    expect(
      distinctInstances([
        { instance_type: "tickets", instance_id: id.toUpperCase() },
        { instance_type: "tickets", instance_id: id },
        { instance_type: "users", instance_id: id },
      ]),
    ).toEqual([
      { instance_type: "tickets", instance_id: id },
      { instance_type: "users", instance_id: id },
    ]);
  });
});

describe("POST /admin/transfer — statistics and dry_run", () => {
  it("recomputes both tenants' snapshots and moves the instance snapshot", async () => {
    const instanceId = randomUUID();
    await uploaded(Buffer.from("12345"), "five.txt", { instanceId });
    await uploaded(Buffer.from("123"), "three.txt", { instanceId });
    // Snapshots exist on both sides before the move.
    const before = await http.get(`/vola/stats/tenant?recompute=1`);
    const srcBefore = TenantStatsSchema.parse(before.json());
    expect(srcBefore.total_files).toBeGreaterThanOrEqual(2);
    const dstBeforeResponse = await http.get(`/vola/stats/tenant?recompute=1`, {}, beta.key);
    const dstBefore = TenantStatsSchema.parse(dstBeforeResponse.json());
    const instBefore = await http.get(`/vola/stats/instance/${TYPE}/${instanceId}?recompute=1`);
    expect(TenantStatsSchema.parse(instBefore.json()).total_files).toBe(2);

    await moved([instanceId]);

    // Read WITHOUT recompute: the snapshots were refreshed by the transfer itself.
    const srcAfter = TenantStatsSchema.parse((await http.get(`/vola/stats/tenant`)).json());
    expect(srcAfter.total_files).toBe(srcBefore.total_files - 2);
    expect(srcAfter.total_bytes).toBe(srcBefore.total_bytes - 8);
    const dstAfter = TenantStatsSchema.parse(
      (await http.get(`/vola/stats/tenant`, {}, beta.key)).json(),
    );
    expect(dstAfter.total_files).toBe(dstBefore.total_files + 2);
    expect(dstAfter.total_bytes).toBe(dstBefore.total_bytes + 8);
    expect(
      await readStats(
        { db: handle.db },
        { tenantId: fx.tenant.id, scope: "instance", instanceType: TYPE, instanceId },
      ),
    ).toBeNull();
    const dstInstance = await readStats(
      { db: handle.db },
      { tenantId: beta.id, scope: "instance", instanceType: TYPE, instanceId },
    );
    expect(dstInstance).toMatchObject({ totalFiles: 2, totalBytes: 8 });
  });

  it("dry_run answers the same counts and writes nothing", async () => {
    const instanceId = randomUUID();
    const a = await uploaded(Buffer.from("a"), "a.txt", {
      instanceId,
      fields: { folder_path: "docs" },
    });
    await mkdir(instanceId, "docs", beta.key); // a merge candidate
    const s = await share({ file_id: a.info.id });
    const srcStats = TenantStatsSchema.parse(
      (await http.get(`/vola/stats/tenant?recompute=1`)).json(),
    );

    events.published.length = 0; // the uploads above announced themselves
    audited.length = 0; // and the share recorded itself
    const dry = await moved([instanceId], { dry_run: true, user_map: { igor: "x" } });
    expect(dry).toMatchObject({
      files: 1,
      folders: 1,
      merged_folders: 1,
      shares: 1,
      dry_run: true,
    });
    expect(await fileRow(a.info.id)).toMatchObject({ tenantId: fx.tenant.id });
    expect(await folderRow(a.info.folder_id as string)).toMatchObject({ tenantId: fx.tenant.id });
    expect(await shareRow(s.id)).toMatchObject({ tenantId: fx.tenant.id, createdBy: "igor" });
    expect(await listOf(instanceId, fx.full.key)).toHaveLength(1);
    expect(await listOf(instanceId, beta.key)).toHaveLength(0);
    expect(TenantStatsSchema.parse((await http.get(`/vola/stats/tenant`)).json())).toEqual(
      srcStats,
    );
    expect(events.published).toEqual([]);
    expect(audited).toEqual([]);

    const real = await moved([instanceId], { user_map: { igor: "x" } });
    expect(real).toMatchObject({
      files: 1,
      folders: 1,
      merged_folders: 1,
      shares: 1,
      dry_run: false,
    });
  });
});

describe("POST /admin/transfer — refusals", () => {
  it("needs an admin key: a tenant key is 403, no key is 401", async () => {
    const instanceId = randomUUID();
    const body = { from_tenant: "acme", to_tenant: "beta", instances: [instance(instanceId)] };
    const tenantKey = await transfer(body, fx.full.key);
    expect(tenantKey.statusCode).toBe(403);
    expect(tenantKey.json().error).toMatchObject({ code: "forbidden", required: ["admin"] });
    const readOnly = await transfer(body, fx.readOnly.key);
    expect(readOnly.statusCode).toBe(403);
    const anonymous = await app.inject({ method: "POST", url: TRANSFER, payload: body });
    expect(anonymous.statusCode).toBe(401);
  });

  it("ignores X-Tenant-Slug: both tenants come from the body", async () => {
    const instanceId = randomUUID();
    await uploaded(Buffer.from("x"), "x.txt", { instanceId });
    const response = await app.inject({
      method: "POST",
      url: TRANSFER,
      headers: { ...bearer(fx.admin.key), "x-tenant-slug": "beta" },
      payload: { from_tenant: "acme", to_tenant: "beta", instances: [instance(instanceId)] },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().files).toBe(1);
  });

  it("answers 404 tenant_not_found for an unknown source or destination", async () => {
    const instanceId = randomUUID();
    for (const body of [
      { from_tenant: "nope", to_tenant: "beta" },
      { from_tenant: "acme", to_tenant: "nope" },
    ]) {
      const response = await transfer({ ...body, instances: [instance(instanceId)] });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json().error.code).toBe("tenant_not_found");
    }
  });

  it("validates the body: same tenant, no instances, bad ids, unknown fields", async () => {
    const instanceId = randomUUID();
    const cases: Record<string, unknown>[] = [
      { from_tenant: "acme", to_tenant: "acme", instances: [instance(instanceId)] },
      { from_tenant: "acme", to_tenant: "beta", instances: [] },
      { from_tenant: "acme", to_tenant: "beta" },
      {
        from_tenant: "acme",
        to_tenant: "beta",
        instances: [{ instance_type: "Tickets", instance_id: instanceId }],
      },
      {
        from_tenant: "acme",
        to_tenant: "beta",
        instances: [{ instance_type: "tickets", instance_id: "42" }],
      },
      {
        from_tenant: "acme",
        to_tenant: "beta",
        instances: [instance(instanceId)],
        user_map: { a: 1 },
      },
      { from_tenant: "acme", to_tenant: "beta", instances: [instance(instanceId)], extra: true },
    ];
    for (const body of cases) {
      const response = await transfer(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      expect(response.json().error.code).toBe("validation_error");
    }
  });

  it("refuses an instance holding an encrypted file with 409 and moves nothing", async () => {
    const instanceId = randomUUID();
    const plain = await uploaded(Buffer.from("plain"), "plain.txt", { instanceId });
    const secret = await uploaded(Buffer.from("secret"), "secret.txt", { instanceId });
    await handle.db.update(files).set({ encryption: "tenant" }).where(eq(files.id, secret.info.id));
    const other = randomUUID();
    await uploaded(Buffer.from("o"), "o.txt", { instanceId: other });

    events.published.length = 0;
    const response = await transfer({
      from_tenant: "acme",
      to_tenant: "beta",
      instances: [instance(other), instance(instanceId)],
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "encrypted_transfer_unsupported",
      instance_id: instanceId,
      files: 1,
    });
    // The whole call is one transaction: the other instance did not move either.
    expect(await fileRow(plain.info.id)).toMatchObject({ tenantId: fx.tenant.id });
    expect(await listOf(other, fx.full.key)).toHaveLength(1);
    expect(events.published).toEqual([]);
  });

  it("refuses an instance with a resumable upload in progress with 409 uploads_in_progress", async () => {
    const instanceId = randomUUID();
    await uploaded(Buffer.from("done"), "done.txt", { instanceId });
    const [pending] = await handle.db
      .insert(uploads)
      .values({
        tenantId: fx.tenant.id,
        instanceType: TYPE,
        instanceId,
        filename: "big.bin",
        length: 1000,
        offset: 10,
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    const refused = await transfer({
      from_tenant: "acme",
      to_tenant: "beta",
      instances: [instance(instanceId)],
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toMatchObject({ code: "uploads_in_progress", uploads: 1 });

    // An expired one does not block, and follows the instance.
    await handle.db
      .update(uploads)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(uploads.id, (pending as { id: string }).id));
    const result = await moved([instanceId]);
    expect(result).toMatchObject({ files: 1, uploads: 1 });
    const [row] = await handle.db
      .select()
      .from(uploads)
      .where(eq(uploads.id, (pending as { id: string }).id));
    expect(row?.tenantId).toBe(beta.id);
  });
});

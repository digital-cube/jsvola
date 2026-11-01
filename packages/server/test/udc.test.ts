import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FilterNode, UdcError } from "@jsudc/core";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { files } from "../src/db/schema.js";
import { createTenant } from "../src/services/tenants.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { decodePageCursor, encodePageCursor } from "../src/udc/cursor.js";
import { ENCRYPTED_FILENAME } from "../src/udc/files-source.js";
import { actionOf, scopeForAction } from "../src/udc/plugin.js";
import { coerce, pinnedValue, withoutTopLevel } from "../src/udc/sql-filter.js";
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
let http: ReturnType<typeof httpClient>;
let other: { tenantId: string; key: string };

const TYPE = "tickets";
const TICKET_A = randomUUID();
const TICKET_B = randomUUID();
const USER = randomUUID();
// A real, decodable 4×4 PNG: `thumb_url` renders it inline in this (sync-mode) suite.
const PNG = await sharp({
  create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
})
  .png()
  .toBuffer();

/** The files seeded in TICKET_A, in upload order (`created_at` ascending). */
const SEED_A = [
  { name: "alpha.txt", folder: "", data: Buffer.from("alpha") },
  { name: "photo.png", folder: "", data: PNG },
  { name: "notes.md", folder: "docs", data: Buffer.from("# notes") },
  { name: "report.txt", folder: "docs", data: Buffer.from("report ".repeat(20)) },
  { name: "q4.txt", folder: "docs/q4", data: Buffer.from("q4") },
  { name: "zeta.txt", folder: "", data: Buffer.from("zeta zeta") },
];
const ids: Record<string, string> = {};
let deletedId: string;
let encryptedId: string;
let otherId: string;

// biome-ignore lint/suspicious/noExplicitAny: the tests read deep into protocol payloads
type Payload = Record<string, any>;

async function udc(
  action: string,
  payload: unknown,
  key: string | null = fx.readOnly.key,
  headers: Record<string, string> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: `/vola/udc/${action}`,
    headers: { ...(key ? bearer(key) : {}), "x-udc-message-id": "m1", ...headers },
    payload: payload as Record<string, unknown>,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { kind: string; id: string; payload: Payload };
}
const ok = async (
  action: string,
  payload: unknown,
  key?: string,
  headers?: Record<string, string>,
) => {
  const answer = await udc(action, payload, key, headers);
  expect(answer.kind, JSON.stringify(answer.payload)).toBe(`udc.${action}.ok`);
  return answer.payload;
};
const err = async (
  action: string,
  payload: unknown,
  key?: string | null,
  headers?: Record<string, string>,
) => {
  const answer = await udc(action, payload, key, headers);
  expect(answer.kind, JSON.stringify(answer.payload)).toBe(`udc.${action}.err`);
  return answer.payload as { code: string; message: string };
};
const list = (filter: unknown, extra: Record<string, unknown> = {}, key?: string) =>
  ok("list", { collection: "files", filter, ...extra }, key);
const names = (page: Payload) => page.rows.map((r: { filename: string }) => r.filename);
const byType = (type = TYPE) => ({ field: "instance_type", op: "eq", value: type });
const inA = (...more: unknown[]) => ({
  and: [byType(), { field: "instance_id", op: "eq", value: TICKET_A }, ...more],
});

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-udc-"));
  fx = await setupFixture(handle, { storage: new FilesystemBackend(root) });
  app = fx.app;
  await app.ready();
  http = httpClient(app, fx.full.key, TYPE);
  const tenant = await createTenant(handle.db, { slug: "other" });
  const key = await mintKey(handle, tenant.id, "other", "live", ["files:read", "files:write"]);
  other = { tenantId: tenant.id, key: key.key };

  for (const seed of SEED_A) {
    const { response } = await http.upload(seed.data, seed.name, {
      instanceId: TICKET_A,
      fields: seed.folder ? { folder_path: seed.folder } : {},
      headers: { "x-user-id": "igor" },
    });
    expect(response.statusCode, response.body).toBe(201);
    ids[seed.name] = response.json().id;
  }
  const gone = await http.upload(Buffer.from("gone"), "gone.txt", { instanceId: TICKET_A });
  deletedId = gone.response.json().id;
  await http.del(`/vola/files/${TYPE}/${TICKET_A}/${deletedId}`);
  ids["b-one.txt"] = (
    await http.upload(Buffer.from("b1"), "b-one.txt", { instanceId: TICKET_B })
  ).response.json().id;
  ids["b-two.txt"] = (
    await http.upload(Buffer.from("b2"), "b-two.txt", { instanceId: TICKET_B })
  ).response.json().id;
  await http.upload(Buffer.from("me"), "me.txt", { instanceId: USER, type: "users" });
  otherId = (
    await http.upload(Buffer.from("theirs"), "theirs.txt", { key: other.key })
  ).response.json().id;

  // An encrypted file as phase 6 will store it: no blob is needed to list it.
  const [encrypted] = await handle.db
    .insert(files)
    .values({
      tenantId: fx.tenant.id,
      instanceType: TYPE,
      instanceId: TICKET_A,
      hash: createHash("sha256").update("ciphertext").digest("hex"),
      size: 4096,
      filename: "secret-plan.pdf",
      extension: "pdf",
      mimeType: "application/pdf",
      kind: "document",
      encryption: "tenant",
      encFormat: 1,
      createdBy: "igor",
      createdAt: new Date(Date.now() + 1000),
      updatedAt: new Date(Date.now() + 1000),
    })
    .returning({ id: files.id });
  encryptedId = (encrypted as { id: string }).id;
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

describe("UDC auth", () => {
  it("refuses a request without a key, in-protocol", async () => {
    const answer = await udc("collections", {}, null);
    expect(answer).toEqual({
      kind: "udc.collections.err",
      id: "m1",
      payload: { code: "forbidden", message: "a valid API key is required" },
    });
  });

  it("needs files:read to list and files:write to mutate; the source refuses mutations anyway", async () => {
    const folders = await mintKey(handle, fx.tenant.id, "folders", "live", ["folders:read"]);
    expect(await err("list", { collection: "files" }, folders.key)).toEqual({
      code: "forbidden",
      message: 'this API key lacks the scope "files:read"',
    });
    expect((await err("mutate", { collection: "files", op: "delete", id: "x" })).message).toBe(
      'this API key lacks the scope "files:write"',
    );
    const immutable = await err(
      "mutate",
      { collection: "files", op: "delete", id: "x" },
      fx.full.key,
    );
    expect(immutable.code).toBe("unsupported_op");
  });

  it("takes an admin key with X-Tenant-Slug and refuses one without", async () => {
    const noTenant = await err("list", { collection: "files" }, fx.admin.key);
    expect(noTenant.code).toBe("validation_error");
    expect(noTenant.message).toMatch(/X-Tenant-Slug/);
    const unknown = await err("list", { collection: "files" }, fx.admin.key, {
      "x-tenant-slug": "nope",
    });
    expect(unknown.code).toBe("not_found");
    const page = await ok("list", { collection: "files", filter: byType() }, fx.admin.key, {
      "x-tenant-slug": fx.tenant.slug,
    });
    expect(page.total).toBe(9);
  });

  it("leaves the plugin's health check open and maps actions to scopes", async () => {
    const response = await app.inject({ method: "GET", url: "/vola/healthz" });
    expect(response.json()).toEqual({ ok: true });
    expect(scopeForAction("list")).toBe("files:read");
    expect(scopeForAction("schema.add_field")).toBe("files:write");
    expect(actionOf("/vola/udc/list?x=1")).toBe("list");
    expect(actionOf("/vola/udc/tree.reparent")).toBe("tree.reparent");
    expect(actionOf("/vola/healthz")).toBeNull();
  });
});

describe("UDC collections and describe", () => {
  it("lists files and menu, read-only, cursor-paged", async () => {
    const { collections } = await ok("collections", {});
    expect(collections.map((c: { name: string }) => c.name)).toEqual(["files", "menu"]);
    expect(collections[0]).toMatchObject({
      label: "Files",
      default_renderer: "table",
      capabilities: { mutate: false, total_count: true, paging: ["cursor"] },
    });
  });

  it("describes the columns and their types", async () => {
    const d = await ok("describe", { collection: "files" });
    const f = d.schema.fields;
    expect(d.schema.field_order.slice(0, 9)).toEqual([
      "id",
      "instance_type",
      "instance_id",
      "filename",
      "kind",
      "size",
      "extension",
      "mime_type",
      "folder_path",
    ]);
    expect(f.filename).toMatchObject({ type: "string", required: true });
    expect(f.kind).toMatchObject({ type: "lookup", ref: "FileKinds" });
    expect(f.encryption).toMatchObject({ type: "lookup", ref: "EncryptionModes" });
    expect(f.processing_status).toMatchObject({ type: "lookup", ref: "ProcessingStatuses" });
    expect(f.size.type).toBe("integer");
    expect(f.created_at.type).toBe("datetime");
    expect(f.thumb_url.type).toBe("image");
    expect(f.include_deleted.type).toBe("bool");
    // jsudc lists every schema field as a column (derived ones around the configured ones);
    // the configured columns keep their renderers and their relative order.
    const renders = new Map<string, string | undefined>(
      d.view.columns.map((c: { field: string; render?: string }) => [c.field, c.render]),
    );
    expect(renders.get("thumb_url")).toBe("image_thumb");
    expect(renders.get("kind")).toBe("lookup");
    expect(renders.get("size")).toBe("bytes");
    expect(renders.get("processing_status")).toBe("lookup");
    expect(renders.get("encryption")).toBe("lookup");
    expect(renders.get("filename")).toBeUndefined();
    const configured = [
      "thumb_url",
      "filename",
      "kind",
      "size",
      "extension",
      "mime_type",
      "folder_path",
      "created_at",
      "created_by",
      "processing_status",
      "encryption",
    ];
    const order = [...renders.keys()].filter((f) => configured.includes(f));
    expect(order).toEqual(configured);
    expect(d.view.search).toEqual({ fields: ["filename"], case_insensitive: expect.any(Boolean) });
    const filterable = d.filterable.fields.map((x: { field: string }) => x.field);
    expect(filterable).toEqual(
      expect.arrayContaining(["instance_type", "folder_path", "created_at", "include_deleted"]),
    );
  });

  it("is not served with udc: false, and without the menu when menu: false", async () => {
    const none = await buildApp({ config, db: handle.db, logger: false, udc: false });
    const response = await none.inject({
      method: "POST",
      url: "/vola/udc/collections",
      headers: bearer(fx.readOnly.key),
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    await none.close();

    const noMenu = await buildApp({ config, db: handle.db, logger: false, menu: false });
    const answer = await noMenu.inject({
      method: "POST",
      url: "/vola/udc/collections",
      headers: bearer(fx.readOnly.key),
      payload: {},
    });
    expect(answer.json().payload.collections.map((c: { name: string }) => c.name)).toEqual([
      "files",
    ]);
    await noMenu.close();
  });
});

describe("UDC list: scope and filters", () => {
  it("answers an empty page without an instance_type filter", async () => {
    for (const filter of [
      undefined,
      { field: "instance_id", op: "eq", value: TICKET_A },
      { field: "instance_type", op: "in", value: [TYPE] },
    ]) {
      const page = await list(filter);
      expect(page).toEqual({ rows: [], next_cursor: null, total: 0 });
    }
  });

  it("lists every live file of the type across instances, newest first, with urls", async () => {
    const page = await list(byType());
    expect(page.total).toBe(9);
    expect(page.next_cursor).toBeNull();
    expect(names(page)).toEqual([
      ENCRYPTED_FILENAME,
      "b-two.txt",
      "b-one.txt",
      "zeta.txt",
      "q4.txt",
      "report.txt",
      "notes.md",
      "photo.png",
      "alpha.txt",
    ]);
    const photo = page.rows.find((r: { filename: string }) => r.filename === "photo.png");
    expect(photo).toEqual({
      __meta: { id: ids["photo.png"], version: 1 },
      id: ids["photo.png"],
      instance_type: TYPE,
      instance_id: TICKET_A,
      filename: "photo.png",
      kind: "image",
      size: PNG.length,
      extension: "png",
      mime_type: "image/png",
      folder_path: "",
      folder_id: null,
      slug: null,
      hash: createHash("sha256").update(PNG).digest("hex"),
      is_public: false,
      is_global_public: false,
      encryption: "none",
      processing_status: null,
      thumb_url: `/vola/files/${TYPE}/${TICKET_A}/${ids["photo.png"]}/thumb/256`,
      download_url: `/vola/files/${TYPE}/${TICKET_A}/${ids["photo.png"]}`,
      created_by: "igor",
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      updated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      deleted_at: null,
      include_deleted: false,
    });
    // `thumb_url` is live: in sync mode (the fixture) the 256px WebP is rendered inline.
    const thumb = await http.get(photo.thumb_url, {}, fx.readOnly.key);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/webp");
    expect(thumb.headers["x-thumbnail-status"]).toBe("ready");
  });

  it("narrows to one instance with instance_id", async () => {
    const page = await list(inA());
    expect(page.total).toBe(7);
    expect(names(page)).not.toContain("b-one.txt");
    expect(
      (await list({ and: [byType(), { field: "instance_id", op: "eq", value: TICKET_B }] })).total,
    ).toBe(2);
    expect((await list(byType("users"))).total).toBe(1);
    expect((await list(byType("nothing"))).total).toBe(0);
  });

  it("lists one folder level with folder_path ('' is the root)", async () => {
    const rootLevel = await list(inA({ field: "folder_path", op: "eq", value: "" }));
    expect(names(rootLevel).sort()).toEqual([
      ENCRYPTED_FILENAME,
      "alpha.txt",
      "photo.png",
      "zeta.txt",
    ]);
    const docs = await list(inA({ field: "folder_path", op: "eq", value: "docs" }));
    expect(names(docs).sort()).toEqual(["notes.md", "report.txt"]);
    expect(docs.rows[0].folder_path).toBe("docs");
    expect(docs.rows[0].folder_id).toEqual(expect.any(String));
    const q4 = await list(inA({ field: "folder_path", op: "eq", value: "docs/q4" }));
    expect(names(q4)).toEqual(["q4.txt"]);
    expect((await list(inA({ field: "folder_path", op: "eq", value: "nope" }))).total).toBe(0);
  });

  it("filters by filename (ilike), mime_type, extension, kind and created_at", async () => {
    const contains = await list(
      inA({ field: "filename", op: "contains", value: "A.T", case_insensitive: true }),
    );
    expect(names(contains).sort()).toEqual(["alpha.txt", "zeta.txt"]);
    const sensitive = await list(inA({ field: "filename", op: "contains", value: "A.T" }));
    expect(sensitive.total).toBe(0);
    const starts = await list(inA({ field: "filename", op: "starts_with", value: "rep" }));
    expect(names(starts)).toEqual(["report.txt"]);
    // LIKE metacharacters are literal.
    expect((await list(inA({ field: "filename", op: "contains", value: "%" }))).total).toBe(0);

    expect(names(await list(inA({ field: "mime_type", op: "eq", value: "image/png" })))).toEqual([
      "photo.png",
    ]);
    expect(
      names(await list(inA({ field: "mime_type", op: "starts_with", value: "text/" }))).length,
    ).toBe(5);
    expect(names(await list(inA({ field: "extension", op: "eq", value: "md" })))).toEqual([
      "notes.md",
    ]);
    expect((await list(inA({ field: "extension", op: "in", value: ["md", "png"] }))).total).toBe(2);
    expect(names(await list(inA({ field: "kind", op: "eq", value: "image" })))).toEqual([
      "photo.png",
    ]);
    expect((await list(inA({ field: "kind", op: "in", value: ["text", "document"] }))).total).toBe(
      6,
    );
    expect((await list(inA({ field: "kind", op: "in", value: [] }))).total).toBe(0);
    expect((await list(inA({ field: "size", op: "gte", value: 100 }))).total).toBe(2);

    const all = await list(inA(), { sort: [{ field: "created_at", dir: "asc" }] });
    const [first, second] = all.rows;
    const between = await list(
      inA({ field: "created_at", op: "between", value: [first.created_at, second.created_at] }),
    );
    expect(names(between).sort()).toEqual([first.filename, second.filename].sort());
    const after = await list(inA({ field: "created_at", op: "gt", value: second.created_at }));
    expect(after.total).toBe(5);
    expect(
      (
        await err("list", {
          collection: "files",
          filter: inA({ field: "created_at", op: "gt", value: "yesterday" }),
        })
      ).code,
    ).toBe("validation_error");
    expect(
      (
        await err("list", {
          collection: "files",
          filter: inA({ field: "thumb_url", op: "eq", value: "x" }),
        })
      ).code,
    ).toBe("validation_error");
    expect(
      (
        await err("list", {
          collection: "files",
          filter: inA({ field: "created_at", op: "between", value: [1] }),
        })
      ).code,
    ).toBe("validation_error");
  });

  it("hides soft-deleted files unless include_deleted is true", async () => {
    const live = await list(inA());
    expect(live.rows.map((r: { id: string }) => r.id)).not.toContain(deletedId);
    const withDeleted = await list(inA({ field: "include_deleted", op: "eq", value: true }));
    expect(withDeleted.total).toBe(8);
    const gone = withDeleted.rows.find((r: { id: string }) => r.id === deletedId);
    expect(gone).toMatchObject({
      filename: "gone.txt",
      include_deleted: true,
      deleted_at: expect.any(String),
    });
    const asString = await list(inA({ field: "include_deleted", op: "eq", value: "true" }));
    expect(asString.total).toBe(8);
    const explicitFalse = await list(inA({ field: "include_deleted", op: "eq", value: false }));
    expect(explicitFalse.total).toBe(7);
    expect(
      (
        await err("list", {
          collection: "files",
          filter: inA({ field: "include_deleted", op: "eq", value: "maybe" }),
        })
      ).code,
    ).toBe("validation_error");
  });

  it("isolates tenants", async () => {
    const theirs = await list(byType(), {}, other.key);
    expect(theirs.total).toBe(1);
    expect(theirs.rows[0]).toMatchObject({ id: otherId, filename: "theirs.txt" });
    const ours = await list(byType());
    expect(ours.rows.map((r: { id: string }) => r.id)).not.toContain(otherId);
    const peek = await list({ and: [byType(), { field: "id", op: "eq", value: otherId }] });
    expect(peek.total).toBe(0);
  });
});

describe("UDC list: sort and cursor paging", () => {
  const pageThrough = async (filter: unknown, extra: Record<string, unknown>, limit: number) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Payload = await list(filter, { ...extra, page: { limit, cursor } });
      expect(page.rows.length).toBeLessThanOrEqual(limit);
      seen.push(...page.rows.map((r: { id: string }) => r.id));
      cursor = page.next_cursor;
      pages++;
      expect(pages).toBeLessThan(20);
    } while (cursor);
    return { seen, pages };
  };

  it("pages by created_at desc in 3+ pages without duplicates or gaps", async () => {
    const all = await list(byType());
    const { seen, pages } = await pageThrough(byType(), {}, 3);
    expect(pages).toBe(3);
    expect(seen).toEqual(all.rows.map((r: { id: string }) => r.id));
    expect(new Set(seen).size).toBe(9);
  });

  it("sorts by filename and size, both directions, with stable cursors", async () => {
    // The order of the plain names is the database's collation; the masked name of the
    // encrypted file sorts wherever "<encrypted>" falls in it.
    const plain = ["alpha.txt", "notes.md", "photo.png", "q4.txt", "report.txt", "zeta.txt"];
    const asc = await list(inA(), { sort: [{ field: "filename", dir: "asc" }] });
    expect(names(asc).filter((n: string) => n !== ENCRYPTED_FILENAME)).toEqual(plain);
    expect(names(asc)).toContain(ENCRYPTED_FILENAME);
    const desc = await list(inA(), { sort: [{ field: "filename", dir: "desc" }] });
    expect(names(desc)).toEqual([...names(asc)].reverse());
    const bySize = await list(inA(), { sort: [{ field: "size" }] });
    const sizes = bySize.rows.map((r: { size: number }) => r.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));

    const byName = await pageThrough(inA(), { sort: [{ field: "filename", dir: "asc" }] }, 2);
    expect(byName.pages).toBe(4);
    expect(byName.seen).toEqual(asc.rows.map((r: { id: string }) => r.id));
    const bySizeDesc = await pageThrough(inA(), { sort: [{ field: "size", dir: "desc" }] }, 3);
    expect(new Set(bySizeDesc.seen).size).toBe(7);
  });

  it("breaks ties on id: two files with the same created_at land on different pages", async () => {
    const at = new Date(Date.now() - 86_400_000);
    const twin = randomUUID();
    await handle.db.insert(files).values(
      ["t1.txt", "t2.txt"].map((filename) => ({
        tenantId: fx.tenant.id,
        instanceType: "twins",
        instanceId: twin,
        hash: createHash("sha256").update(filename).digest("hex"),
        size: 1,
        filename,
        extension: "txt",
        mimeType: "text/plain",
        kind: "text",
        createdAt: at,
        updatedAt: at,
      })),
    );
    const { seen, pages } = await pageThrough(byType("twins"), {}, 1);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(2);
  });

  it("refuses offset paging, several sort keys, unsortable fields and foreign cursors", async () => {
    const payload = (extra: Record<string, unknown>) => ({
      collection: "files",
      filter: byType(),
      ...extra,
    });
    expect((await err("list", payload({ page: { offset: 10 } }))).message).toMatch(/cursor/);
    expect(
      (await err("list", payload({ sort: [{ field: "filename" }, { field: "size" }] }))).code,
    ).toBe("validation_error");
    expect((await err("list", payload({ sort: [{ field: "kind" }] }))).message).toMatch(
      /cannot be sorted/,
    );
    expect((await err("list", payload({ page: { cursor: "garbage" } }))).message).toMatch(
      /not a cursor/,
    );
    const first = await list(byType(), { page: { limit: 2 } });
    const foreign = await err(
      "list",
      payload({ sort: [{ field: "size" }], page: { cursor: first.next_cursor } }),
    );
    expect(foreign.message).toMatch(/another sort/);
    const cursor = decodePageCursor(first.next_cursor);
    expect(cursor).toMatchObject({ field: "created_at", dir: "desc", value: expect.any(Number) });
    expect(encodePageCursor(cursor)).toBe(first.next_cursor);
    expect(() => decodePageCursor(Buffer.from('["a","up",1,"x"]').toString("base64url"))).toThrow(
      UdcError,
    );
  });
});

describe("UDC read", () => {
  it("reads one live file of the tenant by id", async () => {
    const { row } = await ok("read", { collection: "files", id: ids["notes.md"] });
    expect(row).toMatchObject({ filename: "notes.md", folder_path: "docs", kind: "text" });
    const upper = await ok("read", {
      collection: "files",
      id: (ids["notes.md"] as string).toUpperCase(),
    });
    expect(upper.row.id).toBe(ids["notes.md"]);
    for (const id of [otherId, deletedId, "not-a-uuid", randomUUID()]) {
      expect((await err("read", { collection: "files", id })).code, id).toBe("not_found");
    }
    const theirs = await ok("read", { collection: "files", id: otherId }, other.key);
    expect(theirs.row.filename).toBe("theirs.txt");
  });
});

describe("UDC encrypted rows", () => {
  it("masks the name, MIME type, extension and thumbnail of an encrypted file", async () => {
    const page = await list(inA({ field: "encryption", op: "eq", value: "tenant" }));
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({
      id: encryptedId,
      filename: ENCRYPTED_FILENAME,
      mime_type: null,
      extension: null,
      thumb_url: null,
      encryption: "tenant",
      kind: "document",
      size: 4096,
      download_url: `/vola/files/${TYPE}/${TICKET_A}/${encryptedId}`,
    });
    const { row } = await ok("read", { collection: "files", id: encryptedId });
    expect(row.filename).toBe(ENCRYPTED_FILENAME);
    expect(JSON.stringify(row)).not.toContain("secret");
  });

  it("never lets the real name reach a filter, a sort or a cursor", async () => {
    expect((await list(inA({ field: "filename", op: "contains", value: "secret" }))).total).toBe(0);
    expect((await list(inA({ field: "extension", op: "eq", value: "pdf" }))).total).toBe(0);
    expect(
      (await list(inA({ field: "mime_type", op: "eq", value: "application/pdf" }))).total,
    ).toBe(0);
    expect(
      (await list(inA({ field: "filename", op: "eq", value: ENCRYPTED_FILENAME }))).total,
    ).toBe(1);
    // Page one row at a time by name: every cursor is readable, none carries the real name,
    // and the one after the encrypted row carries the mask.
    const cursors: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Payload = await list(inA(), {
        sort: [{ field: "filename", dir: "asc" }],
        page: { limit: 1, cursor },
      });
      expect(JSON.stringify(page)).not.toContain("secret");
      cursor = page.next_cursor;
      if (cursor) cursors.push(Buffer.from(cursor, "base64url").toString());
    } while (cursor);
    expect(cursors).toHaveLength(6);
    expect(cursors.some((c) => c.includes(ENCRYPTED_FILENAME))).toBe(true);
    expect(cursors.join("\n")).not.toContain("secret");
  });

  it("lets a decorateRow hook put a name back (the phase-6 unlock)", async () => {
    const decorated = await buildApp({
      config,
      db: handle.db,
      logger: false,
      menu: false,
      decorateRow: (row, file, tenant) => ({
        ...row,
        filename: file.encryption === "none" ? row.filename : `unlocked:${file.filename}`,
        tenant: tenant.tenantSlug,
      }),
    });
    const response = await decorated.inject({
      method: "POST",
      url: "/vola/udc/read",
      headers: bearer(fx.readOnly.key),
      payload: { collection: "files", id: encryptedId },
    });
    expect(response.json().payload.row).toMatchObject({
      filename: "unlocked:secret-plan.pdf",
      tenant: fx.tenant.slug,
    });
    await decorated.close();
  });
});

describe("UDC menu", () => {
  it("serves menu.yaml as one row", async () => {
    const page = await ok("list", { collection: "menu" });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      code: "FILES",
      translation_key: "MENU_FILES",
      icon: "lucide:files",
      url: "/examples/files",
      depth: 0,
    });
  });
});

describe("filter helpers", () => {
  it("reads and strips top-level conditions", () => {
    const node: FilterNode = {
      and: [{ field: "a", op: "eq", value: "1" }, { or: [{ field: "a", op: "eq", value: "2" }] }],
    };
    expect(pinnedValue(node, "a")).toBe("1");
    expect(pinnedValue(node, "b")).toBeNull();
    expect(pinnedValue({ field: "a", op: "eq", value: { x: 1 } }, "a")).toBeNull();
    expect(withoutTopLevel(node, "a")).toEqual({ or: [{ field: "a", op: "eq", value: "2" }] });
    expect(withoutTopLevel({ field: "a", op: "eq", value: 1 }, "a")).toBeUndefined();
    expect(
      withoutTopLevel(
        {
          and: [
            { field: "a", op: "eq", value: 1 },
            { field: "b", op: "eq", value: 2 },
            { field: "c", op: "eq", value: 3 },
          ],
        },
        "a",
      ),
    ).toEqual({
      and: [
        { field: "b", op: "eq", value: 2 },
        { field: "c", op: "eq", value: 3 },
      ],
    });
    expect(coerce("x", "number", "12")).toBe(12);
    expect(() => coerce("x", "number", "twelve")).toThrow(UdcError);
    expect(() => coerce("x", "text", null)).toThrow(UdcError);
    expect(coerce("x", "bool", 0)).toBe(false);
  });
});

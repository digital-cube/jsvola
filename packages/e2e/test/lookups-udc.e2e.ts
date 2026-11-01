import { randomUUID } from "node:crypto";
import { InstanceTypesResponseSchema, LookupsResponseSchema } from "@vola/core";
import {
  connect,
  createApiKey,
  createTenant,
  type DatabaseHandle,
  loadConfig,
  schema,
} from "@vola/server";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const server = inject("server");

describe("lookups (built server)", () => {
  it("GET /lookups serves the vocabulary shipped with the server, in en and sr", async () => {
    const en = LookupsResponseSchema.parse(await (await fetch(`${server}/lookups`)).json());
    expect(en.locale).toBe("en");
    expect(Object.keys(en.lookups)).toContain("FileKinds");
    expect(en.lookups.FileKinds?.find((e) => e.value === "image")?.label).toBe("Image");
    const sr = LookupsResponseSchema.parse(
      await (await fetch(`${server}/lookups?locale=sr`)).json(),
    );
    expect(sr.lookups.FileKinds?.find((e) => e.value === "image")?.label).toBe("Slika");
  });
});

/**
 * `/instance-types` and the UDC `files` collection over HTTP against the built server (its
 * `dist/` resolves `view.yaml`, `lookups.yaml` and `menu.yaml` by path). Needs the database
 * that server uses; skipped for an external `VOLA_E2E_URL`.
 */
describe.skipIf(Boolean(process.env.VOLA_E2E_URL))("UDC files collection (built server)", () => {
  let handle: DatabaseHandle;
  let key: string;
  const slug = `e2e-udc-${Date.now().toString(36)}`;
  const instanceId = randomUUID();

  const udc = async (action: string, payload: unknown) => {
    const response = await fetch(`${server}/udc/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: protocol payloads
    return (await response.json()) as { kind: string; payload: Record<string, any> };
  };

  beforeAll(async () => {
    handle = connect(loadConfig().testDatabaseUrl, { max: 1 });
    const tenant = await createTenant(handle.db, { slug, name: "E2E UDC" });
    key = (
      await createApiKey(handle.db, {
        tenantId: tenant.id,
        env: "test",
        name: "e2e-udc",
        scopes: ["files:read", "files:write"],
      })
    ).key;
    const form = new FormData();
    form.set("file", new Blob([Buffer.from("hello e2e")], { type: "text/plain" }), "hello.txt");
    const upload = await fetch(`${server}/files/tickets/${instanceId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
    expect(upload.status).toBe(201);
  });
  afterAll(async () => {
    await handle.db.delete(schema.files);
    await handle.db.delete(schema.apiKeys);
    await handle.db.delete(schema.tenants);
    await handle.close();
  });

  it("GET /instance-types counts the tenant's live files per type", async () => {
    const response = await fetch(`${server}/instance-types`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.status).toBe(200);
    expect(InstanceTypesResponseSchema.parse(await response.json())).toEqual({
      instance_types: [{ instance_type: "tickets", files: 1 }],
    });
  });

  it("lists collections, describes files and lists the uploaded file", async () => {
    const collections = await udc("collections", {});
    expect(collections.kind).toBe("udc.collections.ok");
    expect(collections.payload.collections.map((c: { name: string }) => c.name)).toEqual([
      "files",
      "menu",
    ]);
    const described = await udc("describe", { collection: "files" });
    expect(described.payload.schema.fields.kind).toMatchObject({
      type: "lookup",
      ref: "FileKinds",
    });
    expect(
      described.payload.view.columns.find((c: { field: string }) => c.field === "thumb_url").render,
    ).toBe("image_thumb");

    const empty = await udc("list", { collection: "files" });
    expect(empty.payload).toEqual({ rows: [], next_cursor: null, total: 0 });
    const page = await udc("list", {
      collection: "files",
      filter: { field: "instance_type", op: "eq", value: "tickets" },
    });
    expect(page.kind).toBe("udc.list.ok");
    expect(page.payload.total).toBe(1);
    expect(page.payload.rows[0]).toMatchObject({
      filename: "hello.txt",
      kind: "text",
      instance_id: instanceId,
      download_url: expect.stringContaining(`/files/tickets/${instanceId}/`),
    });
    const menu = await udc("list", { collection: "menu" });
    expect(menu.payload.rows[0]).toMatchObject({ code: "EXAMPLES", depth: 0 });
  });

  it("refuses a missing key in-protocol", async () => {
    const response = await fetch(`${server}/udc/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection: "files" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { kind: string; payload: { code: string } };
    expect(body.kind).toBe("udc.list.err");
    expect(body.payload.code).toBe("forbidden");
  });
});

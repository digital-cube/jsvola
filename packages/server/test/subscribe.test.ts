import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bearerSubprotocols,
  encodeTusMetadata,
  type ServerMessage,
  ServerMessageSchema,
  SUBSCRIBE_CLOSE_CODES,
  VOLA_SUBPROTOCOL,
} from "@vol-a/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { LocalFileEventBus } from "../src/events/bus.js";
import { createTenant } from "../src/services/tenants.js";
import { FilesystemBackend } from "../src/storage/index.js";
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
import { fileUpload, multipartHeaders } from "./multipart.js";

const handle = testDatabase(8);
let fx: Fixture;
let app: FastifyInstance;
let root: string;
let http: ReturnType<typeof httpClient>;
let other: { tenantId: string; key: string };
const apps: FastifyInstance[] = [];
const clients: Client[] = [];

const TYPE = "tickets";
const TUS = { "tus-resumable": "1.0.0" };
const PATCH_TYPE = "application/offset+octet-stream";

// biome-ignore lint/suspicious/noExplicitAny: the tests read deep into protocol payloads
type Payload = Record<string, any>;
type Message = ServerMessage & { payload: Payload };

/** `ws://…/vola/udc/subscribe` of a listening app. */
function wsUrl(instance: FastifyInstance, query = ""): string {
  const { port } = instance.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}/vola/udc/subscribe${query}`;
}

/**
 * A WebSocket client with a message queue the tests pull from. Listeners go on BEFORE the
 * socket opens: the welcome can arrive in the same packet as the handshake.
 */
class Client {
  readonly ws: WebSocket;
  readonly messages: Message[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly opened: Promise<void>;
  private waiters: (() => void)[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.opened = new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.on("message", (data) => {
      this.messages.push(ServerMessageSchema.parse(JSON.parse(String(data))) as Message);
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) =>
      ws.on("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
        for (const wake of this.waiters.splice(0)) wake();
      }),
    );
    clients.push(this);
  }

  send(message: unknown): void {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  /** The next queued message, waiting up to `timeoutMs` for one. */
  async next(timeoutMs = 3000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    while (this.messages.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0 || this.ws.readyState === WebSocket.CLOSED) {
        throw new Error(`no message within ${timeoutMs} ms (socket ${this.ws.readyState})`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.messages.shift() as Message;
  }

  /** The next message, which must be of `kind` (for the subscription `id` when given). */
  async expect(kind: string, id?: string): Promise<Payload> {
    const message = await this.next();
    expect(message.kind, JSON.stringify(message)).toBe(kind);
    if (id !== undefined) expect(message.id).toBe(id);
    return message.payload;
  }

  /** Asserts nothing arrives for `ms`. */
  async silence(ms = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    expect(this.messages).toEqual([]);
  }

  async subscribe(id: string, filter: unknown, collection = "files"): Promise<Payload> {
    this.send({ kind: "udc.subscribe", id, payload: { collection, filter } });
    return this.expect("udc.subscribe.ok", id);
  }

  close(): void {
    this.ws.close();
  }
}

/** Connects with the `bearer.<key>` subprotocol (default) and waits for the welcome. */
async function connect(
  key: string,
  options: { app?: FastifyInstance; headers?: Record<string, string>; query?: string } = {},
): Promise<{ client: Client; welcome: Payload }> {
  const ws = new WebSocket(wsUrl(options.app ?? app, options.query), bearerSubprotocols(key), {
    headers: options.headers ?? {},
  });
  const client = new Client(ws);
  await client.opened;
  const welcome = await client.expect("udc.welcome", "");
  return { client, welcome };
}

/** The HTTP status a refused upgrade answers with. */
function refused(
  url: string,
  protocols: string[] | undefined,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Payload }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { headers });
    ws.on("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
      });
    });
    ws.on("open", () => reject(new Error("the upgrade was accepted")));
    ws.on("error", reject);
  });
}

const byInstance = (instanceId: string, ...more: unknown[]) => ({
  and: [
    { field: "instance_type", op: "eq", value: TYPE },
    { field: "instance_id", op: "eq", value: instanceId },
    ...more,
  ],
});

/** The row `POST /udc/read` answers for a file, for comparison with what the stream sent. */
async function readRow(id: string, key = fx.full.key): Promise<Payload> {
  const response = await app.inject({
    method: "POST",
    url: "/vola/udc/read",
    headers: { ...bearer(key), "x-udc-message-id": "r" },
    payload: { collection: "files", id },
  });
  expect(response.json().kind, response.body).toBe("udc.read.ok");
  return response.json().payload.row;
}

async function listen(instance: FastifyInstance): Promise<FastifyInstance> {
  await instance.listen({ port: 0, host: "127.0.0.1" });
  apps.push(instance);
  return instance;
}

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-subscribe-"));
  fx = await setupFixture(handle, {
    storage: new FilesystemBackend(root),
    uploadsPath: join(root, "uploads"),
    uploadSweepIntervalMs: 0,
  });
  app = fx.app;
  await listen(app);
  http = httpClient(app, fx.full.key, TYPE);
  const tenant = await createTenant(handle.db, { slug: "other" });
  const key = await mintKey(handle, tenant.id, "other", "live", ["files:read", "files:write"]);
  other = { tenantId: tenant.id, key: key.key };
});
afterAll(async () => {
  for (const client of clients) client.ws.terminate();
  for (const instance of apps) await instance.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

describe("subscribe: connecting", () => {
  it("refuses a bad key, a key without files:read and an admin without a tenant before the upgrade", async () => {
    const url = wsUrl(app);
    expect(await refused(url, undefined)).toMatchObject({
      status: 401,
      body: { error: { code: "unauthorized" } },
    });
    expect(await refused(url, bearerSubprotocols("vola_live_nope"))).toMatchObject({
      status: 401,
    });
    const folders = await mintKey(handle, fx.tenant.id, "folders", "live", ["folders:read"]);
    expect(await refused(url, bearerSubprotocols(folders.key))).toMatchObject({
      status: 403,
      body: { error: { code: "forbidden", required: ["files:read"] } },
    });
    expect(await refused(url, bearerSubprotocols(fx.admin.key))).toMatchObject({
      status: 400,
      body: { error: { code: "tenant_required" } },
    });
    // The key never travels in the URL (the jsmemento rule).
    expect(await refused(`${url}?api_key=${fx.readOnly.key}`, undefined)).toMatchObject({
      status: 401,
    });
  });

  it("is a 400 for a plain GET without Upgrade", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/vola/udc/subscribe",
      headers: bearer(fx.readOnly.key),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/WebSocket/);
  });

  it("welcomes a subprotocol key (selecting vola.v1), a header key and an admin with X-Tenant-Slug", async () => {
    const { client, welcome } = await connect(fx.readOnly.key);
    expect(client.ws.protocol).toBe(VOLA_SUBPROTOCOL);
    expect(welcome).toEqual({
      protocol_version: "1",
      tenant: "acme",
      heartbeat_interval_ms: config.subscribe.heartbeatIntervalMs,
      max_buffered_messages: config.subscribe.maxBufferedMessages,
      max_subscriptions: 32,
    });
    client.close();

    const header = new Client(new WebSocket(wsUrl(app), { headers: bearer(fx.readOnly.key) }));
    await header.opened;
    expect(header.ws.protocol).toBe("");
    await header.expect("udc.welcome");
    header.close();

    const bare = new Client(new WebSocket(wsUrl(app), [`bearer.${fx.readOnly.key}`]));
    await bare.opened;
    expect(bare.ws.protocol).toBe(`bearer.${fx.readOnly.key}`);
    await bare.expect("udc.welcome");
    bare.close();

    const admin = await connect(fx.admin.key, { headers: { "x-tenant-slug": "acme" } });
    expect(admin.welcome.tenant).toBe("acme");
    admin.client.close();
  });

  it("answers ping, refuses garbage and unknown kinds, and keeps the connection open", async () => {
    const { client } = await connect(fx.readOnly.key);
    client.send({ kind: "udc.ping", id: "p1" });
    expect(await client.expect("udc.pong", "p1")).toEqual({});
    client.send("not json");
    expect((await client.expect("udc.error", "")).code).toBe("validation_error");
    client.send({ kind: "udc.list", id: "x" });
    expect((await client.expect("udc.error", "")).message).toMatch(/udc\.subscribe/);
    client.send({ kind: "udc.unsubscribe", id: "nope" });
    expect(await client.expect("udc.error", "nope")).toEqual({
      code: "not_found",
      message: 'no subscription "nope"',
    });
    client.send({ kind: "udc.ping", id: "p2" });
    await client.expect("udc.pong", "p2");
    client.close();
  });
});

describe("subscribe: opening subscriptions", () => {
  it("validates the payload, the collection and the filter like a list", async () => {
    const { client } = await connect(fx.readOnly.key);
    const err = async (id: string, payload: unknown) => {
      client.send({ kind: "udc.subscribe", id, payload });
      return client.expect("udc.subscribe.err", id);
    };
    expect((await err("a", {})).code).toBe("validation_error");
    expect(await err("b", { collection: "nope" })).toEqual({
      code: "not_found",
      message: 'no collection "nope"',
    });
    expect((await err("c", { collection: "menu" })).code).toBe("unsupported_op");
    expect(await err("d", { collection: "files" })).toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("instance_type"),
    });
    expect(
      await err("e", {
        collection: "files",
        filter: {
          and: [
            { field: "instance_type", op: "eq", value: TYPE },
            { field: "x", op: "eq", value: 1 },
          ],
        },
      }),
    ).toMatchObject({ code: "validation_error", message: expect.stringContaining('"x"') });
    await client.subscribe("s1", byInstance(randomUUID()));
    expect(
      (await err("s1", { collection: "files", filter: byInstance(randomUUID()) })).message,
    ).toBe('subscription "s1" is already open');
    client.close();
  });

  it("caps the subscriptions of one connection", async () => {
    const { client, welcome } = await connect(fx.readOnly.key);
    const filter = byInstance(randomUUID());
    for (let i = 0; i < welcome.max_subscriptions; i++) await client.subscribe(`s${i}`, filter);
    client.send({
      kind: "udc.subscribe",
      id: "one-too-many",
      payload: { collection: "files", filter },
    });
    expect((await client.expect("udc.subscribe.err", "one-too-many")).message).toMatch(
      /at most 32/,
    );
    client.close();
  });

  it("reports the files collection as subscribable, and not without an event bus", async () => {
    const collections = async (instance: FastifyInstance) => {
      const response = await instance.inject({
        method: "POST",
        url: "/vola/udc/collections",
        headers: { ...bearer(fx.readOnly.key), "x-udc-message-id": "c" },
        payload: {},
      });
      return response.json().payload.collections as { name: string; capabilities: Payload }[];
    };
    expect((await collections(app)).find((c) => c.name === "files")?.capabilities.subscribe).toBe(
      true,
    );
    const none = await buildApp({ config, db: handle.db, logger: false, events: false });
    expect((await collections(none)).find((c) => c.name === "files")?.capabilities.subscribe).toBe(
      false,
    );
    const response = await none.inject({
      method: "GET",
      url: "/vola/udc/subscribe",
      headers: bearer(fx.readOnly.key),
    });
    expect(response.statusCode).toBe(404);
    await none.close();
  });
});

describe("subscribe: file events", () => {
  it("sends the new row of an upload (as list would) and the id of a deleted and a purged one", async () => {
    const instanceId = randomUUID();
    const { client } = await connect(fx.readOnly.key);
    await client.subscribe("s1", byInstance(instanceId));

    const { response } = await http.upload(Buffer.from("hello"), "hello.txt", {
      instanceId,
      headers: { "x-user-id": "igor" },
    });
    expect(response.statusCode).toBe(201);
    const id = response.json().id as string;
    const upsert = await client.expect("udc.row.upsert", "s1");
    expect(upsert.collection).toBe("files");
    expect(upsert.event).toBe("created");
    expect(upsert.row).toEqual(await readRow(id));
    expect(upsert.row).toMatchObject({
      __meta: { id, version: 1 },
      filename: "hello.txt",
      instance_id: instanceId,
      folder_path: "",
      created_by: "igor",
      download_url: `/vola/files/${TYPE}/${instanceId}/${id}`,
    });

    expect((await http.del(`/vola/files/${TYPE}/${instanceId}/${id}`)).statusCode).toBe(200);
    expect(await client.expect("udc.row.remove", "s1")).toEqual({
      collection: "files",
      id,
      event: "deleted",
    });
    // Idempotent: a second soft delete changes nothing and announces nothing.
    await http.del(`/vola/files/${TYPE}/${instanceId}/${id}`);
    await client.silence();

    expect((await http.del(`/vola/files/${TYPE}/${instanceId}/${id}/purge`)).statusCode).toBe(200);
    expect(await client.expect("udc.row.remove", "s1")).toMatchObject({ id, event: "purged" });
    client.close();
  });

  it("gives an include_deleted subscription the soft-deleted row instead of a remove", async () => {
    const instanceId = randomUUID();
    const { client } = await connect(fx.readOnly.key);
    await client.subscribe(
      "all",
      byInstance(instanceId, { field: "include_deleted", op: "eq", value: true }),
    );
    const id = (await http.upload(Buffer.from("x"), "x.txt", { instanceId })).response.json().id;
    await client.expect("udc.row.upsert", "all");
    await http.del(`/vola/files/${TYPE}/${instanceId}/${id}`);
    const upsert = await client.expect("udc.row.upsert", "all");
    expect(upsert.event).toBe("deleted");
    expect(upsert.row.include_deleted).toBe(true);
    expect(upsert.row.deleted_at).toEqual(expect.any(String));
    client.close();
  });

  it("never delivers another tenant's event, and nothing after unsubscribe", async () => {
    const instanceId = randomUUID();
    const { client } = await connect(fx.readOnly.key);
    await client.subscribe("s1", byInstance(instanceId));
    // The other tenant uploads into the SAME instance ids: the subscription stays silent.
    const theirs = await http.upload(Buffer.from("theirs"), "theirs.txt", {
      instanceId,
      key: other.key,
    });
    expect(theirs.response.statusCode).toBe(201);
    await client.silence();
    const mine = await http.upload(Buffer.from("mine"), "mine.txt", { instanceId });
    expect((await client.expect("udc.row.upsert", "s1")).row.__meta.id).toBe(
      mine.response.json().id,
    );

    client.send({ kind: "udc.unsubscribe", id: "s1" });
    await client.expect("udc.unsubscribe.ok", "s1");
    await http.upload(Buffer.from("later"), "later.txt", { instanceId });
    await client.silence();
    client.close();
  });

  it("applies the folder filter: a move is a remove for the old folder and an upsert for the new one", async () => {
    const instanceId = randomUUID();
    const { client } = await connect(fx.readOnly.key);
    await client.subscribe(
      "docs",
      byInstance(instanceId, { field: "folder_path", op: "eq", value: "docs" }),
    );
    await client.subscribe(
      "root",
      byInstance(instanceId, { field: "folder_path", op: "eq", value: "" }),
    );

    const inRoot = (
      await http.upload(Buffer.from("r"), "root.txt", { instanceId })
    ).response.json();
    expect((await client.expect("udc.row.upsert", "root")).row.__meta.id).toBe(inRoot.id);
    await client.silence(); // nothing for "docs": a new file it cannot have

    const inDocs = (
      await http.upload(Buffer.from("d"), "doc.txt", {
        instanceId,
        fields: { folder_path: "docs" },
      })
    ).response.json();
    expect((await client.expect("udc.row.upsert", "docs")).row.folder_path).toBe("docs");
    await client.silence();

    const moved = await http.patch(`/vola/files/${TYPE}/${instanceId}/${inDocs.id}`, {
      folder_path: "",
    });
    expect(moved.statusCode).toBe(200);
    const first = await client.next();
    const second = await client.next();
    const byId = new Map([first, second].map((m) => [m.id, m]));
    expect(byId.get("docs")).toMatchObject({
      kind: "udc.row.remove",
      payload: { id: inDocs.id, event: "updated" },
    });
    expect(byId.get("root")).toMatchObject({
      kind: "udc.row.upsert",
      payload: { row: { __meta: { id: inDocs.id }, folder_path: "" }, event: "updated" },
    });
    client.close();
  });

  it("applies the rest of the filter too: a rename out of a filename filter is a remove", async () => {
    const instanceId = randomUUID();
    const { client } = await connect(fx.readOnly.key);
    await client.subscribe(
      "reports",
      byInstance(instanceId, {
        field: "filename",
        op: "contains",
        value: "report",
        case_insensitive: true,
      }),
    );
    const id = (
      await http.upload(Buffer.from("q"), "Q4-Report.pdf", {
        instanceId,
        contentType: "application/pdf",
      })
    ).response.json().id;
    await client.expect("udc.row.upsert", "reports");
    await http.patch(`/vola/files/${TYPE}/${instanceId}/${id}`, { filename: "summary.pdf" });
    expect(await client.expect("udc.row.remove", "reports")).toMatchObject({
      id,
      event: "updated",
    });
    // Still out of the filter: another remove, which a client that no longer has the row ignores.
    await http.patch(`/vola/files/${TYPE}/${instanceId}/${id}`, { is_public: true });
    expect(await client.expect("udc.row.remove", "reports")).toMatchObject({ id });
    client.close();
  });

  it("announces a slug upsert as a remove of the replaced file and an upsert of the new one, and a new version", async () => {
    const instanceId = randomUUID();
    const { client } = await connect(fx.readOnly.key);
    await client.subscribe("s", byInstance(instanceId));
    const put = (data: string) =>
      app.inject({
        method: "PUT",
        url: `/vola/files/${TYPE}/${instanceId}/slug/avatar`,
        headers: multipartHeaders(bearer(fx.full.key)),
        payload: fileUpload("avatar.png", Buffer.from(data)),
      });
    const first = (await put("one")).json();
    expect((await client.expect("udc.row.upsert", "s")).row.__meta.id).toBe(first.id);
    const second = (await put("two")).json();
    expect(await client.expect("udc.row.remove", "s")).toMatchObject({
      id: first.id,
      event: "deleted",
    });
    expect((await client.expect("udc.row.upsert", "s")).row).toMatchObject({
      __meta: { id: second.id },
      slug: "avatar",
    });

    const version = await http.upload(Buffer.from("v2"), "avatar.png", {
      instanceId,
      fields: { parent_id: second.id },
    });
    expect(version.response.statusCode).toBe(201);
    expect((await client.expect("udc.row.upsert", "s")).row.__meta.id).toBe(
      version.response.json().id,
    );
    client.close();
  });

  it("announces the file a resumable upload completes", async () => {
    const instanceId = randomUUID();
    const { client } = await connect(fx.readOnly.key);
    await client.subscribe("s", byInstance(instanceId));
    const created = await app.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: {
        ...bearer(fx.full.key),
        ...TUS,
        "upload-length": "5",
        "upload-metadata": encodeTusMetadata({
          instance_type: TYPE,
          instance_id: instanceId,
          filename: "resumable.txt",
        }),
      },
    });
    expect(created.statusCode).toBe(201);
    await client.silence(); // nothing until the bytes are complete
    const done = await app.inject({
      method: "PATCH",
      url: created.headers.location as string,
      headers: { ...bearer(fx.full.key), ...TUS, "content-type": PATCH_TYPE, "upload-offset": "0" },
      payload: Buffer.from("hello"),
    });
    expect(done.statusCode).toBe(204);
    expect((await client.expect("udc.row.upsert", "s")).row).toMatchObject({
      __meta: { id: done.headers["vola-file-id"] },
      filename: "resumable.txt",
    });
    client.close();
  });

  it("follows a folder rename (new folder_path) and a recursive folder delete", async () => {
    const instanceId = randomUUID();
    const { client } = await connect(fx.readOnly.key);
    await client.subscribe("s", byInstance(instanceId));
    const a = (
      await http.upload(Buffer.from("a"), "a.txt", {
        instanceId,
        fields: { folder_path: "old/deep" },
      })
    ).response.json();
    const b = (
      await http.upload(Buffer.from("b"), "b.txt", { instanceId, fields: { folder_path: "old" } })
    ).response.json();
    await client.expect("udc.row.upsert", "s");
    await client.expect("udc.row.upsert", "s");

    const renamed = await http.patch(`/vola/folders/${TYPE}/${instanceId}/old`, { name: "new" });
    expect(renamed.statusCode).toBe(200);
    const paths = new Map<string, string>();
    for (let i = 0; i < 2; i++) {
      const upsert = await client.expect("udc.row.upsert", "s");
      expect(upsert.event).toBe("updated");
      paths.set(upsert.row.__meta.id, upsert.row.folder_path);
    }
    expect(paths).toEqual(
      new Map([
        [a.id, "new/deep"],
        [b.id, "new"],
      ]),
    );

    const deleted = await http.del(`/vola/folders/${TYPE}/${instanceId}/new?recursive=1`);
    expect(deleted.statusCode).toBe(200);
    const removed = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const remove = await client.expect("udc.row.remove", "s");
      expect(remove.event).toBe("deleted");
      removed.add(remove.id);
    }
    expect(removed).toEqual(new Set([a.id, b.id]));
    client.close();
  });

  it("serves an admin's type-wide subscription (no instance_id) across instances", async () => {
    const { client } = await connect(fx.admin.key, { headers: { "x-tenant-slug": "acme" } });
    await client.subscribe("type", { field: "instance_type", op: "eq", value: "invoices" });
    const one = (
      await http.upload(Buffer.from("1"), "1.txt", { type: "invoices" })
    ).response.json();
    const two = (
      await http.upload(Buffer.from("2"), "2.txt", { type: "invoices" })
    ).response.json();
    expect((await client.expect("udc.row.upsert", "type")).row.__meta.id).toBe(one.id);
    expect((await client.expect("udc.row.upsert", "type")).row.__meta.id).toBe(two.id);
    await http.upload(Buffer.from("3"), "3.txt", { type: "tickets" });
    await client.silence();
    client.close();
  });
});

describe("subscribe: processes and feeds", () => {
  it("delivers an event published by another server process through Redis", async () => {
    expect(config.redisUrl, "VOLA_REDIS_URL is needed for this test").toBeTruthy();
    const second = await listen(
      await buildApp({
        config,
        db: handle.db,
        logger: false,
        storage: new FilesystemBackend(root),
      }),
    );
    const instanceId = randomUUID();
    const { client } = await connect(fx.readOnly.key, { app: second });
    await client.subscribe("s", byInstance(instanceId));
    const uploaded = await http.upload(Buffer.from("cross"), "cross.txt", { instanceId }); // via `app`
    expect((await client.expect("udc.row.upsert", "s")).row.__meta.id).toBe(
      uploaded.response.json().id,
    );
    client.close();
    await second.close();
    apps.splice(apps.indexOf(second), 1);
  });

  it("works in-process without Redis", async () => {
    const events = new LocalFileEventBus();
    const local = await listen(
      await buildApp({
        config: { ...config, redisUrl: null },
        db: handle.db,
        logger: false,
        storage: new FilesystemBackend(root),
        events,
      }),
    );
    const instanceId = randomUUID();
    const { client } = await connect(fx.readOnly.key, { app: local });
    await client.subscribe("s", byInstance(instanceId));
    expect(events.subscribed()).toEqual([fx.tenant.id]);
    const uploaded = await local.inject({
      method: "POST",
      url: `/vola/files/${TYPE}/${instanceId}`,
      headers: multipartHeaders(bearer(fx.full.key)),
      payload: fileUpload("local.txt", Buffer.from("local")),
    });
    expect(uploaded.statusCode).toBe(201);
    expect((await client.expect("udc.row.upsert", "s")).row.__meta.id).toBe(uploaded.json().id);
    expect(events.published.map((e) => e.kind)).toEqual(["created"]);
    client.close();
    await client.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.subscribed()).toEqual([]);
    await local.close();
    apps.splice(apps.indexOf(local), 1);
  });

  it("closes a slow consumer with 4008, leaving other clients alone, and lets it reconnect", async () => {
    const slowApp = await listen(
      await buildApp({
        config,
        db: handle.db,
        logger: false,
        storage: new FilesystemBackend(root),
        subscribe: { maxBufferedMessages: 2 },
      }),
    );
    const instanceId = randomUUID();
    const { client: slow, welcome } = await connect(fx.readOnly.key, { app: slowApp });
    expect(welcome.max_buffered_messages).toBe(2);
    const { client: fine } = await connect(fx.readOnly.key, { app: slowApp });
    // One upload fans out to four subscriptions of the slow client in one go: more than it may
    // have unwritten at once.
    for (const id of ["a", "b", "c", "d"]) await slow.subscribe(id, byInstance(instanceId));
    await fine.subscribe("f", byInstance(instanceId));
    await http.upload(Buffer.from("burst"), "burst.txt", { instanceId });
    expect(await slow.closed).toEqual({
      code: SUBSCRIBE_CLOSE_CODES.slow_consumer,
      reason: "slow consumer",
    });
    expect((await fine.expect("udc.row.upsert", "f")).row.filename).toBe("burst.txt");

    const again = await connect(fx.readOnly.key, { app: slowApp });
    await again.client.subscribe("a", byInstance(instanceId));
    await http.upload(Buffer.from("after"), "after.txt", { instanceId });
    expect((await again.client.expect("udc.row.upsert", "a")).row.filename).toBe("after.txt");
    again.client.close();
    fine.close();
    await slowApp.close();
    apps.splice(apps.indexOf(slowApp), 1);
  });

  it("terminates a client that stops answering pings, and closes everyone with 1001 on shutdown", async () => {
    const pinging = await listen(
      await buildApp({
        config,
        db: handle.db,
        logger: false,
        subscribe: { heartbeatIntervalMs: 200 },
      }),
    );
    const { client: deaf } = await connect(fx.readOnly.key, { app: pinging });
    const { client: alive } = await connect(fx.readOnly.key, { app: pinging });
    // `ws` answers pings by itself; a client that does not is terminated after two intervals.
    (deaf.ws as unknown as { pong: () => void }).pong = () => {};
    const closed = await deaf.closed;
    expect(closed.code).toBe(1006);
    expect(alive.ws.readyState).toBe(WebSocket.OPEN);

    await pinging.close();
    apps.splice(apps.indexOf(pinging), 1);
    expect(await alive.closed).toEqual({ code: 1001, reason: "server shutting down" });
  });
});

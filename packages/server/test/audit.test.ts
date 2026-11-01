import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiKeyCreatedSchema, FileInfoSchema, ShareCreatedSchema } from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AuditLog, actorOf, createAuditSink, disabledAuditLog } from "../src/audit/log.js";
import {
  AuditDeliveryError,
  type AuditEvent,
  fileAuditPayload,
  MementoSink,
  NoopSink,
} from "../src/audit/memento.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { files } from "../src/db/schema.js";
import { AUDIT_MAX_ATTEMPTS, ProcessingQueue } from "../src/jobs/queue.js";
import { ProcessingWorker } from "../src/jobs/worker.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { waitFor } from "./fixtures.js";
import { bearer, config, type Fixture, setupFixture, testDatabase, truncate } from "./helpers.js";
import { httpClient } from "./http.js";

/** A request the fake memento received. */
interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: AuditEvent;
}

/** The fake memento: records every `POST /events`; `answer` decides the status of the next ones. */
class FakeMemento {
  readonly received: Received[] = [];
  /** Status codes to answer, in order; empty → 201. */
  answers: number[] = [];
  private server: Server | null = null;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request).then((body) => {
        const status = this.answers.shift() ?? 201;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify(status < 300 ? { id: randomUUID(), ...body } : { error: status }),
        );
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/memento`;
  }

  private async handle(request: IncomingMessage): Promise<AuditEvent> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AuditEvent;
    this.received.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body,
    });
    return body;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
    this.server = null;
  }

  /** Waits until `n` events of `type` arrived, newest last. */
  async events(type: string, n = 1): Promise<AuditEvent[]> {
    return waitFor(
      async () => {
        const matching = this.received.filter((r) => r.body.event_type === type).map((r) => r.body);
        return matching.length >= n ? matching : null;
      },
      { label: `${n} ${type}`, timeoutMs: 5000 },
    );
  }
}

const handle = testDatabase(6);
const memento = new FakeMemento();
let fx: Fixture;
let app: FastifyInstance;
let root: string;
let http: ReturnType<typeof httpClient>;

const TYPE = "tickets";
const API_KEY = "mem_write_test_key";

beforeAll(async () => {
  await truncate(handle);
  await memento.start();
  root = await mkdtemp(join(tmpdir(), "vola-audit-"));
  // Direct mode: no queue (`VOLA_WORKER_ENABLED=0` in the test config), one push per event.
  fx = await setupFixture(handle, {
    config: { ...config, memento: { url: memento.url, apiKey: API_KEY } },
    storage: new FilesystemBackend(root),
    uploadSweepIntervalMs: 0,
  });
  app = fx.app;
  await app.ready();
  http = httpClient(app, fx.full.key, TYPE);
});
afterAll(async () => {
  await app.close();
  await memento.stop();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  memento.received.length = 0;
  memento.answers = [];
});

async function uploaded(
  data: Buffer,
  filename: string,
  options: {
    instanceId?: string;
    fields?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
) {
  const { response, instanceId } = await http.upload(data, filename, options);
  expect(response.statusCode, response.body).toBe(201);
  return { info: FileInfoSchema.parse(response.json()), instanceId };
}

const user = (id: string) => ({ "x-user-id": id });

describe("audit → memento (direct mode)", () => {
  it("posts VOLA_FILE_DELETED to <url>/events with the write key, the actor and the file's facts", async () => {
    const { info, instanceId } = await uploaded(Buffer.from("bye"), "bye.txt", {
      fields: { folder_path: "docs" },
    });
    const response = await http.del(`/vola/files/${TYPE}/${instanceId}/${info.id}`, user("alice"));
    expect(response.statusCode).toBe(200);
    await memento.events("VOLA_FILE_DELETED");
    const [request] = memento.received;
    expect(request).toMatchObject({
      method: "POST",
      url: "/memento/events",
      authorization: `Bearer ${API_KEY}`,
    });
    expect(request?.contentType).toMatch(/^application\/json/);
    expect(request?.body).toEqual({
      event_type: "VOLA_FILE_DELETED",
      instance_type: "vola_file",
      instance_id: info.id,
      actor_type: "user",
      actor_id: "alice",
      payload: {
        tenant: "acme",
        file_id: info.id,
        instance_type: TYPE,
        instance_id: instanceId,
        folder_id: info.folder_id,
        slug: null,
        size: 3,
        mime_type: "text/plain",
        kind: "text",
        encryption: "none",
        filename: "bye.txt",
      },
      occurred_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    // Deleting it again is idempotent and records nothing more.
    await http.del(`/vola/files/${TYPE}/${instanceId}/${info.id}`, user("alice"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(memento.received.filter((r) => r.body.event_type === "VOLA_FILE_DELETED")).toHaveLength(
      1,
    );
  });

  it("names the API key as the actor when the request has no X-User-Id", async () => {
    const { info, instanceId } = await uploaded(Buffer.from("k"), "k.txt");
    await http.del(`/vola/files/${TYPE}/${instanceId}/${info.id}`);
    const [event] = await memento.events("VOLA_FILE_DELETED");
    expect(event).toMatchObject({
      actor_type: "api_key",
      actor_id: `key:${fx.full.apiKey.prefix}…${fx.full.apiKey.last4}`,
    });
    expect(event?.actor_id).not.toContain(fx.full.key);
  });

  it("records a purge with the version ids and the blob count", async () => {
    const instanceId = randomUUID();
    const v1 = await uploaded(Buffer.from("v1 unique"), "r.pdf", { instanceId });
    const v2 = await uploaded(Buffer.from("v2 unique"), "r.pdf", {
      instanceId,
      fields: { parent_id: v1.info.id },
    });
    const response = await http.del(
      `/vola/files/${TYPE}/${instanceId}/${v2.info.id}/purge`,
      user("bob"),
    );
    expect(response.statusCode).toBe(200);
    const [event] = await memento.events("VOLA_FILE_PURGED");
    expect(event).toMatchObject({
      instance_type: "vola_file",
      instance_id: v2.info.id,
      actor_id: "bob",
      payload: { file_id: v2.info.id, files: 2, blobs: 2, filename: "r.pdf", tenant: "acme" },
    });
    expect([...((event?.payload.versions as string[] | undefined) ?? [])].sort()).toEqual(
      [v1.info.id, v2.info.id].sort(),
    );
  });

  it("records a visibility change with the previous flags, and not a plain move or rename", async () => {
    const { info, instanceId } = await uploaded(Buffer.from("v"), "v.txt");
    const moved = await http.patch(`/vola/files/${TYPE}/${instanceId}/${info.id}`, {
      filename: "w.txt",
    });
    expect(moved.statusCode).toBe(200);
    const flagged = await http.patch(
      `/vola/files/${TYPE}/${instanceId}/${info.id}`,
      { is_public: true },
      user("carol"),
    );
    expect(flagged.statusCode).toBe(200);
    const [event] = await memento.events("VOLA_FILE_VISIBILITY_CHANGED");
    expect(event).toMatchObject({
      instance_id: info.id,
      actor_id: "carol",
      payload: {
        filename: "w.txt",
        is_public: true,
        is_global_public: false,
        previous: { is_public: false, is_global_public: false },
      },
    });
    expect(memento.received).toHaveLength(1);
  });

  it("records every file a recursive folder delete removes", async () => {
    const instanceId = randomUUID();
    const a = await uploaded(Buffer.from("a"), "a.txt", {
      instanceId,
      fields: { folder_path: "bin" },
    });
    const b = await uploaded(Buffer.from("b"), "b.txt", {
      instanceId,
      fields: { folder_path: "bin/deep" },
    });
    const response = await app.inject({
      method: "DELETE",
      url: `/vola/folders/${TYPE}/${instanceId}/bin?recursive=1`,
      headers: { ...bearer(fx.full.key), ...user("dave") },
    });
    expect(response.statusCode, response.body).toBe(200);
    const events = await memento.events("VOLA_FILE_DELETED", 2);
    expect(events.map((e) => e.instance_id).sort()).toEqual([a.info.id, b.info.id].sort());
    expect(events[0]).toMatchObject({
      actor_id: "dave",
      payload: { folder_path: "bin", recursive: true },
    });
  });

  it("records share creation and revocation without the token or the password", async () => {
    const { info } = await uploaded(Buffer.from("s"), "s.txt");
    const created = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: { ...bearer(fx.full.key), ...user("erin") },
      payload: { file_id: info.id, password: "hunter2", max_downloads: 3 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const share = ShareCreatedSchema.parse(created.json());
    const [made] = await memento.events("VOLA_SHARE_CREATED");
    expect(made).toMatchObject({
      instance_type: "vola_share",
      instance_id: share.id,
      actor_id: "erin",
      payload: {
        share_id: share.id,
        file_id: info.id,
        folder_id: null,
        scope: "PUBLIC_LINK",
        has_password: true,
        max_downloads: 3,
        download_count: 0,
        tenant: "acme",
      },
    });
    const wire = JSON.stringify(memento.received);
    expect(wire).not.toContain(share.token);
    expect(wire).not.toContain("hunter2");
    expect(wire).not.toContain("$argon2");
    expect(made?.payload).not.toHaveProperty("token");
    expect(made?.payload).not.toHaveProperty("password");

    const revoked = await http.del(`/vola/shares/${share.id}`, user("erin"));
    expect(revoked.statusCode).toBe(200);
    const [gone] = await memento.events("VOLA_SHARE_REVOKED");
    expect(gone).toMatchObject({ instance_id: share.id, payload: { share_id: share.id } });
    expect(gone?.payload.revoked_at).toEqual(expect.any(String));
    expect(JSON.stringify(gone)).not.toContain(share.token);
  });

  it("records key creation and revocation without the plaintext or the hash", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/vola/keys",
      headers: { ...bearer(fx.full.key), ...user("frank") },
      payload: { name: "ci", scopes: ["files:read"], env: "test" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const key = ApiKeyCreatedSchema.parse(created.json());
    const [made] = await memento.events("VOLA_KEY_CREATED");
    expect(made).toMatchObject({
      instance_type: "vola_key",
      instance_id: key.id,
      actor_id: "frank",
      payload: {
        key_id: key.id,
        name: "ci",
        prefix: "vola_test",
        last4: key.last4,
        scopes: ["files:read"],
        is_admin: false,
        created_by: "frank",
        tenant: "acme",
      },
    });
    expect(JSON.stringify(memento.received)).not.toContain(key.key);
    const revoked = await http.del(`/vola/keys/${key.id}`);
    expect(revoked.statusCode).toBe(200);
    const [gone] = await memento.events("VOLA_KEY_REVOKED");
    expect(gone).toMatchObject({ instance_id: key.id, payload: { key_id: key.id } });
    expect(gone?.payload.revoked_at).toEqual(expect.any(String));
    expect(JSON.stringify(memento.received)).not.toContain(key.key);
  });

  it("leaves the filename out of the payload of an encrypted file", async () => {
    const { info, instanceId } = await uploaded(Buffer.from("secret"), "payroll.xlsx");
    await handle.db.update(files).set({ encryption: "tenant" }).where(eq(files.id, info.id));
    const response = await http.del(`/vola/files/${TYPE}/${instanceId}/${info.id}`);
    expect(response.statusCode).toBe(200);
    const [event] = await memento.events("VOLA_FILE_DELETED");
    expect(event?.payload).toMatchObject({ file_id: info.id, encryption: "tenant", size: 6 });
    expect(event?.payload).not.toHaveProperty("filename");
    expect(JSON.stringify(event)).not.toContain("payroll");
  });

  it("does not fail the vola request when memento answers 500 or is down", async () => {
    memento.answers = [500];
    const one = await uploaded(Buffer.from("1"), "1.txt");
    const first = await http.del(`/vola/files/${TYPE}/${one.instanceId}/${one.info.id}`);
    expect(first.statusCode).toBe(200);
    await memento.events("VOLA_FILE_DELETED"); // received, refused, not retried in direct mode

    await memento.stop();
    const two = await uploaded(Buffer.from("2"), "2.txt");
    const second = await http.del(`/vola/files/${TYPE}/${two.instanceId}/${two.info.id}`);
    expect(second.statusCode).toBe(200);
    expect(
      (
        await http.get(
          `/vola/files/${TYPE}/${two.instanceId}/${two.info.id}/info?include_deleted=1`,
        )
      ).json().deleted_at,
    ).not.toBeNull();
    await memento.start(); // a new port; the app keeps the old URL, which is now dead
    const three = await uploaded(Buffer.from("3"), "3.txt");
    expect(
      (await http.del(`/vola/files/${TYPE}/${three.instanceId}/${three.info.id}`)).statusCode,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(memento.received).toHaveLength(1);
  });
});

describe("audit → memento (through the queue and the worker)", () => {
  const redisUrl = config.redisUrl as string;
  const prefix = `vola-audit-${randomUUID().slice(0, 8)}`;
  let queue: ProcessingQueue;
  let worker: ProcessingWorker;
  let queued: FastifyInstance;
  let own: FakeMemento;

  beforeAll(async () => {
    expect(redisUrl, "VOLA_REDIS_URL is needed for the queued audit suite").toBeTruthy();
    own = new FakeMemento();
    await own.start();
    queue = new ProcessingQueue({ redisUrl, prefix, backoffMs: 20 });
    queued = await buildApp({
      config: { ...config, memento: { url: own.url, apiKey: API_KEY } },
      db: handle.db,
      logger: false,
      storage: new FilesystemBackend(root),
      jobs: queue,
      uploadSweepIntervalMs: 0,
      statsRefreshIntervalMs: 0,
    });
    await queued.ready();
    worker = new ProcessingWorker({
      redisUrl,
      prefix,
      db: handle.db,
      storage: new FilesystemBackend(root),
      audit: new MementoSink({ url: own.url, apiKey: API_KEY, timeoutMs: 500 }),
      jobTimeoutMs: 5000,
    });
    await worker.ready();
  });
  afterAll(async () => {
    await worker.close();
    await queued.close();
    await queue.close();
    await own.stop();
  });

  it("delivers the event through an `audit` job and retries after a 5xx", async () => {
    own.answers = [503, 500]; // two failures, then 201
    const instanceId = randomUUID();
    const upload = await httpClient(queued, fx.full.key, TYPE).upload(Buffer.from("q"), "q.txt", {
      instanceId,
    });
    expect(upload.response.statusCode).toBe(201);
    const info = FileInfoSchema.parse(upload.response.json());
    const response = await queued.inject({
      method: "DELETE",
      url: `/vola/files/${TYPE}/${instanceId}/${info.id}`,
      headers: { ...bearer(fx.full.key), ...user("grace") },
    });
    expect(response.statusCode).toBe(200);
    const events = await own.events("VOLA_FILE_DELETED", 3);
    expect(events).toHaveLength(3); // the same event, three times at the door
    expect(events[2]).toMatchObject({ instance_id: info.id, actor_id: "grace" });
    expect(own.received.filter((r) => r.body.instance_id === info.id)).toHaveLength(3);
  });

  it("drops an event memento refuses for good (4xx) after one try", async () => {
    own.answers = [422];
    const instanceId = randomUUID();
    const upload = await httpClient(queued, fx.full.key, TYPE).upload(Buffer.from("x"), "x.txt", {
      instanceId,
    });
    const info = FileInfoSchema.parse(upload.response.json());
    await queued.inject({
      method: "DELETE",
      url: `/vola/files/${TYPE}/${instanceId}/${info.id}`,
      headers: bearer(fx.full.key),
    });
    await own.events("VOLA_FILE_DELETED", 1);
    await waitFor(
      async () =>
        (await queue.queue.getJobCounts("waiting", "delayed", "active")).waiting === 0 || true,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(own.received.filter((r) => r.body.instance_id === info.id)).toHaveLength(1);
    expect(AUDIT_MAX_ATTEMPTS).toBe(5);
  });
});

describe("audit building blocks", () => {
  it("is disabled without VOLA_MEMENTO_*: a NoopSink, no requests, `enabled` false", async () => {
    const lines: string[] = [];
    const sink = createAuditSink(null, {
      info: (...args: unknown[]) => void lines.push(String(args.at(-1))),
    });
    expect(sink).toBeInstanceOf(NoopSink);
    expect(lines).toEqual(["audit disabled: VOLA_MEMENTO_URL / VOLA_MEMENTO_API_KEY are not set"]);
    const log = new AuditLog({ sink });
    expect(log.enabled).toBe(false);
    log.emit({
      event_type: "VOLA_FILE_DELETED",
      instance_type: "vola_file",
      instance_id: "x",
      payload: {},
    });
    await log.close();
    expect(disabledAuditLog().enabled).toBe(false);
    const enabled = createAuditSink({ url: "http://memento.test/memento/", apiKey: "k" });
    expect(enabled).toBeInstanceOf(MementoSink);
    expect((enabled as MementoSink).url).toBe("http://memento.test/memento/events");
  });

  it("loadConfig wants both memento variables or neither", () => {
    expect(() => loadConfig({ VOLA_MEMENTO_URL: "http://m.test/memento" })).toThrow(ConfigError);
    expect(() => loadConfig({ VOLA_MEMENTO_API_KEY: "k" })).toThrow(ConfigError);
    expect(() => loadConfig({ VOLA_MEMENTO_URL: "not a url", VOLA_MEMENTO_API_KEY: "k" })).toThrow(
      ConfigError,
    );
    expect(loadConfig({}).memento).toBeNull();
    expect(
      loadConfig({ VOLA_MEMENTO_URL: "http://m.test/memento/", VOLA_MEMENTO_API_KEY: "k" }).memento,
    ).toEqual({
      url: "http://m.test/memento",
      apiKey: "k",
    });
  });

  it("MementoSink tells a retryable failure from a final one and times out", async () => {
    const answering = (status: number) =>
      new MementoSink({
        url: "http://m.test/memento",
        apiKey: "k",
        fetch: (async () => new Response("{}", { status })) as typeof fetch,
      });
    const event: AuditEvent = {
      event_type: "VOLA_KEY_REVOKED",
      instance_type: "vola_key",
      instance_id: "k1",
      actor_type: null,
      actor_id: null,
      payload: {},
      occurred_at: new Date().toISOString(),
    };
    await expect(answering(201).send(event)).resolves.toBeUndefined();
    for (const [status, retryable] of [
      [500, true],
      [503, true],
      [429, true],
      [408, true],
      [401, false],
      [422, false],
    ] as const) {
      const error = await answering(status)
        .send(event)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuditDeliveryError);
      expect((error as AuditDeliveryError).status).toBe(status);
      expect((error as AuditDeliveryError).retryable, String(status)).toBe(retryable);
    }
    const slow = new MementoSink({
      url: "http://m.test/memento",
      apiKey: "k",
      timeoutMs: 50,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })) as unknown as typeof fetch,
    });
    const timeout = await slow.send(event).catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(AuditDeliveryError);
    expect(timeout as AuditDeliveryError).toMatchObject({ status: null, retryable: true });
  });

  it("actorOf and fileAuditPayload", () => {
    expect(actorOf(undefined)).toBeNull();
    expect(actorOf({ userId: "u", apiKeyLabel: "vola_live…abcd" })).toEqual({
      type: "user",
      id: "u",
    });
    expect(actorOf({ userId: null, apiKeyLabel: "vola_live…abcd" })).toEqual({
      type: "api_key",
      id: "key:vola_live…abcd",
    });
    const base = {
      id: "f",
      instanceType: "tickets",
      instanceId: "i",
      folderId: null,
      slug: "avatar",
      size: 7,
      mimeType: "image/png",
      kind: "image",
      filename: "me.png",
    };
    expect(fileAuditPayload({ ...base, encryption: "none" })).toMatchObject({
      filename: "me.png",
      slug: "avatar",
    });
    expect(fileAuditPayload({ ...base, encryption: "keyring" })).not.toHaveProperty("filename");
  });
});

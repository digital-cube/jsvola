/**
 * The `keyring` provider end to end (plan 6.2): a REAL Redis (`VOLA_REDIS_URL`), a real
 * pepper file and key file in a temp dir, a lower Argon2 cost (stored per keyring, like a
 * production raise would be), a fake clock for the lock-out table, a 2-second unlock TTL for
 * the sliding tests.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Row } from "@jsudc/core";
import {
  encodeTusMetadata,
  FileInfoSchema,
  FileListSchema,
  FolderInfoSchema,
  KeyringCreatedSchema,
  KeyringDeletePreviewSchema,
  KeyringResetResultSchema,
  KeyringStatusSchema,
  RecoveredSchema,
  UnlockedSchema,
} from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AuditLog } from "../src/audit/log.js";
import type { AuditEvent } from "../src/audit/memento.js";
import { runWithTenant } from "../src/context.js";
import {
  aeadOpen,
  deriveKek,
  generateKeyLine,
  KEYRING_FK_CT_BYTES,
  KeyFile,
  kdfSalt,
  keyId,
  LOCKOUT_AT,
  mkAad,
  parseKeyFile,
  unwrapFromStore,
  unwrapMasterKey,
  wrapAad,
} from "../src/crypto/index.js";
import { files, keyrings } from "../src/db/schema.js";
import { LocalFileEventBus } from "../src/events/bus.js";
import { createEncryptionService } from "../src/services/encryption.js";
import { createTenant } from "../src/services/tenants.js";
import { UNLOCK_INDEX_PREFIX, UNLOCK_KEY_PREFIX, UnlockStore } from "../src/services/unlock.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { ENCRYPTED_FILENAME, FilesCollectionSource } from "../src/udc/files-source.js";
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

const handle = testDatabase(6);
let fx: Fixture;
let app: FastifyInstance;
/** The same database and storage, no Redis: the keyring provider does not exist there. */
let noRedis: FastifyInstance;
let redis: Redis;
let root: string;
let keyFile: string;
let pepperFile: string;
let storage: FilesystemBackend;
let events: LocalFileEventBus;
let audited: AuditEvent[];
let http: ReturnType<typeof httpClient>;
let beta: { id: string; slug: string; key: string };

const TYPE = "tickets";
const TTL_S = 2;
/** Small Argon2 cost: stored per keyring, exactly as a raise in production would be. */
const FAST = { m: 1024, t: 1, p: 1 };
const PIN = "135790";
const PIN2 = "246813";
const WRONG = "999123";
const MARKER = randomBytes(48);
const SECRET = Buffer.concat([Buffer.from("keyring secret: "), MARKER, Buffer.from("\n")]);
const TUS = { "tus-resumable": "1.0.0" };
const PATCH_TYPE = "application/offset+octet-stream";
const line0 = generateKeyLine();
const pepper0 = generateKeyLine();
let now = new Date();

beforeAll(async () => {
  expect(config.redisUrl, "VOLA_REDIS_URL is needed for the keyring suite").toBeTruthy();
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-keyrings-"));
  keyFile = join(root, "vola.key");
  pepperFile = join(root, "vola.pepper");
  await writeFile(keyFile, `${line0}\n`, { mode: 0o600 });
  await writeFile(pepperFile, `${pepper0}\n`, { mode: 0o600 });
  storage = new FilesystemBackend(join(root, "storage"));
  events = new LocalFileEventBus();
  audited = [];
  const audit = new AuditLog({
    sink: {
      async send(event) {
        audited.push(event);
      },
    },
  });
  redis = new Redis(config.redisUrl as string, { maxRetriesPerRequest: 1 });
  const cfg = {
    ...config,
    keyFile,
    pepperFile,
    unlockTtlS: TTL_S,
    storagePath: join(root, "storage"),
    maxUploadBytes: 4 * 1024 * 1024,
  };
  const unlocks = new UnlockStore({ redis, keys: new KeyFile(keyFile), ttlS: TTL_S });
  fx = await setupFixture(handle, {
    storage,
    events,
    audit,
    redis,
    unlocks,
    keyrings: { kdfCost: FAST, now: () => now },
    config: cfg,
    uploadSweepIntervalMs: 0,
  });
  app = fx.app;
  await app.ready();
  noRedis = await buildApp({
    config: cfg,
    db: handle.db,
    logger: false,
    storage,
    events: false,
    uploadSweepIntervalMs: 0,
  });
  await noRedis.ready();
  http = httpClient(app, fx.full.key, TYPE);
  const tenant = await createTenant(handle.db, { slug: "beta", name: "Beta" });
  const key = await mintKey(handle, tenant.id, "beta-full", "live", [
    "files:read",
    "files:write",
    "keyrings:write",
  ]);
  beta = { id: tenant.id, slug: tenant.slug, key: key.key };
});
afterAll(async () => {
  await app.close();
  await noRedis.close();
  await redis.quit();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  audited.length = 0;
  events.published.length = 0;
  now = new Date();
});

// --- helpers -----------------------------------------------------------------------------

const user = (id: string, extra: Record<string, string> = {}) => ({ "x-user-id": id, ...extra });
const unlockHeader = (token: string) => ({ "x-vola-unlock": token });
const KR = "/vola/keyrings/me";

const postJson = (
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  key = fx.full.key,
  method: "POST" | "PUT" | "PATCH" = "POST",
) =>
  app.inject({
    method,
    url,
    headers: { ...bearer(key), ...headers },
    payload: payload as Record<string, unknown>,
  });

async function setup(principal: string, pin = PIN, key = fx.full.key) {
  const response = await postJson(KR, { pin }, user(principal), key);
  expect(response.statusCode, response.body).toBe(201);
  return KeyringCreatedSchema.parse(response.json());
}

async function unlock(principal: string, pin = PIN, key = fx.full.key) {
  const response = await postJson(`${KR}/unlock`, { pin }, user(principal), key);
  expect(response.statusCode, response.body).toBe(200);
  return UnlockedSchema.parse(response.json());
}

async function status(principal: string, token?: string) {
  const response = await http.get(
    `${KR}/status`,
    user(principal, token ? unlockHeader(token) : {}),
  );
  expect(response.statusCode, response.body).toBe(200);
  return KeyringStatusSchema.parse(response.json());
}

/** A fresh principal with a keyring and a live token. */
async function owner(prefix = "u") {
  const principal = `${prefix}-${randomUUID().slice(0, 8)}`;
  const created = await setup(principal);
  const { token } = await unlock(principal);
  return { principal, token, keyringId: created.keyring_id, recoveryKey: created.recovery_key };
}

async function uploadKeyring(
  principal: string,
  token: string | null,
  data = SECRET,
  filename = "secret.txt",
  options: { instanceId?: string; fields?: Record<string, string>; key?: string } = {},
) {
  return http.upload(data, filename, {
    instanceId: options.instanceId,
    key: options.key,
    headers: {
      ...user(principal, token ? unlockHeader(token) : {}),
      "x-vola-encryption": "keyring",
    },
    fields: options.fields,
    fieldsFirst: true,
  });
}

async function storedFile(
  principal: string,
  token: string,
  data = SECRET,
  filename = "s.txt",
  instanceId = randomUUID(),
) {
  const { response } = await uploadKeyring(principal, token, data, filename, { instanceId });
  expect(response.statusCode, response.body).toBe(201);
  return { info: FileInfoSchema.parse(response.json()), instanceId };
}

const url = (instanceId: string, fileId: string, suffix = "") =>
  `/vola/files/${TYPE}/${instanceId}/${fileId}${suffix}`;

async function row(id: string) {
  const [found] = await handle.db.select().from(files).where(eq(files.id, id));
  return found as typeof files.$inferSelect;
}

async function keyringRow(id: string) {
  const [found] = await handle.db.select().from(keyrings).where(eq(keyrings.id, id));
  return found as typeof keyrings.$inferSelect;
}

async function udc(action: string, payload: unknown, headers: Record<string, string>) {
  const response = await app.inject({
    method: "POST",
    url: `/vola/udc/${action}`,
    headers: { ...bearer(fx.full.key), "x-udc-message-id": "m1", ...headers },
    payload: payload as Record<string, unknown>,
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { kind: string; payload: Record<string, unknown> };
  expect(body.kind, JSON.stringify(body)).toBe(`udc.${action}.ok`);
  return body.payload;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- setup and status --------------------------------------------------------------------

describe("keyring setup", () => {
  it("needs X-User-Id (400 user_required) and the keyrings:write scope", async () => {
    const anonymous = await postJson(KR, { pin: PIN }, {});
    expect(anonymous.statusCode).toBe(400);
    expect(anonymous.json().error.code).toBe("user_required");
    const readOnly = await postJson(KR, { pin: PIN }, user("x"), fx.readOnly.key);
    expect(readOnly.statusCode).toBe(403);
    expect((await http.get(`${KR}/status`)).statusCode).toBe(400);
  });

  it("refuses a bad PIN with the reason, creates once (409 afterwards) and shows the recovery key once", async () => {
    const principal = `u-${randomUUID().slice(0, 8)}`;
    for (const [pin, reason] of [
      ["12345", "length"],
      ["12345a", "digits"],
      ["123456", "trivial"],
      ["777777", "trivial"],
    ] as const) {
      const response = await postJson(KR, { pin }, user(principal));
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error).toMatchObject({ code: "pin_invalid", reason });
    }
    expect((await postJson(KR, { pin: 135790 }, user(principal))).statusCode).toBe(422);
    const before = await status(principal);
    expect(before).toMatchObject({ keyring_id: null, has_pin: false, locked: true, attempts: 0 });

    const created = await setup(principal);
    expect(created.recovery_key).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
    const again = await postJson(KR, { pin: PIN2 }, user(principal));
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("keyring_exists");

    const stored = await keyringRow(created.keyring_id);
    expect(stored.principal).toBe(principal);
    expect(stored.kdf).toMatchObject({ alg: "argon2id", m: FAST.m, t: FAST.t, p: FAST.p });
    expect(stored.kdf.pepper_line).toBe(keyId(Buffer.from(pepper0, "base64")).toString("hex"));
    expect(stored.mkPinCt).toHaveLength(60);
    expect(stored.mkRecoveryCt).toHaveLength(60);
    expect(stored.recoverySalt).toHaveLength(16);
    expect(stored.attempts).toBe(0);
    const after = await status(principal);
    expect(after).toMatchObject({
      keyring_id: created.keyring_id,
      has_pin: true,
      locked: true,
      unlock_expires_in: null,
      locked_until: null,
    });
    expect(audited.map((e) => e.event_type)).toContain("VOLA_KEYRING_CREATED");
    const event = audited.find((e) => e.event_type === "VOLA_KEYRING_CREATED") as AuditEvent;
    expect(event.instance_type).toBe("vola_keyring");
    expect(event.actor_id).toBe(principal);
    expect(JSON.stringify(event.payload)).not.toContain(PIN);
    expect(JSON.stringify(event.payload)).not.toContain(created.recovery_key);
    // Another principal of the same tenant and the same principal of another tenant each get their own.
    await setup(`${principal}-2`);
    await setup(principal, PIN, beta.key);
  });
});

// --- unlock, token, files ----------------------------------------------------------------

describe("unlock and files", () => {
  it("setup → unlock → upload → download; without the token everything is 423 vola_locked and lists stay masked", async () => {
    const { principal, token, keyringId } = await owner();
    const locked = await uploadKeyring(principal, null);
    expect(locked.response.statusCode, locked.response.body).toBe(423);
    expect(locked.response.json().error.code).toBe("vola_locked");
    expect(await readdir(storage.tmpDir).catch(() => [])).toEqual([]);
    const stale = await uploadKeyring(principal, "not-a-token");
    expect(stale.response.statusCode).toBe(423);

    const { info, instanceId } = await storedFile(principal, token, SECRET, "Plan Ž.txt");
    expect(info).toMatchObject({
      encryption: "keyring",
      keyring_id: keyringId,
      filename: "Plan Ž.txt",
      mime_type: "text/plain",
      size: SECRET.length,
    });
    const stored = await row(info.id);
    expect(stored.keyringId).toBe(keyringId);
    expect(stored.fkCt).toHaveLength(KEYRING_FK_CT_BYTES);
    expect(stored.filename).toBe(`${info.id}.bin`);
    const blob = await readFile(storage.blobPath(info.hash));
    expect(blob.includes(MARKER)).toBe(false);

    const get = await http.get(url(instanceId, info.id), user(principal, unlockHeader(token)));
    expect(get.statusCode, get.body).toBe(200);
    expect(get.rawPayload.equals(SECRET)).toBe(true);
    expect(get.headers["cache-control"]).toBe("no-store");
    expect(get.headers["content-disposition"]).toContain("attachment");
    const head = await http.head(url(instanceId, info.id), user(principal, unlockHeader(token)));
    expect(head.statusCode).toBe(200);
    const range = await http.get(url(instanceId, info.id), {
      ...user(principal, unlockHeader(token)),
      range: "bytes=16-63",
    });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.equals(MARKER)).toBe(true);

    for (const headers of [user(principal), {}, user(principal, unlockHeader("x"))]) {
      const refused = await http.get(url(instanceId, info.id), headers);
      expect(refused.statusCode, refused.body).toBe(423);
      expect(refused.json().error).toEqual({
        code: "vola_locked",
        message: expect.stringContaining("locked"),
      });
      expect((await http.head(url(instanceId, info.id), headers)).statusCode).toBe(423);
      const detail = await http.get(url(instanceId, info.id, "/info"), headers);
      expect(detail.statusCode).toBe(423);
    }
    const detail = await http.get(
      url(instanceId, info.id, "/info"),
      user(principal, unlockHeader(token)),
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ filename: "Plan Ž.txt", keyring_id: keyringId });

    // Lists: masked without the token, real with it.
    const masked = FileListSchema.parse(
      (await http.get(`/vola/files/${TYPE}/${instanceId}`, user(principal))).json(),
    );
    expect(masked.files[0]).toMatchObject({
      filename: `${info.id}.bin`,
      mime_type: "application/octet-stream",
      kind: "other",
    });
    const revealed = FileListSchema.parse(
      (
        await http.get(`/vola/files/${TYPE}/${instanceId}`, user(principal, unlockHeader(token)))
      ).json(),
    );
    expect(revealed.files[0]).toMatchObject({ filename: "Plan Ž.txt", mime_type: "text/plain" });
    const filter = {
      and: [
        { field: "instance_type", op: "eq", value: TYPE },
        { field: "instance_id", op: "eq", value: instanceId },
      ],
    };
    const rows = (await udc("list", { collection: "files", filter }, user(principal))) as {
      rows: Row[];
    };
    expect(rows.rows[0]).toMatchObject({
      filename: ENCRYPTED_FILENAME,
      mime_type: null,
      encryption: "keyring",
    });
    const open = (await udc(
      "list",
      { collection: "files", filter },
      user(principal, unlockHeader(token)),
    )) as { rows: Row[] };
    expect(open.rows[0]).toMatchObject({ filename: "Plan Ž.txt", mime_type: "text/plain" });
    const read = (await udc(
      "read",
      { collection: "files", id: info.id },
      user(principal, unlockHeader(token)),
    )) as { row: Row };
    expect(read.row).toMatchObject({ filename: "Plan Ž.txt" });
  });

  it("another principal's token, the owner's token under another principal, or another tenant: 423", async () => {
    const a = await owner("a");
    const b = await owner("b");
    const { info, instanceId } = await storedFile(a.principal, a.token);
    const cases: Record<string, string>[] = [
      user(b.principal, unlockHeader(b.token)),
      user(b.principal, unlockHeader(a.token)),
      user(a.principal, unlockHeader(b.token)),
    ];
    for (const headers of cases) {
      const response = await http.get(url(instanceId, info.id), headers);
      expect(response.statusCode, response.body).toBe(423);
      expect(response.json().error.code).toBe("vola_locked");
    }
    // b uploading into a's keyring is impossible: a token only ever names its own keyring.
    const uploaded = await uploadKeyring(b.principal, b.token, SECRET, "b.txt", { instanceId });
    expect(uploaded.response.statusCode).toBe(201);
    expect(uploaded.response.json().keyring_id).toBe(b.keyringId);
    // The same principal id in another tenant has its own keyring; a's token is noise there.
    const betaHttp = httpClient(app, beta.key, TYPE);
    const other = await betaHttp.get(
      url(instanceId, info.id),
      user(a.principal, unlockHeader(a.token)),
    );
    expect(other.statusCode).toBe(404);
  });

  it("a subscription reveals a keyring row only under the owner's token", async () => {
    const { principal, token } = await owner();
    const instanceId = randomUUID();
    const source = new FilesCollectionSource({
      db: handle.db,
      prefix: "/vola",
      events,
      crypto: createEncryptionService({
        db: handle.db,
        keyFile,
        unlocks: new UnlockStore({ redis, keys: new KeyFile(keyFile), ttlS: TTL_S }),
      }),
    });
    const tenant = (unlockToken: string | null) => ({
      tenantId: fx.tenant.id,
      tenantSlug: fx.tenant.slug,
      apiKeyId: fx.full.apiKey.id,
      apiKeyLabel: "vola_live…test",
      scopes: ["files:read"] as const,
      isAdmin: false,
      userId: principal,
      unlockToken,
    });
    const filter = {
      and: [
        { field: "instance_type", op: "eq" as const, value: TYPE },
        { field: "instance_id", op: "eq" as const, value: instanceId },
      ],
    };
    const seen: { with: Row[]; without: Row[] } = { with: [], without: [] };
    const withToken = await runWithTenant(tenant(token), () =>
      source.subscribe(filter, {
        upsert: (r) => seen.with.push(r),
        remove: () => {},
      }),
    );
    const withoutToken = await runWithTenant(tenant(null), () =>
      source.subscribe(filter, {
        upsert: (r) => seen.without.push(r),
        remove: () => {},
      }),
    );
    try {
      const { info } = await storedFile(principal, token, SECRET, "live.txt", instanceId);
      await source.idle();
      expect(seen.with.map((r) => [r.id, r.filename])).toEqual([[info.id, "live.txt"]]);
      expect(seen.without.map((r) => [r.id, r.filename])).toEqual([[info.id, ENCRYPTED_FILENAME]]);
    } finally {
      await withToken.close();
      await withoutToken.close();
    }
  });

  it("a keyring file cannot be shared, made globally public, transferred or thumbnailed", async () => {
    const { principal, token } = await owner();
    const { info, instanceId } = await storedFile(principal, token);
    const share = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(fx.full.key),
      payload: { file_id: info.id },
    });
    expect(share.statusCode).toBe(409);
    expect(share.json().error.code).toBe("encrypted_share_requires_grant");
    const pub = await http.patch(url(instanceId, info.id), { is_global_public: true });
    expect(pub.statusCode).toBe(409);
    const transfer = await app.inject({
      method: "POST",
      url: "/vola/admin/transfer",
      headers: bearer(fx.admin.key),
      payload: {
        from_tenant: fx.tenant.slug,
        to_tenant: beta.slug,
        instances: [{ instance_type: TYPE, instance_id: instanceId }],
      },
    });
    expect(transfer.statusCode, transfer.body).toBe(409);
    expect(transfer.json().error.code).toBe("encrypted_transfer_unsupported");
    expect((await http.get(url(instanceId, info.id, "/thumb/256"))).statusCode).toBe(404);
    // A rename re-seals the metadata — only with the token.
    const rename = await postJson(
      url(instanceId, info.id),
      { filename: "new.txt" },
      user(principal),
      fx.full.key,
      "PATCH",
    );
    expect(rename.statusCode).toBe(423);
    const renamed = await postJson(
      url(instanceId, info.id),
      { filename: "new.txt" },
      user(principal, unlockHeader(token)),
      fx.full.key,
      "PATCH",
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().filename).toBe("new.txt");
  });
});

// --- the token --------------------------------------------------------------------------

describe("the unlock token", () => {
  it("slides its TTL on every request that carries it, expires without one, and /status does not slide", async () => {
    const { principal, token } = await owner();
    const { info, instanceId } = await storedFile(principal, token);
    const key = UNLOCK_KEY_PREFIX + token;
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    await redis.expire(key, 1);
    const seen = await status(principal, token);
    expect(seen.locked).toBe(false);
    expect(seen.unlock_expires_in).toBeLessThanOrEqual(1);
    expect(await redis.ttl(key)).toBeLessThanOrEqual(1); // status did not slide
    const get = await http.get(url(instanceId, info.id), user(principal, unlockHeader(token)));
    expect(get.statusCode).toBe(200);
    expect(await redis.ttl(key)).toBe(TTL_S); // a real request did
    await sleep(1200);
    expect(
      (await http.get(url(instanceId, info.id), user(principal, unlockHeader(token)))).statusCode,
    ).toBe(200);
    await sleep(1200);
    // 2.4 s since the unlock would have been past the TTL: it lives because it was used.
    expect(
      (await http.get(url(instanceId, info.id), user(principal, unlockHeader(token)))).statusCode,
    ).toBe(200);
    await sleep(TTL_S * 1000 + 300);
    const expired = await http.get(url(instanceId, info.id), user(principal, unlockHeader(token)));
    expect(expired.statusCode).toBe(423);
    expect((await status(principal, token)).locked).toBe(true);
    expect(await redis.get(key)).toBeNull();
  });

  it("DELETE /unlock and the beacon alias (no API key, JSON or text/plain) end it; both idempotent", async () => {
    const { principal, token } = await owner();
    const index = `${UNLOCK_INDEX_PREFIX}${fx.tenant.id}:${principal}`;
    expect(await redis.smembers(index)).toEqual([token]);
    const closed = await http.del(`${KR}/unlock`, user(principal, unlockHeader(token)));
    expect(closed.statusCode).toBe(204);
    expect(await redis.get(UNLOCK_KEY_PREFIX + token)).toBeNull();
    expect(await redis.smembers(index)).toEqual([]);
    expect((await http.del(`${KR}/unlock`, user(principal, unlockHeader(token)))).statusCode).toBe(
      204,
    );
    expect((await http.del(`${KR}/unlock`, user(principal))).statusCode).toBe(204);

    const second = await unlock(principal);
    const beacon = await app.inject({
      method: "POST",
      url: `${KR}/unlock/close`,
      payload: { token: second.token },
    });
    expect(beacon.statusCode, beacon.body).toBe(204);
    expect((await status(principal, second.token)).locked).toBe(true);
    const third = await unlock(principal);
    const text = await app.inject({
      method: "POST",
      url: `${KR}/unlock/close`,
      headers: { "content-type": "text/plain" },
      payload: third.token,
    });
    expect(text.statusCode, text.body).toBe(204);
    expect(await redis.get(UNLOCK_KEY_PREFIX + third.token)).toBeNull();
    expect(
      (await app.inject({ method: "POST", url: `${KR}/unlock/close`, payload: {} })).statusCode,
    ).toBe(422);
  });

  it("the Redis entry holds the master key only wrapped under the key file", async () => {
    const { principal, token } = await owner();
    const raw = await redis.get(UNLOCK_KEY_PREFIX + token);
    const entry = JSON.parse(raw as string) as Record<string, string>;
    expect(entry).toMatchObject({ tenant_id: fx.tenant.id, principal });
    const sealed = Buffer.from(entry.mk as string, "base64");
    const lines = parseKeyFile(line0);
    const mk = unwrapFromStore(lines, sealed, fx.tenant.id, Buffer.from(token));
    expect(mk).toHaveLength(32);
    expect(() =>
      unwrapFromStore(parseKeyFile(generateKeyLine()), sealed, fx.tenant.id, Buffer.from(token)),
    ).toThrow();
    expect(raw).not.toContain(mk.toString("base64"));
    expect(raw).not.toContain(mk.toString("hex"));
  });
});

// --- PIN change, recovery ----------------------------------------------------------------

describe("PIN change and recovery", () => {
  it("re-wraps only the master key: fk_ct and the blob stay, the old token and PIN die, the new PIN reads the file", async () => {
    const { principal, token, keyringId } = await owner();
    const { info, instanceId } = await storedFile(principal, token);
    const before = await row(info.id);
    const blobBefore = await readFile(storage.blobPath(info.hash));
    const krBefore = await keyringRow(keyringId);

    const wrong = await postJson(
      `${KR}/pin`,
      { current_pin: WRONG, new_pin: PIN2 },
      user(principal),
      fx.full.key,
      "PUT",
    );
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error).toMatchObject({ code: "pin_wrong", attempts: 1 });
    const trivial = await postJson(
      `${KR}/pin`,
      { current_pin: PIN, new_pin: "111111" },
      user(principal),
      fx.full.key,
      "PUT",
    );
    expect(trivial.statusCode).toBe(422);
    const changed = await postJson(
      `${KR}/pin`,
      { current_pin: PIN, new_pin: PIN2 },
      user(principal),
      fx.full.key,
      "PUT",
    );
    expect(changed.statusCode, changed.body).toBe(204);

    const after = await row(info.id);
    expect(after.fkCt?.equals(before.fkCt as Buffer)).toBe(true);
    expect(after.metaCt?.equals(before.metaCt as Buffer)).toBe(true);
    expect((await readFile(storage.blobPath(info.hash))).equals(blobBefore)).toBe(true);
    const krAfter = await keyringRow(keyringId);
    expect(krAfter.mkPinCt.equals(krBefore.mkPinCt)).toBe(false);
    expect(krAfter.kdf.salt).not.toBe(krBefore.kdf.salt);
    expect(krAfter.mkRecoveryCt.equals(krBefore.mkRecoveryCt)).toBe(true);
    expect(krAfter.attempts).toBe(0);

    expect(
      (await http.get(url(instanceId, info.id), user(principal, unlockHeader(token)))).statusCode,
    ).toBe(423);
    const old = await postJson(`${KR}/unlock`, { pin: PIN }, user(principal));
    expect(old.statusCode).toBe(403);
    const fresh = await unlock(principal, PIN2);
    const get = await http.get(
      url(instanceId, info.id),
      user(principal, unlockHeader(fresh.token)),
    );
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(SECRET)).toBe(true);
    expect(audited.map((e) => e.event_type)).toContain("VOLA_KEYRING_PIN_CHANGED");
  });

  it("recovery: a wrong key is 403 and never counts; the right one sets a new PIN, issues a new key and drops every token", async () => {
    const { principal, token, keyringId, recoveryKey } = await owner();
    const { info, instanceId } = await storedFile(principal, token);
    const typo = `${recoveryKey.slice(0, -1)}${recoveryKey.endsWith("A") ? "B" : "A"}`;
    for (const key of [typo, "nonsense", ""]) {
      const wrong = await postJson(
        `${KR}/recover`,
        { recovery_key: key, new_pin: PIN2 },
        user(principal),
      );
      expect(wrong.statusCode, wrong.body).toBe(key === "" ? 422 : 403);
      if (key !== "") expect(wrong.json().error.code).toBe("recovery_wrong");
    }
    expect((await keyringRow(keyringId)).attempts).toBe(0);
    expect((await status(principal, token)).locked).toBe(false);

    // Typed sloppily: lower case, spaces, 0 for O and 1 for I.
    const typed = recoveryKey
      .toLowerCase()
      .replace(/-/g, " ")
      .replace(/o/g, "0")
      .replace(/i/g, "1");
    const recovered = await postJson(
      `${KR}/recover`,
      { recovery_key: typed, new_pin: PIN2 },
      user(principal),
    );
    expect(recovered.statusCode, recovered.body).toBe(200);
    const result = RecoveredSchema.parse(recovered.json());
    expect(result.recovery_key).not.toBe(recoveryKey);
    expect(result.recovery_key).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
    expect((await status(principal, token)).locked).toBe(true);
    expect((await postJson(`${KR}/unlock`, { pin: PIN }, user(principal))).statusCode).toBe(403);
    const fresh = await unlock(principal, PIN2);
    const get = await http.get(
      url(instanceId, info.id),
      user(principal, unlockHeader(fresh.token)),
    );
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(SECRET)).toBe(true);
    // The old recovery key is retired; the new one works once more.
    const retired = await postJson(
      `${KR}/recover`,
      { recovery_key: recoveryKey, new_pin: PIN },
      user(principal),
    );
    expect(retired.statusCode).toBe(403);
    const again = await postJson(
      `${KR}/recover`,
      { recovery_key: result.recovery_key, new_pin: PIN },
      user(principal),
    );
    expect(again.statusCode).toBe(200);
    expect(audited.filter((e) => e.event_type === "VOLA_KEYRING_RECOVERED")).toHaveLength(2);
    for (const event of audited) {
      expect(JSON.stringify(event)).not.toContain(recoveryKey);
      expect(JSON.stringify(event)).not.toContain(result.recovery_key);
    }
  });

  it("pepper rotation: a prepended line takes over at the next unlock; recovery still works", async () => {
    const { principal, keyringId, recoveryKey } = await owner();
    const pepper1 = generateKeyLine();
    await writeFile(pepperFile, `${pepper1}\n${pepper0}\n`, { mode: 0o600 });
    await utimes(pepperFile, new Date(), new Date(Date.now() + 5000));
    try {
      const before = await keyringRow(keyringId);
      expect(before.kdf.pepper_line).toBe(keyId(Buffer.from(pepper0, "base64")).toString("hex"));
      await unlock(principal);
      const after = await keyringRow(keyringId);
      expect(after.kdf.pepper_line).toBe(keyId(Buffer.from(pepper1, "base64")).toString("hex"));
      expect(after.mkPinCt.equals(before.mkPinCt)).toBe(false);
      await unlock(principal); // and again, under the new line
      const recovered = await postJson(
        `${KR}/recover`,
        { recovery_key: recoveryKey, new_pin: PIN2 },
        user(principal),
      );
      expect(recovered.statusCode, recovered.body).toBe(200);
      await unlock(principal, PIN2);
      // Without the old line the recovery wrap of a keyring made under it is gone: pepper-status warns.
    } finally {
      await writeFile(pepperFile, `${pepper0}\n`, { mode: 0o600 });
      await utimes(pepperFile, new Date(), new Date(Date.now() + 10_000));
    }
  });
});

// --- brute force -------------------------------------------------------------------------

describe("brute force", () => {
  it("follows the table (fake clock), refuses the right PIN during a lock-out (429 + Retry-After), resets on success", async () => {
    const { principal, keyringId } = await owner();
    const attempt = (pin: string) => postJson(`${KR}/unlock`, { pin }, user(principal));
    const expectWrong = async (attempts: number, retryAfter: number) => {
      const response = await attempt(WRONG);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error).toMatchObject({
        code: "pin_wrong",
        attempts,
        retry_after: retryAfter,
      });
    };
    await expectWrong(1, 0);
    await expectWrong(2, 0);
    await expectWrong(3, 1);
    // Locked for 1 s: the right PIN is refused too, with Retry-After.
    const refused = await attempt(PIN);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("1");
    expect(refused.json().error.code).toBe("too_many_attempts");
    expect((await status(principal)).locked_until).not.toBeNull();
    now = new Date(now.getTime() + 1500);
    await expectWrong(4, 5);
    now = new Date(now.getTime() + 5500);
    for (let n = 5; n <= 9; n++) {
      await expectWrong(n, 30);
      now = new Date(now.getTime() + 30_500);
    }
    await expectWrong(10, 3600);
    expect(audited.map((e) => e.event_type)).toContain("VOLA_KEYRING_LOCKED_OUT");
    expect((await keyringRow(keyringId)).attempts).toBe(LOCKOUT_AT);
    const hour = await attempt(PIN);
    expect(hour.statusCode).toBe(429);
    expect(Number(hour.headers["retry-after"])).toBeGreaterThan(3000);
    now = new Date(now.getTime() + 3601_000);
    await expectWrong(11, 7200);
    now = new Date(now.getTime() + 7201_000);
    // The right PIN clears everything.
    const ok = await attempt(PIN);
    expect(ok.statusCode, ok.body).toBe(200);
    const after = await keyringRow(keyringId);
    expect(after.attempts).toBe(0);
    expect(after.lockedUntil).toBeNull();
    const state = await status(principal);
    expect(state).toMatchObject({ attempts: 0, locked_until: null });
    // The counter survives a "restart": it is in the row, not in memory.
    await expectWrong(1, 0);
    expect((await keyringRow(keyringId)).attempts).toBe(1);
  });

  it("one attempt per principal at a time: parallel guesses do not all read attempts = 0", async () => {
    const { principal, keyringId } = await owner();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => postJson(`${KR}/unlock`, { pin: WRONG }, user(principal))),
    );
    const codes = responses.map((r) => r.statusCode).sort();
    expect(codes.every((c) => c === 403 || c === 429)).toBe(true);
    const counted = codes.filter((c) => c === 403).length;
    expect(counted).toBeGreaterThanOrEqual(1);
    expect((await keyringRow(keyringId)).attempts).toBe(counted);
    for (const r of responses.filter((r) => r.statusCode === 429)) {
      expect(r.json().error).toMatchObject({ code: "too_many_attempts", retry_after: 1 });
    }
  });
});

// --- reset -------------------------------------------------------------------------------

describe("reset", () => {
  it("previews the counts, then crypto-shreds every file (blobs off the disk, rows gone) and the keyring", async () => {
    const { principal, token, keyringId } = await owner();
    const a = await storedFile(principal, token, SECRET, "a.txt");
    const b = await storedFile(principal, token, Buffer.from("second"), "b.txt");
    await http.del(url(b.instanceId, b.info.id), user(principal)); // soft-deleted rows go too
    const plain = await http.upload(Buffer.from("plain"), "plain.txt", {
      instanceId: a.instanceId,
    });
    expect(plain.response.statusCode).toBe(201);

    const preview = KeyringDeletePreviewSchema.parse(
      (await http.get(`${KR}/delete-preview`, user(principal))).json(),
    );
    expect(preview).toEqual({
      keyring_id: keyringId,
      files: 2,
      live_files: 1,
      bytes: SECRET.length + 6,
    });
    expect((await postJson(`${KR}/reset`, {}, user(principal))).statusCode).toBe(422);
    expect((await postJson(`${KR}/reset`, { confirm: "yes" }, user(principal))).statusCode).toBe(
      422,
    );

    const reset = await postJson(`${KR}/reset`, { confirm: "RESET" }, user(principal));
    expect(reset.statusCode, reset.body).toBe(200);
    expect(KeyringResetResultSchema.parse(reset.json())).toEqual({
      keyring_id: keyringId,
      files: 2,
      blobs: 2,
    });
    expect(await stat(storage.blobPath(a.info.hash)).catch(() => null)).toBeNull();
    expect(await stat(storage.blobPath(b.info.hash)).catch(() => null)).toBeNull();
    expect(await row(a.info.id)).toBeUndefined();
    expect(await row(b.info.id)).toBeUndefined();
    expect((await row(plain.response.json().id)).deletedAt).toBeNull();
    expect((await keyringRow(keyringId)).deletedAt).not.toBeNull();
    expect(await redis.get(UNLOCK_KEY_PREFIX + token)).toBeNull();
    expect(await status(principal, token)).toMatchObject({ has_pin: false, keyring_id: null });
    expect(
      events.published
        .filter((e) => e.kind === "purged")
        .map((e) => e.fileId)
        .sort(),
    ).toEqual([a.info.id, b.info.id].sort());
    expect(audited.find((e) => e.event_type === "VOLA_KEYRING_RESET")?.payload).toMatchObject({
      keyring_id: keyringId,
      files: 2,
      blobs: 2,
    });
    // A fresh setup is a new keyring with a new master key.
    const created = await setup(principal);
    expect(created.keyring_id).not.toBe(keyringId);
    expect((await http.get(`${KR}/delete-preview`, user(principal))).json().files).toBe(0);
  });

  it("an admin may read the status of and reset another principal, never unlock; a tenant key may not", async () => {
    const { principal, keyringId } = await owner();
    const path = `/vola/keyrings/by-principal/${encodeURIComponent(principal)}`;
    const admin = { ...bearer(fx.admin.key), "x-tenant-slug": fx.tenant.slug };
    const seen = await app.inject({ method: "GET", url: `${path}/status`, headers: admin });
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json()).toMatchObject({ keyring_id: keyringId, has_pin: true, locked: true });
    const forbidden = await app.inject({
      method: "GET",
      url: `${path}/status`,
      headers: bearer(fx.full.key),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${path}/unlock`,
          headers: admin,
          payload: { pin: PIN },
        })
      ).statusCode,
    ).toBe(404);
    const reset = await app.inject({
      method: "POST",
      url: `${path}/reset`,
      headers: admin,
      payload: { confirm: "RESET" },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json()).toMatchObject({ keyring_id: keyringId, files: 0 });
    expect(
      (await app.inject({ method: "GET", url: `${path}/status`, headers: admin })).json().has_pin,
    ).toBe(false);
  });
});

// --- folder policy -----------------------------------------------------------------------

describe("encrypted folder (policy)", () => {
  const folderUrl = (instanceId: string, path: string) =>
    `/vola/folders/${TYPE}/${instanceId}/${path}`;

  it('PATCH {default_keyring: "me"} makes every upload into the folder and below a keyring one', async () => {
    const { principal, token, keyringId } = await owner();
    const instanceId = randomUUID();
    const nobody = await postJson(
      folderUrl(instanceId, "vault"),
      { default_keyring: "me" },
      user("stranger"),
      fx.full.key,
      "PATCH",
    );
    expect(nobody.statusCode).toBe(404); // no folder yet
    expect((await http.post(folderUrl(instanceId, "vault/inner"))).statusCode).toBe(201);
    const noKeyring = await postJson(
      folderUrl(instanceId, "vault"),
      { default_keyring: "me" },
      user("stranger"),
      fx.full.key,
      "PATCH",
    );
    expect(noKeyring.statusCode).toBe(404);
    expect(noKeyring.json().error.code).toBe("keyring_not_found");
    const set = await postJson(
      folderUrl(instanceId, "vault"),
      { default_keyring: "me" },
      user(principal),
      fx.full.key,
      "PATCH",
    );
    expect(set.statusCode, set.body).toBe(200);
    expect(FolderInfoSchema.parse(set.json()).default_keyring_id).toBe(keyringId);

    // Plain upload fields, no mode named: the folder decides. Without the token: 423.
    const locked = await http.upload(SECRET, "doc.txt", {
      instanceId,
      fields: { folder_path: "vault/inner" },
      fieldsFirst: true,
      headers: user(principal),
    });
    expect(locked.response.statusCode, locked.response.body).toBe(423);
    const stored = await http.upload(SECRET, "doc.txt", {
      instanceId,
      fields: { folder_path: "vault/inner" },
      fieldsFirst: true,
      headers: user(principal, unlockHeader(token)),
    });
    expect(stored.response.statusCode, stored.response.body).toBe(201);
    expect(stored.response.json()).toMatchObject({ encryption: "keyring", keyring_id: keyringId });
    const byId = await http.upload(SECRET, "doc2.txt", {
      instanceId,
      fields: { folder_id: set.json().id },
      fieldsFirst: true,
      headers: user(principal, unlockHeader(token)),
    });
    expect(byId.response.statusCode, byId.response.body).toBe(201);
    expect(byId.response.json().encryption).toBe("keyring");
    // Another principal's token is not this folder's keyring.
    const other = await owner("o");
    const foreign = await http.upload(SECRET, "x.txt", {
      instanceId,
      fields: { folder_path: "vault" },
      fieldsFirst: true,
      headers: user(other.principal, unlockHeader(other.token)),
    });
    expect(foreign.response.statusCode).toBe(423);
    // An explicit other mode is refused; the folder named after the file part is refused.
    const explicit = await http.upload(SECRET, "x.txt", {
      instanceId,
      fields: { folder_path: "vault", encryption: "none" },
      fieldsFirst: true,
      headers: user(principal, unlockHeader(token)),
    });
    expect(explicit.response.statusCode).toBe(422);
    const late = await http.upload(SECRET, "x.txt", {
      instanceId,
      fields: { folder_path: "vault" },
      headers: user(principal, unlockHeader(token)),
    });
    expect(late.response.statusCode).toBe(422);
    expect(late.response.json().error.message).toContain("before the file part");
    expect(await readdir(storage.tmpDir)).toEqual([]);
    // A version of a file in the folder inherits the policy through its parent.
    const version = await http.upload(Buffer.from("v2"), "doc.txt", {
      instanceId,
      fields: { parent_id: stored.response.json().id },
      fieldsFirst: true,
      headers: user(principal, unlockHeader(token)),
    });
    expect(version.response.statusCode, version.response.body).toBe(201);
    expect(version.response.json().encryption).toBe("keyring");
    // Moving a file does not touch its crypto; a plain file moved in stays plain.
    const plain = await http.upload(Buffer.from("plain"), "plain.txt", { instanceId });
    const moved = await http.patch(url(instanceId, plain.response.json().id), {
      folder_path: "vault",
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().encryption).toBe("none");
    // Cleared: uploads are plain again; a listing shows the policy column.
    const cleared = await postJson(
      folderUrl(instanceId, "vault"),
      { default_keyring: null },
      user(principal),
      fx.full.key,
      "PATCH",
    );
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().default_keyring_id).toBeNull();
    const free = await http.upload(Buffer.from("free"), "free.txt", {
      instanceId,
      fields: { folder_path: "vault/inner" },
      fieldsFirst: true,
    });
    expect(free.response.json().encryption).toBe("none");
  });

  it("a resumable upload into a policy folder is a keyring file at completion", async () => {
    const { principal, token, keyringId } = await owner();
    const instanceId = randomUUID();
    expect((await http.post(folderUrl(instanceId, "safe"))).statusCode).toBe(201);
    await postJson(
      folderUrl(instanceId, "safe"),
      { default_keyring: "me" },
      user(principal),
      fx.full.key,
      "PATCH",
    );
    const headers = (extra: Record<string, string>) => ({
      ...bearer(fx.full.key),
      ...TUS,
      ...extra,
    });
    const meta = encodeTusMetadata({
      instance_type: TYPE,
      instance_id: instanceId,
      filename: "resumed.txt",
      folder_path: "safe/sub",
    });
    const locked = await app.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: headers({
        "upload-length": String(SECRET.length),
        "upload-metadata": meta,
        ...user(principal),
      }),
    });
    expect(locked.statusCode, locked.body).toBe(423);
    const created = await app.inject({
      method: "POST",
      url: "/vola/uploads",
      headers: headers({
        "upload-length": String(SECRET.length),
        "upload-metadata": meta,
        ...user(principal, unlockHeader(token)),
      }),
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.headers.location as string).split("/").pop() as string;
    const withoutToken = await app.inject({
      method: "PATCH",
      url: `/vola/uploads/${id}`,
      headers: headers({ "content-type": PATCH_TYPE, "upload-offset": "0", ...user(principal) }),
      payload: SECRET,
    });
    expect(withoutToken.statusCode, withoutToken.body).toBe(423);
    const patch = await app.inject({
      method: "PATCH",
      url: `/vola/uploads/${id}`,
      headers: headers({
        "content-type": PATCH_TYPE,
        "upload-offset": "0",
        ...user(principal, unlockHeader(token)),
      }),
      payload: SECRET,
    });
    expect(patch.statusCode, patch.body).toBe(204);
    const fileId = patch.headers["vola-file-id"] as string;
    const stored = await row(fileId);
    expect(stored.encryption).toBe("keyring");
    expect(stored.keyringId).toBe(keyringId);
    const get = await http.get(url(instanceId, fileId), user(principal, unlockHeader(token)));
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(SECRET)).toBe(true);
  });
});

// --- availability ------------------------------------------------------------------------

describe("without Redis", () => {
  it("every keyring route and every keyring file is 503 encryption_unavailable; plain files work", async () => {
    const { principal, token } = await owner();
    const { info, instanceId } = await storedFile(principal, token);
    const offline = httpClient(noRedis, fx.full.key, TYPE);
    for (const [method, path, body] of [
      ["GET", `${KR}/status`, undefined],
      ["POST", KR, { pin: PIN }],
      ["POST", `${KR}/unlock`, { pin: PIN }],
      ["PUT", `${KR}/pin`, { current_pin: PIN, new_pin: PIN2 }],
      ["POST", `${KR}/recover`, { recovery_key: "x", new_pin: PIN2 }],
      ["POST", `${KR}/reset`, { confirm: "RESET" }],
    ] as const) {
      const response = await noRedis.inject({
        method,
        url: path,
        headers: { ...bearer(fx.full.key), ...user(principal) },
        payload: body as Record<string, unknown> | undefined,
      });
      expect(response.statusCode, `${method} ${path}: ${response.body}`).toBe(503);
      expect(response.json().error.code).toBe("encryption_unavailable");
    }
    const get = await offline.get(url(instanceId, info.id), user(principal, unlockHeader(token)));
    expect(get.statusCode).toBe(503);
    const upload = await offline.upload(SECRET, "x.txt", {
      headers: { ...user(principal, unlockHeader(token)), "x-vola-encryption": "keyring" },
    });
    expect(upload.response.statusCode).toBe(503);
    expect((await offline.upload(Buffer.from("ok"), "ok.txt")).response.statusCode).toBe(201);
  });
});

// --- the dump ----------------------------------------------------------------------------

describe("what a dump reveals", () => {
  it("the database and Redis hold neither the master key nor a file key in the clear; without the pepper or key file nothing opens", async () => {
    const { principal, token, keyringId } = await owner();
    const { info } = await storedFile(principal, token);
    // Re-derive the master key the honest way (the PIN, the pepper, the stored kdf).
    const kr = await keyringRow(keyringId);
    const pepper = Buffer.from(pepper0, "base64");
    const kek = await deriveKek(PIN, kdfSalt(kr.kdf), pepper, kr.kdf);
    const mk = unwrapMasterKey(kek, kr.mkPinCt, mkAad(keyringId, "pin"));
    const file = await row(info.id);
    const fk = aeadOpen(mk, file.fkCt as Buffer, wrapAad("keyring", info.id, keyringId));
    expect(fk).toHaveLength(32);

    const secrets = [mk, fk, Buffer.from(PIN)];
    const columns = [
      kr.mkPinCt,
      kr.mkRecoveryCt,
      kr.recoverySalt,
      file.fkCt as Buffer,
      file.metaCt as Buffer,
      Buffer.from(JSON.stringify(kr.kdf)),
    ];
    const blob = await readFile(storage.blobPath(info.hash));
    const redisDump = Buffer.from(
      JSON.stringify([
        await redis.get(UNLOCK_KEY_PREFIX + token),
        await redis.smembers(`${UNLOCK_INDEX_PREFIX}${fx.tenant.id}:${principal}`),
      ]),
    );
    for (const secret of secrets) {
      for (const haystack of [...columns, blob, redisDump]) {
        expect(haystack.includes(secret)).toBe(false);
        expect(haystack.includes(Buffer.from(secret.toString("base64")))).toBe(false);
        expect(haystack.includes(Buffer.from(secret.toString("hex")))).toBe(false);
      }
    }
    expect(blob.includes(MARKER)).toBe(false);
    expect(JSON.stringify(kr.kdf)).not.toContain(pepper0);
    // A wrong pepper (a dump without the pepper file) opens nothing, however right the PIN.
    const wrongPepper = await deriveKek(PIN, kdfSalt(kr.kdf), randomBytes(32), kr.kdf);
    expect(() => unwrapMasterKey(wrongPepper, kr.mkPinCt, mkAad(keyringId, "pin"))).toThrow();
    // The Redis entry without the key file opens nothing either.
    const entry = JSON.parse((await redis.get(UNLOCK_KEY_PREFIX + token)) as string) as {
      mk: string;
    };
    expect(() =>
      unwrapFromStore(
        parseKeyFile(generateKeyLine()),
        Buffer.from(entry.mk, "base64"),
        fx.tenant.id,
        Buffer.from(token),
      ),
    ).toThrow();
  });
});

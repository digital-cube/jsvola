import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCESS_TOKEN_ENCRYPTION_UNSUPPORTED_CODE,
  AccessTokenCreatedSchema,
  type FileInfo,
  FileInfoSchema,
  ShareCreatedSchema,
} from "@vol-a/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AuditLog } from "../src/audit/log.js";
import type { AuditEvent } from "../src/audit/memento.js";
import { generateKeyLine } from "../src/crypto/index.js";
import { accessTokens, apiKeys, files } from "../src/db/schema.js";
import { pruneExpiredAccessTokens } from "../src/services/access-tokens.js";
import { createTenant } from "../src/services/tenants.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { pngFixture, waitFor } from "./fixtures.js";
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
/** The same database and storage with `VOLA_AUDIT_DOWNLOADS` off. */
let quiet: FastifyInstance;
let root: string;
let storage: FilesystemBackend;
let audit: AuditLog;
let audited: AuditEvent[];
let quietAudited: AuditEvent[];
let quietAudit: AuditLog;
let http: ReturnType<typeof httpClient>;
/** A key with `access:grant` (and files, keys). */
let grantKey: string;
let beta: { id: string; key: string };

const T = "mail";
const PRINCIPAL = "user-a@example.com";
const CONTENT = Buffer.from("one photo, sent to five addresses\n".repeat(20));

const recording = (into: AuditEvent[]) =>
  new AuditLog({
    sink: {
      async send(event) {
        into.push(event);
      },
    },
  });

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-access-tokens-"));
  const keyFile = join(root, "vola.key");
  await writeFile(keyFile, `${generateKeyLine()}\n`, { mode: 0o600 });
  storage = new FilesystemBackend(join(root, "storage"));
  audited = [];
  quietAudited = [];
  audit = recording(audited);
  quietAudit = recording(quietAudited);
  const cfg = { ...config, keyFile, storagePath: join(root, "storage") };
  fx = await setupFixture(handle, {
    storage,
    events: false,
    audit,
    config: { ...cfg, auditDownloads: true, accessTokenMaxTtlS: 3600 },
    uploadSweepIntervalMs: 0,
  });
  app = fx.app;
  await app.ready();
  quiet = await buildApp({
    config: { ...cfg, auditDownloads: false },
    db: handle.db,
    logger: false,
    storage,
    events: false,
    audit: quietAudit,
    uploadSweepIntervalMs: 0,
  });
  await quiet.ready();
  grantKey = (
    await mintKey(handle, fx.tenant.id, "grant", "live", [
      "files:read",
      "files:write",
      "keys:write",
      "shares:write",
      "access:grant",
    ])
  ).key;
  http = httpClient(app, grantKey, T);
  const tenant = await createTenant(handle.db, { slug: "beta", name: "Beta" });
  const key = await mintKey(handle, tenant.id, "beta", "live", [
    "files:read",
    "files:write",
    "access:grant",
  ]);
  beta = { id: tenant.id, key: key.key };
});

afterAll(async () => {
  await app.close();
  await quiet.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await audit.close();
  audited.length = 0;
  quietAudited.length = 0;
});

async function upload(
  data: Buffer = CONTENT,
  options: {
    instanceId?: string;
    key?: string;
    headers?: Record<string, string>;
    name?: string;
  } = {},
): Promise<FileInfo> {
  const { response } = await http.upload(data, options.name ?? "photo.txt", {
    instanceId: options.instanceId,
    key: options.key,
    headers: options.headers,
    contentType: options.name?.endsWith(".png") ? "image/png" : "text/plain",
  });
  expect(response.statusCode, response.body).toBe(201);
  return FileInfoSchema.parse(response.json());
}

function issue(body: unknown, key = grantKey): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/vola/access-tokens",
    headers: bearer(key),
    payload: body as Record<string, unknown>,
  });
}

async function tokenFor(body: Record<string, unknown>): Promise<{ id: string; token: string }> {
  const response = await issue({ principal: PRINCIPAL, ...body });
  expect(response.statusCode, response.body).toBe(201);
  return AccessTokenCreatedSchema.parse(response.json());
}

const fileUrl = (f: Pick<FileInfo, "instance_type" | "instance_id" | "id">) =>
  `/vola/files/${f.instance_type}/${f.instance_id}/${f.id}`;

const get = (
  url: string,
  token: string,
  headers: Record<string, string> = {},
  method: "GET" | "HEAD" = "GET",
) => app.inject({ method, url, headers: { ...bearer(token), ...headers } });

const flush = () => audit.close();

describe("the same content in six rows", () => {
  it("is one blob and six rows, and a token for one row reads that row alone", async () => {
    const data = randomBytes(4096);
    const rows: FileInfo[] = [];
    for (let i = 0; i < 6; i++) rows.push(await upload(data));
    expect(new Set(rows.map((r) => r.hash)).size).toBe(1);
    expect(new Set(rows.map((r) => r.id)).size).toBe(6);
    expect(new Set(rows.map((r) => r.instance_id)).size).toBe(6);
    const hash = rows[0]?.hash as string;
    const sameHash = await handle.db
      .select({ id: files.id })
      .from(files)
      .where(eq(files.hash, hash));
    expect(sameHash).toHaveLength(6);
    expect(await storage.stat(hash)).not.toBeNull();

    const [a, ...others] = rows as [FileInfo, ...FileInfo[]];
    const { token } = await tokenFor({ file_ids: [a.id] });
    const ok = await get(fileUrl(a), token);
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.equals(data)).toBe(true);
    for (const other of others) {
      const refused = await get(fileUrl(other), token);
      expect(refused.statusCode).toBe(404);
      expect(refused.json().error.code).toBe("file_not_found");
    }
  });
});

describe("a token for rows", () => {
  it("reads its row and that row's thumbnail; a row of the same blob and thumbnail is 404", async () => {
    const png = await pngFixture();
    const a = await upload(png, { name: "a.png" });
    const b = await upload(png, { name: "b.png" });
    // Same instance as A, same bytes: still another row.
    const a2 = await upload(png, { name: "a2.png", instanceId: a.instance_id });
    expect(new Set([a.hash, b.hash, a2.hash]).size).toBe(1);
    const { token } = await tokenFor({ file_ids: [a.id] });

    const file = await get(fileUrl(a), token);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(png)).toBe(true);
    const thumb = await get(`${fileUrl(a)}/thumb/128`, token);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toBe("image/webp");
    const head = await get(`${fileUrl(a)}/thumb/128`, token, {}, "HEAD");
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload).toHaveLength(0);

    for (const other of [b, a2]) {
      expect((await get(fileUrl(other), token)).statusCode).toBe(404);
      const otherThumb = await get(`${fileUrl(other)}/thumb/128`, token);
      expect(otherThumb.statusCode).toBe(404);
      expect(otherThumb.json().error.code).toBe("file_not_found");
    }
    // The right file id under another instance's URL is not the row either.
    const wrongInstance = await get(`/vola/files/${T}/${b.instance_id}/${a.id}`, token);
    expect(wrongInstance.statusCode).toBe(404);
  });

  it("does not reach the other versions of its row's chain", async () => {
    const v1 = await upload(Buffer.from("version one"));
    const v2 = await (async () => {
      const { response } = await http.upload(Buffer.from("version two"), "v.txt", {
        instanceId: v1.instance_id,
        fields: { parent_id: v1.id },
      });
      expect(response.statusCode, response.body).toBe(201);
      return FileInfoSchema.parse(response.json());
    })();
    expect(v2.parent_id).toBe(v1.id);
    const { token } = await tokenFor({ file_ids: [v2.id] });
    expect((await get(fileUrl(v2), token)).statusCode).toBe(200);
    expect((await get(fileUrl(v1), token)).statusCode).toBe(404);
  });

  it("is 404 for its row once soft-deleted", async () => {
    const a = await upload();
    const { token } = await tokenFor({ file_ids: [a.id] });
    expect((await get(fileUrl(a), token)).statusCode).toBe(200);
    expect((await http.del(fileUrl(a))).statusCode).toBe(200);
    expect((await get(fileUrl(a), token)).statusCode).toBe(404);
    expect((await get(`${fileUrl(a)}/thumb/64`, token)).statusCode).toBe(404);
  });

  it("serves Range continuations, If-None-Match and HEAD as a key does", async () => {
    const a = await upload();
    const { token } = await tokenFor({ file_ids: [a.id] });
    const full = await get(fileUrl(a), token);
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    const etag = full.headers.etag as string;

    const rest = await get(fileUrl(a), token, { range: "bytes=10-" });
    expect(rest.statusCode).toBe(206);
    expect(rest.headers["content-range"]).toBe(`bytes 10-${CONTENT.length - 1}/${CONTENT.length}`);
    expect(rest.rawPayload.equals(CONTENT.subarray(10))).toBe(true);

    const cached = await get(fileUrl(a), token, { "if-none-match": etag });
    expect(cached.statusCode).toBe(304);

    const head = await get(fileUrl(a), token, {}, "HEAD");
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe(String(CONTENT.length));
    expect(head.rawPayload).toHaveLength(0);
  });

  it("ignores X-User-Id: the principal is the token's", async () => {
    const a = await upload();
    const { token } = await tokenFor({ file_ids: [a.id] });
    const response = await get(fileUrl(a), token, { "x-user-id": "somebody-else" });
    expect(response.statusCode).toBe(200);
    await waitFor(async () => {
      const [row] = await handle.db
        .select({ by: files.lastAccessedBy })
        .from(files)
        .where(eq(files.id, a.id));
      return row?.by === PRINCIPAL ? true : undefined;
    });
    // Even an X-User-Id a key would refuse (400) is not read.
    const bad = await get(fileUrl(a), token, { "x-user-id": "x".repeat(300) });
    expect(bad.statusCode).toBe(200);
  });

  it("never reads another tenant's is_public file", async () => {
    const instanceId = randomUUID();
    const { response } = await http.upload(Buffer.from("beta public"), "p.txt", {
      instanceId,
      key: beta.key,
    });
    const foreign = FileInfoSchema.parse(response.json());
    const patched = await http.patch(fileUrl(foreign), { is_public: true }, {}, beta.key);
    expect(patched.statusCode, patched.body).toBe(200);
    // A key of acme reads it (the is_public rule)…
    expect((await http.get(fileUrl(foreign), {}, fx.readOnly.key)).statusCode).toBe(200);
    // …an acme token for that instance does not.
    const { token } = await tokenFor({ instance: { instance_type: T, instance_id: instanceId } });
    expect((await get(fileUrl(foreign), token)).statusCode).toBe(404);
    // Nor can acme name it when issuing.
    expect((await issue({ principal: PRINCIPAL, file_ids: [foreign.id] })).statusCode).toBe(404);
  });
});

describe("a token for an instance", () => {
  it("reads the rows of its instance, including one added after issue, and nothing of another", async () => {
    const x = randomUUID();
    const inX = await upload(Buffer.from("in x"), { instanceId: x });
    const inY = await upload(Buffer.from("in x"));
    const { token } = await tokenFor({ instance: { instance_type: T, instance_id: x } });
    expect((await get(fileUrl(inX), token)).statusCode).toBe(200);
    expect((await get(fileUrl(inY), token)).statusCode).toBe(404);
    const later = await upload(Buffer.from("added later"), { instanceId: x });
    const response = await get(fileUrl(later), token);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("added later");
    // Another instance TYPE with the same id is another instance.
    expect((await get(`/vola/files/other/${x}/${inX.id}`, token)).statusCode).toBe(404);
  });
});

describe("tokens that do not authenticate", () => {
  it("answers 401 for an expired, a revoked, a made-up token and one whose key was revoked", async () => {
    const a = await upload();
    const badKey = await get(fileUrl(a), `vola_live_${"x".repeat(32)}`);
    expect(badKey.statusCode).toBe(401);

    const expired = await tokenFor({ file_ids: [a.id] });
    await handle.db
      .update(accessTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(accessTokens.id, expired.id));
    const revoked = await tokenFor({ file_ids: [a.id] });
    const del = await app.inject({
      method: "DELETE",
      url: `/vola/access-tokens/${revoked.id}`,
      headers: bearer(grantKey),
    });
    expect(del.statusCode).toBe(204);
    const madeUp = `vola_at_${"Q".repeat(40)}`;

    const issuer = await mintKey(handle, fx.tenant.id, "short", "live", ["access:grant"]);
    const orphanResponse = await issue({ principal: PRINCIPAL, file_ids: [a.id] }, issuer.key);
    const orphan = AccessTokenCreatedSchema.parse(orphanResponse.json());
    expect((await get(fileUrl(a), orphan.token)).statusCode).toBe(200);
    await handle.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, issuer.apiKey.id));

    for (const token of [expired.token, revoked.token, madeUp, orphan.token]) {
      for (const url of [fileUrl(a), `${fileUrl(a)}/thumb/64`]) {
        const response = await get(url, token);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual(badKey.json());
      }
    }
  });

  it("is 401 everywhere but the four read routes, and only as Authorization: Bearer", async () => {
    const a = await upload();
    const slugged = await (async () => {
      const response = await app.inject({
        method: "PUT",
        url: `/vola/files/${T}/${a.instance_id}/slug/avatar`,
        headers: { ...bearer(grantKey), "content-type": "multipart/form-data; boundary=b" },
        payload:
          '--b\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nx\r\n--b--\r\n',
      });
      expect(response.statusCode, response.body).toBe(201);
      return FileInfoSchema.parse(response.json());
    })();
    const { token } = await tokenFor({
      instance: { instance_type: T, instance_id: a.instance_id },
    });
    const base = `/vola/files/${T}/${a.instance_id}`;
    const refused: Array<{ method: string; url: string; payload?: unknown }> = [
      { method: "GET", url: base },
      { method: "GET", url: `${fileUrl(a)}/info` },
      { method: "GET", url: `${fileUrl(a)}/versions` },
      { method: "GET", url: `${base}/slug/${slugged.slug}` },
      { method: "GET", url: `${base}/path/photo.txt` },
      { method: "PATCH", url: fileUrl(a), payload: { filename: "x.txt" } },
      { method: "DELETE", url: fileUrl(a) },
      { method: "DELETE", url: `${fileUrl(a)}/purge` },
      { method: "POST", url: base },
      { method: "POST", url: "/vola/uploads" },
      { method: "GET", url: "/vola/keys" },
      {
        method: "POST",
        url: "/vola/keys",
        payload: { name: "x", env: "live", scopes: ["files:read"] },
      },
      { method: "POST", url: "/vola/access-tokens", payload: { principal: "x", file_ids: [a.id] } },
      { method: "DELETE", url: `/vola/access-tokens/${randomUUID()}` },
      { method: "GET", url: "/vola/shares" },
      { method: "GET", url: `/vola/folders/mail/${a.instance_id}` },
      { method: "GET", url: "/vola/stats/tenant" },
      { method: "GET", url: "/vola/instance-types" },
      { method: "POST", url: "/vola/udc/fetch", payload: { collection: "files" } },
      { method: "POST", url: "/vola/udc/collections", payload: {} },
    ];
    for (const route of refused) {
      const response = await app.inject({
        method: route.method as "GET",
        url: route.url,
        headers: bearer(token),
        ...(route.payload ? { payload: route.payload as Record<string, unknown> } : {}),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(response.json().error.code).toBe("unauthorized");
    }
    // The same token reads the row on the allowed route…
    expect((await get(fileUrl(a), token)).statusCode).toBe(200);
    // …but not as X-Api-Key.
    const asHeader = await app.inject({
      method: "GET",
      url: fileUrl(a),
      headers: { "x-api-key": token },
    });
    expect(asHeader.statusCode).toBe(401);
    // Nothing was changed by the refused writes.
    expect((await http.get(`${fileUrl(a)}/info`)).json().filename).toBe("photo.txt");
  });
});

describe("POST /access-tokens", () => {
  it("needs access:grant, returns the token once and stores only its hash", async () => {
    const a = await upload();
    const forbidden = await issue({ principal: PRINCIPAL, file_ids: [a.id] }, fx.full.key);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.required).toEqual(["access:grant"]);

    const before = Date.now();
    const response = await issue({ principal: PRINCIPAL, file_ids: [a.id, a.id.toUpperCase()] });
    expect(response.statusCode).toBe(201);
    const created = AccessTokenCreatedSchema.parse(response.json());
    expect(Object.keys(response.json()).sort()).toEqual(["expires_at", "id", "token"]);
    expect(created.token.startsWith("vola_at_")).toBe(true);
    const ttl = new Date(created.expires_at).getTime() - before;
    expect(ttl).toBeGreaterThan(295_000);
    expect(ttl).toBeLessThan(305_000);
    const [row] = await handle.db
      .select()
      .from(accessTokens)
      .where(eq(accessTokens.id, created.id));
    expect(row?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain(created.token);
    expect(row?.fileIds).toEqual([a.id]);
    expect(row?.principal).toBe(PRINCIPAL);
  });

  it("is 404 for a file of another tenant, an unknown or a deleted one — for the whole request", async () => {
    const a = await upload();
    const gone = await upload();
    await http.del(fileUrl(gone));
    const { response } = await http.upload(Buffer.from("beta"), "b.txt", { key: beta.key });
    const foreign = FileInfoSchema.parse(response.json());
    for (const ids of [[a.id, foreign.id], [a.id, randomUUID()], [gone.id]]) {
      const refused = await issue({ principal: PRINCIPAL, file_ids: ids });
      expect(refused.statusCode).toBe(404);
      expect(refused.json().error.code).toBe("file_not_found");
    }
  });

  it("validates the body: exactly one target, a principal, expires_in up to the maximum", async () => {
    const a = await upload();
    const target = { instance_type: T, instance_id: randomUUID() };
    for (const body of [
      { file_ids: [a.id] },
      { principal: PRINCIPAL },
      { principal: PRINCIPAL, file_ids: [a.id], instance: target },
      { principal: PRINCIPAL, file_ids: [] },
      { principal: PRINCIPAL, file_ids: ["not-a-uuid"] },
      { principal: "a\u0000b", file_ids: [a.id] },
      { principal: PRINCIPAL, file_ids: [a.id], expires_in: 3601 },
      { principal: PRINCIPAL, file_ids: [a.id], expires_in: -5 },
      { principal: PRINCIPAL, instance: { instance_type: "Bad", instance_id: randomUUID() } },
    ]) {
      const response = await issue(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
    }
    const longest = await issue({ principal: PRINCIPAL, file_ids: [a.id], expires_in: 3600 });
    expect(longest.statusCode).toBe(201);
  });

  it("is a scope a key can only hand on when it holds it", async () => {
    const withoutGrant = await app.inject({
      method: "POST",
      url: "/vola/keys",
      headers: bearer(fx.full.key),
      payload: { name: "x", env: "live", scopes: ["files:read", "access:grant"] },
    });
    expect(withoutGrant.statusCode).toBe(403);
    expect(withoutGrant.json().error.required).toEqual(["access:grant"]);
    const withGrant = await app.inject({
      method: "POST",
      url: "/vola/keys",
      headers: bearer(grantKey),
      payload: { name: "y", env: "live", scopes: ["access:grant"] },
    });
    expect(withGrant.statusCode, withGrant.body).toBe(201);
  });

  it("deletes the tenant's expired tokens when it issues the next one", async () => {
    const a = await upload();
    const old = await tokenFor({ file_ids: [a.id] });
    const live = await tokenFor({ file_ids: [a.id] });
    await handle.db
      .update(accessTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(accessTokens.id, old.id));
    await tokenFor({ file_ids: [a.id] });
    const left = await handle.db.select({ id: accessTokens.id }).from(accessTokens);
    expect(left.map((r) => r.id)).not.toContain(old.id);
    expect(left.map((r) => r.id)).toContain(live.id);
    expect(await pruneExpiredAccessTokens(handle.db, fx.tenant.id, new Date())).toBe(0);
  });
});

describe("DELETE /access-tokens/:id", () => {
  it("revokes idempotently; another tenant's token or an unknown id is 404", async () => {
    const a = await upload();
    const { id, token } = await tokenFor({ file_ids: [a.id] });
    const del = (tokenId: string, key = grantKey) =>
      app.inject({ method: "DELETE", url: `/vola/access-tokens/${tokenId}`, headers: bearer(key) });
    const foreign = await del(id, beta.key);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("access_token_not_found");
    expect((await get(fileUrl(a), token)).statusCode).toBe(200);
    expect((await del(id, fx.full.key)).statusCode).toBe(403);
    expect((await del(id)).statusCode).toBe(204);
    expect((await del(id)).statusCode).toBe(204);
    expect((await get(fileUrl(a), token)).statusCode).toBe(401);
    expect((await del(randomUUID())).statusCode).toBe(404);
    expect((await del("nope")).statusCode).toBe(404);
  });
});

describe("encrypted files through a token", () => {
  it("serves a tenant file, refuses keyring, caller and client with access_token_encryption_unsupported", async () => {
    const secret = Buffer.from("tenant-encrypted bytes");
    const tenantFile = await upload(secret, { headers: { "x-vola-encryption": "tenant" } });
    expect(tenantFile.encryption).toBe("tenant");
    const { token } = await tokenFor({
      instance: { instance_type: T, instance_id: tenantFile.instance_id },
    });
    const ok = await get(fileUrl(tenantFile), token);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.rawPayload.equals(secret)).toBe(true);
    expect(ok.headers["cache-control"]).toBe("no-store");

    for (const mode of ["keyring", "caller", "client"] as const) {
      const row = await upload(Buffer.from(`pretend ${mode}`), {
        instanceId: tenantFile.instance_id,
      });
      await handle.db.update(files).set({ encryption: mode }).where(eq(files.id, row.id));
      for (const url of [fileUrl(row), `${fileUrl(row)}/thumb/64`]) {
        const refused = await get(url, token);
        expect(refused.statusCode, `${mode} ${url}`).toBe(409);
        expect(refused.json().error.code).toBe(ACCESS_TOKEN_ENCRYPTION_UNSUPPORTED_CODE);
      }
    }
  });
});

describe("VOLA_FILE_DOWNLOADED", () => {
  const downloads = () => audited.filter((e) => e.event_type === "VOLA_FILE_DOWNLOADED");

  it("records a download a token starts, with the token's principal, and nothing for HEAD or a continuation", async () => {
    const a = await upload();
    const { id, token } = await tokenFor({ file_ids: [a.id] });
    await flush();
    audited.length = 0;

    expect((await get(fileUrl(a), token, { "x-user-id": "ignored" })).statusCode).toBe(200);
    await flush();
    expect(downloads()).toHaveLength(1);
    const [event] = downloads() as [AuditEvent];
    expect(event).toMatchObject({
      instance_type: "vola_file",
      instance_id: a.id,
      actor_type: "user",
      actor_id: PRINCIPAL,
    });
    expect(event.payload).toMatchObject({
      tenant: fx.tenant.slug,
      file_id: a.id,
      filename: "photo.txt",
      size: CONTENT.length,
      via: "access_token",
      access_token_id: id,
    });
    expect(JSON.stringify(event)).not.toContain(token);
    expect(JSON.stringify(event)).not.toContain(grantKey);

    audited.length = 0;
    await get(fileUrl(a), token, {}, "HEAD");
    await get(fileUrl(a), token, { range: "bytes=10-" });
    await get(fileUrl(a), token, { "if-none-match": `"${a.hash}"` });
    await get(`${fileUrl(a)}/thumb/64`, token);
    await flush();
    expect(downloads()).toHaveLength(0);

    await get(fileUrl(a), token, { range: "bytes=0-9" });
    await flush();
    expect(downloads()).toHaveLength(1);
  });

  it("records an API-key download with the actorOf rule, and a share download", async () => {
    const a = await upload();
    await flush();
    audited.length = 0;
    const byKey = await http.get(fileUrl(a), { "x-user-id": "u-key" });
    expect(byKey.statusCode).toBe(200);
    const anonymousKey = await http.get(fileUrl(a));
    expect(anonymousKey.statusCode).toBe(200);
    await flush();
    const [first, second] = downloads() as [AuditEvent, AuditEvent];
    expect(first).toMatchObject({ actor_type: "user", actor_id: "u-key" });
    expect(first.payload).toMatchObject({ via: "api_key", tenant: fx.tenant.slug });
    expect(first.payload.access_token_id).toBeUndefined();
    expect(second).toMatchObject({ actor_type: "api_key" });
    expect(second.actor_id).toMatch(/^key:vola_live…/);

    const shareResponse = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(grantKey),
      payload: { file_id: a.id },
    });
    expect(shareResponse.statusCode, shareResponse.body).toBe(201);
    const share = ShareCreatedSchema.parse(shareResponse.json());
    audited.length = 0;
    const viaShare = await app.inject({ method: "GET", url: `/vola/s/${share.token}` });
    expect(viaShare.statusCode).toBe(200);
    await app.inject({ method: "HEAD", url: `/vola/s/${share.token}` });
    await flush();
    expect(downloads()).toHaveLength(1);
    const [shared] = downloads() as [AuditEvent];
    expect(shared.actor_type).toBeNull();
    expect(shared.payload).toMatchObject({
      via: "share",
      share_id: share.id,
      tenant: fx.tenant.slug,
      file_id: a.id,
    });
    expect(JSON.stringify(shared)).not.toContain(share.token);
  });

  it("is not recorded without VOLA_AUDIT_DOWNLOADS", async () => {
    const a = await upload();
    const { token } = await tokenFor({ file_ids: [a.id] });
    const response = await quiet.inject({ method: "GET", url: fileUrl(a), headers: bearer(token) });
    expect(response.statusCode).toBe(200);
    const byKey = await quiet.inject({ method: "GET", url: fileUrl(a), headers: bearer(grantKey) });
    expect(byKey.statusCode).toBe(200);
    await quietAudit.close();
    expect(quietAudited.filter((e) => e.event_type === "VOLA_FILE_DOWNLOADED")).toHaveLength(0);
  });
});

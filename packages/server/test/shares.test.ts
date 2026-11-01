import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import nodeHttp from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileInfoSchema,
  SHARE_PASSWORD_HEADER,
  type ShareCreated,
  ShareCreatedSchema,
  SharedFolderListingSchema,
  ShareInfoSchema,
  ShareListSchema,
} from "@vola/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { files, shareLinks } from "../src/db/schema.js";
import { hashShareToken } from "../src/services/shares.js";
import { createTenant } from "../src/services/tenants.js";
import { FilesystemBackend } from "../src/storage/index.js";
import { pdfFixture, pngFixture } from "./fixtures.js";
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
let storage: FilesystemBackend;
let http: ReturnType<typeof httpClient>;
let other: { tenantId: string; key: string };

const TYPE = "tickets";
const S = (token: string, path?: string) => `/vola/s/${token}${path ? `/path/${path}` : ""}`;

beforeAll(async () => {
  await truncate(handle);
  root = await mkdtemp(join(tmpdir(), "vola-shares-"));
  storage = new FilesystemBackend(root);
  fx = await setupFixture(handle, { storage });
  app = fx.app;
  await app.ready();
  http = httpClient(app, fx.full.key, TYPE);
  const tenant = await createTenant(handle.db, { slug: "other" });
  const key = await mintKey(handle, tenant.id, "other-full", "live", [
    "files:read",
    "files:write",
    "folders:read",
    "folders:write",
    "shares:write",
  ]);
  other = { tenantId: tenant.id, key: key.key };
});
afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

/** An anonymous request: no API key. */
const anon = (url: string, options: Omit<InjectOptions, "url"> = {}) =>
  app.inject({ method: "GET", url, ...options });

async function uploaded(
  data: Buffer,
  filename: string,
  options: { instanceId?: string; fields?: Record<string, string>; key?: string } = {},
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

const countOf = async (id: string) =>
  (await handle.db.select().from(shareLinks).where(eq(shareLinks.id, id)))[0]?.downloadCount;

describe("POST /shares — happy path", () => {
  it("creates a file share, stores only the token hash, and the link downloads anonymously", async () => {
    const data = Buffer.from("shared bytes");
    const { info } = await uploaded(data, "x.txt");
    const created = await share({ file_id: info.id });
    expect(created).toMatchObject({
      tenant_id: fx.tenant.id,
      file_id: info.id,
      folder_id: null,
      scope: "PUBLIC_LINK",
      has_password: false,
      expires_at: null,
      max_downloads: null,
      download_count: 0,
      created_by: "igor",
      revoked_at: null,
    });
    expect(created.url).toBe(`http://localhost:80/vola/s/${created.token}`);

    // The database has the SHA-256 of the token, never the token.
    const [row] = await handle.db.select().from(shareLinks).where(eq(shareLinks.id, created.id));
    expect(row?.tokenHash).toBe(hashShareToken(created.token));
    expect(row?.tokenHash).not.toBe(created.token);
    expect(JSON.stringify(row)).not.toContain(created.token);

    const download = await anon(S(created.token));
    expect(download.statusCode, download.body).toBe(200);
    expect(download.rawPayload.equals(data)).toBe(true);
    expect(download.headers["content-type"]).toMatch(/^text\/plain/);
    expect(download.headers["content-disposition"]).toContain('filename="x.txt"');
    expect(download.headers["cache-control"]).toBe("private, no-store");
    expect(download.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(download.headers.etag).toBe(`"${info.hash}"`);
    expect(await countOf(created.id)).toBe(1);

    // The owner's views never carry the token.
    const one = await http.get(`/vola/shares/${created.id}`);
    expect(one.statusCode).toBe(200);
    const view = ShareInfoSchema.parse(one.json());
    expect(view.download_count).toBe(1);
    expect(JSON.stringify(one.json())).not.toContain(created.token);
    const list = ShareListSchema.parse((await http.get(`/vola/shares?file_id=${info.id}`)).json());
    expect(list.shares.map((s) => s.id)).toEqual([created.id]);
    expect(
      ShareListSchema.parse((await http.get(`/vola/shares?file_id=${randomUUID()}`)).json()).shares,
    ).toEqual([]);
    expect((await http.get("/vola/shares?file_id=not-a-uuid")).json().shares).toEqual([]);
  });

  it("builds the url on VOLA_PUBLIC_URL when it is set", async () => {
    const custom = await buildApp({
      config: { ...config, publicUrl: "https://files.example.com" },
      db: handle.db,
      storage,
      logger: false,
    });
    try {
      const { info } = await uploaded(Buffer.from("u"), "u.txt");
      const response = await custom.inject({
        method: "POST",
        url: "/vola/shares",
        headers: bearer(fx.full.key),
        payload: { file_id: info.id },
      });
      expect(response.statusCode, response.body).toBe(201);
      const created = ShareCreatedSchema.parse(response.json());
      expect(created.url).toBe(`https://files.example.com/vola/s/${created.token}`);
    } finally {
      await custom.close();
    }
  });

  it("needs shares:write; the body is validated (XOR, scope, max_downloads)", async () => {
    const { info } = await uploaded(Buffer.from("v"), "v.txt");
    const forbidden = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(fx.readOnly.key),
      payload: { file_id: info.id },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toMatchObject({ code: "forbidden", required: ["shares:write"] });
    expect((await http.get("/vola/shares", {}, fx.readOnly.key)).statusCode).toBe(403);

    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/vola/shares", headers: bearer(fx.full.key), payload });
    for (const body of [
      {},
      { file_id: info.id, folder: { instance_type: TYPE, instance_id: randomUUID(), path: "a" } },
      { file_id: "nope" },
      { file_id: info.id, max_downloads: 0 },
      { file_id: info.id, password: "" },
      { file_id: info.id, expires_at: "tomorrow" },
      { folder: { instance_type: TYPE, instance_id: randomUUID(), path: "" } },
      { folder: { instance_type: TYPE, instance_id: randomUUID(), path: "a/../b" } },
      { file_id: info.id, unknown: true },
    ]) {
      const response = await post(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(422);
      expect(response.json().error.code).toBe("validation_error");
    }
    const unknownScope = await post({ file_id: info.id, scope: "FRIENDS" });
    expect(unknownScope.statusCode).toBe(422);
  });

  it("answers 501 not_implemented for every scope but PUBLIC_LINK", async () => {
    const { info } = await uploaded(Buffer.from("s"), "s.txt");
    for (const scope of ["TENANT", "INSTANCE_VIEWERS", "EMAIL"]) {
      const response = await app.inject({
        method: "POST",
        url: "/vola/shares",
        headers: bearer(fx.full.key),
        payload: { file_id: info.id, scope },
      });
      expect(response.statusCode, scope).toBe(501);
      expect(response.json().error.code).toBe("not_implemented");
    }
    expect(await handle.db.$count(shareLinks, eq(shareLinks.fileId, info.id))).toBe(0);
  });

  it("refuses an encrypted file with 409 encrypted_share_requires_grant (plan 6.3)", async () => {
    const { info } = await uploaded(Buffer.from("secret"), "secret.bin");
    await handle.db.update(files).set({ encryption: "tenant" }).where(eq(files.id, info.id));
    const response = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(fx.full.key),
      payload: { file_id: info.id },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("encrypted_share_requires_grant");
  });

  it("is tenant-scoped: another tenant's file or folder is 404, and so is a soft-deleted file", async () => {
    const { info, instanceId } = await uploaded(Buffer.from("mine"), "mine.txt", {
      fields: { folder_path: "docs" },
    });
    const foreign = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(other.key),
      payload: { file_id: info.id },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("file_not_found");
    const foreignFolder = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(other.key),
      payload: { folder: { instance_type: TYPE, instance_id: instanceId, path: "docs" } },
    });
    expect(foreignFolder.statusCode).toBe(404);
    expect(foreignFolder.json().error.code).toBe("folder_not_found");

    await http.del(`/vola/files/${TYPE}/${instanceId}/${info.id}`);
    const deleted = await app.inject({
      method: "POST",
      url: "/vola/shares",
      headers: bearer(fx.full.key),
      payload: { file_id: info.id },
    });
    expect(deleted.statusCode).toBe(404);
  });
});

describe("public access: password, expiry, revoke, unknown", () => {
  it("asks for the password in X-Share-Password or ?password=, 401 when missing or wrong", async () => {
    const { info } = await uploaded(Buffer.from("locked"), "locked.txt");
    const created = await share({ file_id: info.id, password: "s3cr3t" });
    expect(created.has_password).toBe(true);
    const [row] = await handle.db.select().from(shareLinks).where(eq(shareLinks.id, created.id));
    expect(row?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(row?.passwordHash).not.toContain("s3cr3t");

    const missing = await anon(S(created.token));
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("share_password_required");
    const wrong = await anon(`${S(created.token)}?password=wrong`);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe("share_password_required");
    expect(await countOf(created.id)).toBe(0);

    const viaHeader = await anon(S(created.token), {
      headers: { [SHARE_PASSWORD_HEADER]: "s3cr3t" },
    });
    expect(viaHeader.statusCode, viaHeader.body).toBe(200);
    expect(viaHeader.body).toBe("locked");
    const viaQuery = await anon(`${S(created.token)}?password=s3cr3t`);
    expect(viaQuery.statusCode).toBe(200);
    // The header wins over the query when both are there.
    const both = await anon(`${S(created.token)}?password=s3cr3t`, {
      headers: { [SHARE_PASSWORD_HEADER]: "nope" },
    });
    expect(both.statusCode).toBe(401);
    expect(await countOf(created.id)).toBe(2);
  });

  it("rate-limits wrong passwords: 10 in 15 minutes per token, then 429 even for the right one", async () => {
    const { info } = await uploaded(Buffer.from("guarded"), "guarded.txt");
    const created = await share({ file_id: info.id, password: "correct horse" });
    for (let attempt = 1; attempt <= 10; attempt++) {
      const response = await anon(`${S(created.token)}?password=guess-${attempt}`);
      expect(response.statusCode, `attempt ${attempt}`).toBe(401);
    }
    const blocked = await anon(`${S(created.token)}?password=guess-11`);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatchObject({ code: "too_many_password_attempts" });
    expect(blocked.json().error.retry_after).toBeGreaterThan(0);
    const rightButBlocked = await anon(`${S(created.token)}?password=correct%20horse`);
    expect(rightButBlocked.statusCode).toBe(429);
    // Another share is not affected: the counter is per token.
    const another = await share({ file_id: info.id, password: "correct horse" });
    expect((await anon(`${S(another.token)}?password=correct%20horse`)).statusCode).toBe(200);
  });

  it("answers 410 share_gone for an expired share, without asking for its password", async () => {
    const { info } = await uploaded(Buffer.from("old"), "old.txt");
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const created = await share({ file_id: info.id, expires_at: past, password: "pw" });
    expect(created.expires_at).toBe(past);
    const response = await anon(S(created.token));
    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe("share_gone");
    expect(response.json().error.message).toContain("expired");

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const live = await share({ file_id: info.id, expires_at: future });
    expect((await anon(S(live.token))).statusCode).toBe(200);
  });

  it("revokes with DELETE (idempotent, 404 for another tenant), after which the link is 410", async () => {
    const { info } = await uploaded(Buffer.from("r"), "r.txt");
    const created = await share({ file_id: info.id });
    expect((await anon(S(created.token))).statusCode).toBe(200);

    expect((await http.del(`/vola/shares/${created.id}`, {}, other.key)).statusCode).toBe(404);
    expect((await http.del(`/vola/shares/${randomUUID()}`)).statusCode).toBe(404);
    expect((await http.del("/vola/shares/not-a-uuid")).statusCode).toBe(404);
    expect((await http.get(`/vola/shares/${created.id}`, {}, other.key)).statusCode).toBe(404);

    const revoked = await http.del(`/vola/shares/${created.id}`);
    expect(revoked.statusCode).toBe(200);
    const info1 = ShareInfoSchema.parse(revoked.json());
    expect(info1.revoked_at).not.toBeNull();
    const again = await http.del(`/vola/shares/${created.id}`);
    expect(again.statusCode).toBe(200);
    expect(again.json().revoked_at).toBe(info1.revoked_at);

    const gone = await anon(S(created.token));
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error.code).toBe("share_gone");
    expect((await anon(S(created.token), { method: "HEAD" })).statusCode).toBe(410);

    // Listing hides revoked shares unless asked.
    const list = ShareListSchema.parse((await http.get(`/vola/shares?file_id=${info.id}`)).json());
    expect(list.shares).toEqual([]);
    const all = ShareListSchema.parse(
      (await http.get(`/vola/shares?file_id=${info.id}&include_revoked=1`)).json(),
    );
    expect(all.shares.map((s) => s.id)).toEqual([created.id]);
  });

  it("answers 404 share_not_found for an unknown or malformed token", async () => {
    for (const token of ["A".repeat(43), "short", `${"A".repeat(42)}+`, "..%2F..%2Fetc"]) {
      const response = await anon(S(token));
      expect(response.statusCode, token).toBe(404);
    }
    expect((await anon(S("A".repeat(43)))).json().error.code).toBe("share_not_found");
  });

  it("is 410 when the shared file was deleted or purged meanwhile", async () => {
    const { info, instanceId } = await uploaded(Buffer.from("gone soon"), "soon.txt");
    const created = await share({ file_id: info.id });
    await http.del(`/vola/files/${TYPE}/${instanceId}/${info.id}`);
    const deleted = await anon(S(created.token));
    expect(deleted.statusCode).toBe(410);
    expect(deleted.json().error.message).toContain("deleted");
    // Purge cascades the share row away: the token is simply unknown.
    await http.del(`/vola/files/${TYPE}/${instanceId}/${info.id}/purge`);
    expect((await anon(S(created.token))).statusCode).toBe(404);
  });
});

describe("max_downloads: only a request that starts a download counts", () => {
  it("counts GET and a Range from byte 0, not HEAD nor a Range continuation; then 410", async () => {
    const data = Buffer.from("0123456789abcdef");
    const { info } = await uploaded(data, "counted.bin");
    const created = await share({ file_id: info.id, max_downloads: 2 });

    // HEAD: metadata only, never a download.
    const head = await anon(S(created.token), { method: "HEAD" });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe(String(data.length));
    expect(await countOf(created.id)).toBe(0);

    // A download that starts with a Range from byte 0 counts once …
    const first = await anon(S(created.token), { headers: { range: "bytes=0-3" } });
    expect(first.statusCode).toBe(206);
    expect(first.body).toBe("0123");
    expect(await countOf(created.id)).toBe(1);
    // … and its continuations do not.
    const next = await anon(S(created.token), { headers: { range: "bytes=4-" } });
    expect(next.statusCode).toBe(206);
    expect(next.body).toBe("456789abcdef");
    const suffix = await anon(S(created.token), { headers: { range: "bytes=-4" } });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.body).toBe("cdef");
    expect(await countOf(created.id)).toBe(1);

    // The second (last) full download.
    const second = await anon(S(created.token));
    expect(second.statusCode).toBe(200);
    expect(await countOf(created.id)).toBe(2);

    // Used up: nothing may START a download any more …
    for (const options of [{}, { headers: { range: "bytes=0-3" } }]) {
      const response = await anon(S(created.token), options);
      expect(response.statusCode, JSON.stringify(options)).toBe(410);
    }
    // … but the download already granted can still be checked and resumed.
    expect((await anon(S(created.token), { method: "HEAD" })).statusCode).toBe(200);
    const resumed = await anon(S(created.token), { headers: { range: "bytes=4-" } });
    expect(resumed.statusCode).toBe(206);
    expect(await countOf(created.id)).toBe(2);
    const gone = await anon(S(created.token));
    expect(gone.json().error.code).toBe("share_gone");
    expect(gone.json().error.message).toContain("download limit");
    expect((await http.get(`/vola/shares/${created.id}`)).json()).toMatchObject({
      download_count: 2,
      max_downloads: 2,
    });
  });

  it("gives the last download to exactly one of two racing readers", async () => {
    const { info } = await uploaded(Buffer.from("race"), "race.txt");
    const created = await share({ file_id: info.id, max_downloads: 1 });
    const results = await Promise.all(Array.from({ length: 6 }, () => anon(S(created.token))));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 410)).toHaveLength(5);
    expect(await countOf(created.id)).toBe(1);
  });
});

describe("folder shares", () => {
  it("lists one level of the shared folder with relative paths and serves files by path", async () => {
    const instanceId = randomUUID();
    await uploaded(Buffer.from("a.txt"), "a.txt", { instanceId, fields: { folder_path: "docs" } });
    await uploaded(Buffer.from("b.txt"), "b.txt", { instanceId, fields: { folder_path: "docs" } });
    await uploaded(await pngFixture(), "deep.png", {
      instanceId,
      fields: { folder_path: "docs/q4/images" },
    });
    await uploaded(Buffer.from("root"), "root.txt", { instanceId });
    await uploaded(Buffer.from("elsewhere"), "else.txt", {
      instanceId,
      fields: { folder_path: "private" },
    });

    const created = await share({
      folder: { instance_type: TYPE, instance_id: instanceId, path: "/docs/" },
      max_downloads: 5,
    });
    expect(created.file_id).toBeNull();
    expect(created.folder_id).toBeTruthy();
    expect(
      ShareListSchema.parse(
        (await http.get(`/vola/shares?folder_id=${created.folder_id}`)).json(),
      ).shares.map((s) => s.id),
    ).toEqual([created.id]);

    const listing = await anon(S(created.token));
    expect(listing.statusCode, listing.body).toBe(200);
    expect(listing.headers["content-type"]).toMatch(/^application\/json/);
    const body = SharedFolderListingSchema.parse(listing.json());
    expect(body.kind).toBe("folder");
    expect(body.share).toEqual({ expires_at: null, max_downloads: 5, download_count: 0 });
    expect(body.folder).toEqual({ name: "docs", path: "" });
    expect(body.subfolders).toEqual([{ name: "q4", path: "q4" }]);
    expect(body.files.map((f) => [f.filename, f.path, f.size, f.kind])).toEqual([
      ["a.txt", "a.txt", 5, "text"],
      ["b.txt", "b.txt", 5, "text"],
    ]);
    // Nothing of the tenant or the instance leaks.
    expect(JSON.stringify(body)).not.toContain(fx.tenant.id);
    expect(JSON.stringify(body)).not.toContain(instanceId);
    expect(body.files[0]).not.toHaveProperty("hash");
    // A listing is not a download.
    expect(await countOf(created.id)).toBe(0);

    const a = await anon(S(created.token, "a.txt"));
    expect(a.statusCode, a.body).toBe(200);
    expect(a.body).toBe("a.txt");
    expect(await countOf(created.id)).toBe(1);
    const deep = await anon(S(created.token, "q4/images/deep.png"));
    expect(deep.statusCode).toBe(200);
    expect(deep.headers["content-type"]).toBe("image/png");
    expect(await countOf(created.id)).toBe(2);
    expect(
      (await anon(S(created.token, "q4/images/deep.png"), { method: "HEAD" })).statusCode,
    ).toBe(200);
    expect(await countOf(created.id)).toBe(2);

    // A subfolder path lists it; a trailing slash is fine.
    const sub = SharedFolderListingSchema.parse((await anon(S(created.token, "q4/"))).json());
    expect(sub.folder).toEqual({ name: "q4", path: "q4" });
    expect(sub.subfolders).toEqual([{ name: "images", path: "q4/images" }]);
    expect(sub.files).toEqual([]);
    const images = SharedFolderListingSchema.parse(
      (await anon(S(created.token, "q4/images"))).json(),
    );
    expect(images.files.map((f) => f.path)).toEqual(["q4/images/deep.png"]);

    // Outside the shared subtree, or nothing there: 404; a traversal: 422.
    for (const path of ["root.txt", "../root.txt", "../private/else.txt", "q4/nope.txt", "nope"]) {
      const response = await app.inject({
        method: "GET",
        url: `/vola/s/${created.token}/path/${path}`,
      });
      expect([404, 422], path).toContain(response.statusCode);
    }
    expect((await anon(S(created.token, "q4/nope.txt"))).json().error.code).toBe("file_not_found");
    // Percent-encoded traversal: `fetch` and the inject client resolve dot segments before
    // sending, a raw request does not — so this reaches the handler as `..` and is refused there.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = nodeHttp.request(
        {
          host: "127.0.0.1",
          port,
          path: `/vola/s/${created.token}/path/%2e%2e/root.txt`,
          method: "GET",
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(raw.status).toBe(422);
    expect(JSON.parse(raw.body).error.code).toBe("validation_error");
  });

  it("hides an encrypted file inside a shared folder and is 410 once the folder is deleted", async () => {
    const instanceId = randomUUID();
    const { info: plain } = await uploaded(Buffer.from("plain"), "plain.txt", {
      instanceId,
      fields: { folder_path: "mixed" },
    });
    const { info: enc } = await uploaded(Buffer.from("cipher"), "cipher.txt", {
      instanceId,
      fields: { folder_path: "mixed" },
    });
    await handle.db.update(files).set({ encryption: "tenant" }).where(eq(files.id, enc.id));
    const created = await share({
      folder: { instance_type: TYPE, instance_id: instanceId, path: "mixed" },
    });
    const listing = SharedFolderListingSchema.parse((await anon(S(created.token))).json());
    expect(listing.files.map((f) => f.id)).toEqual([plain.id]);
    expect((await anon(S(created.token, "cipher.txt"))).statusCode).toBe(404);
    expect((await anon(S(created.token, "plain.txt"))).statusCode).toBe(200);

    // A file share has no /path.
    const fileShare = await share({ file_id: plain.id });
    expect((await anon(S(fileShare.token, "plain.txt"))).statusCode).toBe(404);

    await http.del(`/vola/folders/${TYPE}/${instanceId}/mixed?recursive=1`);
    const gone = await anon(S(created.token));
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error.message).toContain("deleted");
  });

  it("serves a shared PDF inline and a password-protected folder only with the password", async () => {
    const instanceId = randomUUID();
    await uploaded(pdfFixture(), "doc.pdf", { instanceId, fields: { folder_path: "pdfs" } });
    const created = await share({
      folder: { instance_type: TYPE, instance_id: instanceId, path: "pdfs" },
      password: "folder-pw",
    });
    expect((await anon(S(created.token))).statusCode).toBe(401);
    expect((await anon(S(created.token, "doc.pdf"))).statusCode).toBe(401);
    const pdf = await anon(S(created.token, "doc.pdf"), {
      headers: { [SHARE_PASSWORD_HEADER]: "folder-pw" },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toMatch(/^inline/);
    const forced = await anon(`${S(created.token, "doc.pdf")}?download=1&password=folder-pw`);
    expect(forced.headers["content-disposition"]).toMatch(/^attachment/);
  });
});

import { createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  MemoryFingerprintStore,
  VolaClient,
  VolaError,
  VolaIntegrityError,
  VolaLockedError,
} from "@vola/client";
import {
  connect,
  createApiKey,
  createTenant,
  type DatabaseHandle,
  loadConfig,
  schema,
} from "@vola/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const server = inject("server");

/**
 * `@vola/client` (the BUILT package) against the built server: every group of the SDK over
 * real HTTP — upload and download, `Range`, the resumable upload with an abort in the middle
 * of a PATCH and the resume, the keyring flow, a share grant followed through its fragment
 * URL, and the `caller` mode from Node. Needs that server's database (skipped for an
 * external `VOLA_E2E_URL`).
 */
describe.skipIf(Boolean(process.env.VOLA_E2E_URL))("@vola/client (built server)", () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let vola: VolaClient;
  const slug = `e2e-client-${Date.now().toString(36)}`;
  const T = "tickets";
  const I = randomUUID();
  const principal = "e2e-client-user";

  beforeAll(async () => {
    handle = connect(loadConfig().testDatabaseUrl, { max: 1 });
    const tenant = await createTenant(handle.db, { slug, name: "E2E client" });
    tenantId = tenant.id;
    const { key } = await createApiKey(handle.db, {
      tenantId: tenant.id,
      env: "test",
      name: "e2e-client",
      scopes: [
        "files:read",
        "files:write",
        "folders:read",
        "folders:write",
        "shares:write",
        "keys:write",
        "keyrings:write",
        "encryption:caller",
      ],
    });
    vola = new VolaClient({ baseUrl: server, apiKey: key, userId: principal, validate: true });
  });
  afterAll(async () => {
    await handle.db.delete(schema.tenants).where(eq(schema.tenants.slug, slug));
    await handle.close();
  });

  const bytesOf = async (response: Response) => Buffer.from(await response.arrayBuffer());

  it("health and lookups answer without a key", async () => {
    expect(await vola.live()).toEqual({ status: "ok" });
    expect((await vola.ready()).status).toBe("ok");
    expect((await vola.lookups("sr")).locale).toBe("sr");
  });

  it("files: upload (bytes, a stream), download, Range, head, info, list, patch, versions, slug, byPath, delete, purge", async () => {
    const data = randomBytes(300_000);
    const info = await vola.files.upload(T, I, data, {
      filename: "Izveštaj.bin",
      folderPath: "docs/q4",
      metadata: { year: 2026 },
    });
    expect(info).toMatchObject({
      filename: "Izveštaj.bin",
      size: data.length,
      metadata: { year: 2026 },
    });
    expect(info.hash).toBe(createHash("sha256").update(data).digest("hex"));
    expect(info.folder_id).not.toBeNull();

    const whole = await vola.files.download(T, I, info.id);
    expect(whole.status).toBe(200);
    expect((await bytesOf(whole)).equals(data)).toBe(true);
    const part = await vola.files.download(T, I, info.id, { range: { start: 1000, end: 1999 } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 1000-1999/${data.length}`);
    expect((await bytesOf(part)).equals(data.subarray(1000, 2000))).toBe(true);
    const head = await vola.files.head(T, I, info.id);
    expect(head.headers.get("content-length")).toBe(String(data.length));
    const notModified = await vola.files.download(T, I, info.id, { ifNoneMatch: `"${info.hash}"` });
    expect(notModified.status).toBe(304);

    const detail = await vola.files.info(T, I, info.id);
    expect(detail.id).toBe(info.id);
    expect(detail.ocr).toBeDefined();
    const byPath = await vola.files.byPath(T, I, "docs/q4/Izveštaj.bin");
    expect((await bytesOf(byPath)).equals(data)).toBe(true);

    // A stream from Node, with a parent: a new version in the same folder.
    const v2 = Buffer.from("version two");
    const second = await vola.files.upload(T, I, Readable.from([v2]), {
      filename: "Izveštaj.bin",
      parentId: info.id,
    });
    expect(second.parent_id).toBe(info.id);
    expect(second.folder_id).toBe(info.folder_id);
    expect((await vola.files.versions(T, I, second.id)).versions.map((v) => v.id)).toEqual([
      second.id,
      info.id,
    ]);

    const page = await vola.files.list(T, I);
    expect(page.files.map((f) => f.id)).toContain(second.id);

    const renamed = await vola.files.patch(T, I, second.id, {
      filename: "Final.bin",
      is_public: true,
    });
    expect(renamed).toMatchObject({ filename: "Final.bin", is_public: true });

    const avatar = await vola.files.putSlug(
      T,
      I,
      "avatar",
      new Blob(["png"], { type: "image/png" }),
      {
        filename: "avatar.png",
      },
    );
    expect(avatar.slug).toBe("avatar");
    expect(await (await vola.files.bySlug(T, I, "avatar")).text()).toBe("png");
    expect(vola.files.downloadUrl(T, I, avatar.id)).toBe(`${server}/files/${T}/${I}/${avatar.id}`);

    const deleted = await vola.files.delete(T, I, avatar.id);
    expect(deleted.deleted_at).not.toBeNull();
    await expect(vola.files.info(T, I, avatar.id)).rejects.toMatchObject({
      status: 404,
      code: "file_not_found",
    });
    expect((await vola.files.info(T, I, avatar.id, { includeDeleted: true })).id).toBe(avatar.id);
    const purged = await vola.files.purge(T, I, avatar.id);
    expect(purged.files).toBe(1);
    const nope = await vola.files.thumb(T, I, second.id, 64).catch((e: unknown) => e);
    expect(nope).toBeInstanceOf(VolaError);
    expect((nope as VolaError).code).toBe("no_thumbnail");
  });

  it("folders: create, list, rename, move, delete", async () => {
    const folder = await vola.folders.create(T, I, "a/b");
    expect(folder.path).toBe("a/b");
    const root = await vola.folders.list(T, I);
    expect(root.folder).toBeNull();
    expect(root.subfolders.map((f) => f.path)).toContain("a");
    expect((await vola.folders.rename(T, I, "a/b", "c")).path).toBe("a/c");
    expect((await vola.folders.move(T, I, "a/c", "")).path).toBe("c");
    const gone = await vola.folders.delete(T, I, "c");
    expect(gone.folders).toBe(1);
  });

  it("resumable: an abort in the middle of a PATCH, then a resume from the server's offset", async () => {
    const data = randomBytes(1_000_000);
    const controller = new AbortController();
    let patches = 0;
    let posts = 0;
    const counting = new VolaClient({
      ...vola.options,
      fetch: (input, init) => {
        if (init?.method === "PATCH" && ++patches === 2) {
          // The second chunk is in flight: give up in the middle of it.
          setTimeout(() => controller.abort(), 1);
        }
        if (init?.method === "POST") posts++;
        return fetch(input, init);
      },
    });
    const store = new MemoryFingerprintStore();
    const options = {
      filename: "Račun.pdf",
      contentType: "application/pdf",
      chunkSize: 256 * 1024,
      store,
    };
    await expect(
      counting.uploads.resumable(T, I, data, { ...options, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const key = counting.uploads.fingerprintOf(T, I, data, "Račun.pdf");
    const remembered = await store.get(key);
    expect(remembered).toBeTruthy();
    const standing = await counting.uploads.status(remembered as string);
    expect(standing.offset).toBeGreaterThanOrEqual(256 * 1024);
    expect(standing.offset).toBeLessThan(data.length);

    const progress: number[] = [];
    const result = await counting.uploads.resumable(T, I, data, {
      ...options,
      onProgress: (p) => progress.push(p.uploaded),
    });
    expect(result.uploadId).toBe(remembered);
    // The resume starts where the server stands — at or past what HEAD said a moment ago (the
    // aborted chunk may have landed whole after the client gave up), never at a third chunk.
    expect(progress[0]).toBeGreaterThanOrEqual(standing.offset);
    expect(progress[0]).toBeLessThanOrEqual(2 * 256 * 1024);
    expect(posts).toBe(1);
    expect(await store.get(key)).toBeNull();
    const info = await vola.files.info(T, I, result.fileId);
    expect(info).toMatchObject({
      filename: "Račun.pdf",
      mime_type: "application/pdf",
      size: data.length,
    });
    expect((await bytesOf(await vola.files.download(T, I, result.fileId))).equals(data)).toBe(true);
  });

  it("keyring: setup, unlock, an encrypted upload (explicit and by folder policy), download, lock → 423, changePin", async () => {
    expect((await vola.keyrings.status()).has_pin).toBe(false);
    const created = await vola.keyrings.setup("493817");
    expect(created.recovery_key).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/);
    const unlocked = await vola.keyrings.unlock("493817");
    expect(unlocked.expires_in).toBeGreaterThan(0);
    expect(vola.unlocked).toBe(true);
    const status = await vola.keyrings.status();
    expect(status.locked).toBe(false);
    expect(status.unlock_expires_in).not.toBeNull();

    const secret = randomBytes(2 * 1024 * 1024 + 11);
    const info = await vola.files.upload(T, I, secret, {
      filename: "Tajna.bin",
      encryption: "keyring",
    });
    expect(info.encryption).toBe("keyring");
    expect(info.keyring_id).toBe(created.keyring_id);
    const download = await vola.files.download(T, I, info.id, {
      range: { start: 1024 * 1024 + 3, end: 1024 * 1024 + 1002 },
    });
    expect(download.status).toBe(206);
    expect(
      (await bytesOf(download)).equals(secret.subarray(1024 * 1024 + 3, 1024 * 1024 + 1003)),
    ).toBe(true);

    await vola.folders.create(T, I, "private");
    const policy = await vola.folders.setDefaultKeyring(T, I, "private", "me");
    expect(policy.default_keyring_id).toBe(created.keyring_id);
    const byPolicy = await vola.files.upload(T, I, Buffer.from("in the folder"), {
      filename: "note.txt",
      folderPath: "private",
    });
    expect(byPolicy.encryption).toBe("keyring");
    expect(await (await vola.files.download(T, I, byPolicy.id)).text()).toBe("in the folder");

    // A resumable keyring upload: the token on every PATCH.
    const big = randomBytes(600_000);
    const resumed = await vola.uploads.resumable(T, I, big, {
      filename: "big-secret.bin",
      encryption: "keyring",
      chunkSize: 200_000,
      fingerprint: false,
    });
    expect((await bytesOf(await vola.files.download(T, I, resumed.fileId))).equals(big)).toBe(true);

    await vola.lock();
    expect(vola.unlocked).toBe(false);
    await expect(vola.files.download(T, I, info.id)).rejects.toBeInstanceOf(VolaLockedError);
    await expect(vola.files.info(T, I, info.id)).rejects.toMatchObject({
      status: 423,
      code: "vola_locked",
    });
    expect((await vola.keyrings.status()).locked).toBe(true);
    // Lists never fail: the name is masked.
    const listed = (await vola.files.list(T, I)).files.find((f) => f.id === info.id);
    expect(listed?.filename).not.toBe("Tajna.bin");

    await vola.keyrings.unlock("493817");
    const wrong = await vola.keyrings.unlock("000000").catch((e: unknown) => e as VolaError);
    expect(wrong).toMatchObject({ status: 403, code: "pin_wrong" });
    await vola.keyrings.changePin("493817", "271828");
    expect(vola.unlocked).toBe(false);
    await vola.keyrings.unlock("271828");
    expect(await (await vola.files.download(T, I, byPolicy.id)).text()).toBe("in the folder");
    await vola.lock();
  });

  it("share grant: a tenant-encrypted file shared, opened through its fragment URL, a wrong secret refused, revoked", async () => {
    const plain = randomBytes(1_500_000);
    const info = await vola.files.upload(T, I, plain, {
      filename: "Ugovor.pdf",
      encryption: "tenant",
    });
    expect(info.encryption).toBe("tenant");
    const share = await vola.shares.create({ file_id: info.id, password: "lozinka" });
    expect(share.encrypted).toBe(true);
    expect(share.url).toMatch(/#[A-Za-z0-9_-]{43}$/);

    const opened = await VolaClient.openShare(share.url, { password: "lozinka" });
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-disposition")).toContain("Ugovor.pdf");
    expect((await bytesOf(opened)).equals(plain)).toBe(true);
    const ranged = await vola.shares.open(share.url, {
      password: "lozinka",
      range: { start: 1_000_000 },
    });
    expect(ranged.status).toBe(206);
    expect((await bytesOf(ranged)).equals(plain.subarray(1_000_000))).toBe(true);

    const bare = share.url.replace(/#.*$/, "");
    await expect(VolaClient.openShare(bare, { password: "lozinka" })).rejects.toMatchObject({
      status: 401,
      code: "share_secret_required",
    });
    const wrong = `${bare}#${randomBytes(32).toString("base64url")}`;
    await expect(VolaClient.openShare(wrong, { password: "lozinka" })).rejects.toBeInstanceOf(
      VolaIntegrityError,
    );
    await expect(VolaClient.openShare(share.url)).rejects.toMatchObject({
      code: "share_password_required",
    });

    expect((await vola.shares.list({ fileId: info.id })).shares.map((s) => s.id)).toEqual([
      share.id,
    ]);
    const revoked = await vola.shares.revoke(share.id);
    expect(revoked.revoked_at).not.toBeNull();
    await expect(VolaClient.openShare(share.url, { password: "lozinka" })).rejects.toMatchObject({
      status: 410,
    });
  });

  it("caller mode from Node: the content key on the upload and every read; without it 423; a grant the caller made", async () => {
    const contentKey = randomBytes(32);
    const plain = randomBytes(700_000);
    const info = await vola.files.upload(T, I, plain, {
      filename: "Poverljivo.bin",
      encryption: "caller",
      contentKey,
    });
    expect(info.encryption).toBe("caller");
    const download = await vola.files.download(T, I, info.id, { contentKey });
    expect((await bytesOf(download)).equals(plain)).toBe(true);
    expect((await vola.files.info(T, I, info.id, { contentKey })).filename).toBe("Poverljivo.bin");
    await expect(vola.files.download(T, I, info.id)).rejects.toBeInstanceOf(VolaLockedError);
    await expect(
      vola.files.download(T, I, info.id, { contentKey: randomBytes(32) }),
    ).rejects.toBeInstanceOf(VolaIntegrityError);

    // A resumable caller upload: the key on every PATCH.
    const resumed = await vola.uploads.resumable(T, I, randomBytes(300_000), {
      filename: "chunks.bin",
      encryption: "caller",
      contentKey,
      chunkSize: 100_000,
      fingerprint: false,
    });
    expect((await vola.files.info(T, I, resumed.fileId, { contentKey })).encryption).toBe("caller");

    // The server cannot make the grant (it never holds the key) …
    await expect(vola.shares.create({ file_id: info.id }, { contentKey })).rejects.toMatchObject({
      status: 409,
      code: "encrypted_share_requires_grant",
    });
    // … the caller can: it holds the content key, so it unwraps the file key itself.
    const [row] = await handle.db.select().from(schema.files).where(eq(schema.files.id, info.id));
    const fkCt = row?.fkCt as Buffer;
    const decipher = createDecipheriv("aes-256-gcm", contentKey, fkCt.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${info.id}:key:caller:${tenantId}`));
    decipher.setAuthTag(fkCt.subarray(fkCt.length - 16));
    const fileKey = Buffer.concat([
      decipher.update(fkCt.subarray(12, fkCt.length - 16)),
      decipher.final(),
    ]);
    const share = await vola.shares.createCallerGrant(info.id, new Uint8Array(fileKey), {
      max_downloads: 2,
    });
    expect(share.encrypted).toBe(true);
    const opened = await VolaClient.openShare(share.url);
    expect((await bytesOf(opened)).equals(plain)).toBe(true);
  });

  it("stats, instance types, keys, udc", async () => {
    const tenant = await vola.stats.tenant({ recompute: true });
    expect(tenant.total_files).toBeGreaterThan(0);
    const instance = await vola.stats.instance(T, I);
    expect(instance.instance_id).toBe(I);
    const storage = await vola.stats.storage();
    expect(storage.scope).toBe("tenant");
    expect(storage.physical).toBeNull();
    expect((await vola.instanceTypes()).instance_types.map((t) => t.instance_type)).toContain(T);

    const key = await vola.keys.create({ name: "child", scopes: ["files:read"], env: "test" });
    expect(key.key).toMatch(/^vola_test_/);
    expect((await vola.keys.list()).keys.map((k) => k.id)).toContain(key.id);
    expect((await vola.keys.revoke(key.id)).revoked_at).not.toBeNull();

    const collections = await vola.udc.collections();
    expect(collections.collections.map((c) => c.name)).toContain("files");
    const rows = await vola.udc.list({
      collection: "files",
      filter: { field: "instance_type", op: "eq", value: T },
    });
    expect(rows.total).toBeGreaterThan(0);
  });
});

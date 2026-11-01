import { createDecipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import { callerGrant, parseShareUrl, VolaIntegrityError } from "../src/index.js";
import { errorResponse, FILE, jsonResponse, makeClient, SHARE } from "./fake.js";

describe("shares (owner)", () => {
  it("create, list, get, revoke", async () => {
    const { client, last } = makeClient((call) =>
      call.method === "POST"
        ? jsonResponse({ ...SHARE, token: "t".repeat(43), url: "http://vola.test/vola/s/t" }, 201)
        : call.path === "/vola/shares"
          ? jsonResponse({ shares: [SHARE] })
          : jsonResponse(SHARE),
    );
    const created = await client.shares.create(
      { file_id: FILE.id, password: "pw", max_downloads: 3 },
      { unlock: "tok" },
    );
    expect(created.url).toBe("http://vola.test/vola/s/t");
    expect(last().json).toEqual({ file_id: FILE.id, password: "pw", max_downloads: 3 });
    expect(last().headers.get("x-vola-unlock")).toBe("tok");

    await client.shares.list({ fileId: FILE.id, includeRevoked: true });
    expect(last().url).toBe(`http://vola.test/vola/shares?file_id=${FILE.id}&include_revoked=1`);
    await client.shares.list({ folderId: "f" });
    expect(last().url).toBe("http://vola.test/vola/shares?folder_id=f");
    expect(await client.shares.get(SHARE.id)).toEqual(SHARE);
    expect(last().path).toBe(`/vola/shares/${SHARE.id}`);
    await client.shares.revoke(SHARE.id);
    expect(last().method).toBe("DELETE");
  });

  it("callerGrant seals the file key under the secret with the file-bound AAD (openable with node:crypto)", async () => {
    const fileKey = new Uint8Array(32).fill(9);
    const grant = await callerGrant(FILE.id, fileKey);
    expect(grant.secret).toHaveLength(32);
    expect(grant.fragment).toBe(Buffer.from(grant.secret).toString("base64url"));
    const sealed = Buffer.from(grant.fkShareCt, "base64");
    expect(sealed).toHaveLength(60);
    const decipher = createDecipheriv("aes-256-gcm", grant.secret, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${FILE.id}:key:share:caller`));
    decipher.setAuthTag(sealed.subarray(44));
    const opened = Buffer.concat([decipher.update(sealed.subarray(12, 44)), decipher.final()]);
    expect(new Uint8Array(opened)).toEqual(fileKey);
    await expect(callerGrant(FILE.id, new Uint8Array(5))).rejects.toMatchObject({ status: 0 });
    await expect(callerGrant(FILE.id, fileKey, new Uint8Array(3))).rejects.toMatchObject({
      status: 0,
    });
  });

  it("createCallerGrant posts fk_share_ct and appends the fragment the server never saw", async () => {
    const { client, last } = makeClient(() =>
      jsonResponse(
        { ...SHARE, encrypted: true, token: "t".repeat(43), url: "http://vola.test/vola/s/t" },
        201,
      ),
    );
    const created = await client.shares.createCallerGrant(FILE.id, new Uint8Array(32), {
      max_downloads: 1,
    });
    const body = last().json as Record<string, unknown>;
    expect(body.file_id).toBe(FILE.id);
    expect(body.max_downloads).toBe(1);
    expect(typeof body.fk_share_ct).toBe("string");
    expect(created.url).toMatch(/^http:\/\/vola\.test\/vola\/s\/t#[A-Za-z0-9_-]{43}$/);
    expect(last().url).not.toContain("#");
  });
});

describe("shares (recipient)", () => {
  it("parseShareUrl splits the fragment off", () => {
    expect(parseShareUrl("http://h/vola/s/tok#SECRET")).toEqual({
      url: "http://h/vola/s/tok",
      secret: "SECRET",
    });
    expect(parseShareUrl("http://h/vola/s/tok")).toEqual({
      url: "http://h/vola/s/tok",
      secret: null,
    });
  });

  it("open: secret and password as headers, path inside a folder share, no API key; refusals throw typed", async () => {
    let status = 200;
    let code = "";
    const { client, last } = makeClient((call) =>
      status === 200 ? new Response(call.path, { status }) : errorResponse(status, code),
    );
    const response = await client.shares.open("http://vola.test/vola/s/tok#S", {
      password: "pw",
      path: "sub/a b.txt",
      download: true,
    });
    expect(await response.text()).toBe("/vola/s/tok/path/sub/a%20b.txt");
    expect(last().url).toBe("http://vola.test/vola/s/tok/path/sub/a%20b.txt?download=1");
    expect(last().headers.get("x-share-secret")).toBe("S");
    expect(last().headers.get("x-share-password")).toBe("pw");
    expect(last().headers.get("authorization")).toBeNull();

    await client.shares.open("http://vola.test/vola/s/tok", {
      method: "HEAD",
      range: { start: 5 },
    });
    expect(last().method).toBe("HEAD");
    expect(last().headers.get("range")).toBe("bytes=5-");
    expect(last().headers.get("x-share-secret")).toBeNull();

    status = 409;
    code = "vola_integrity";
    await expect(client.shares.open("http://vola.test/vola/s/tok#wrong")).rejects.toBeInstanceOf(
      VolaIntegrityError,
    );
    status = 410;
    code = "share_gone";
    await expect(client.shares.open("http://vola.test/vola/s/tok")).rejects.toMatchObject({
      status: 410,
      code: "share_gone",
    });
  });

  it("listing: the JSON of a folder share, validated on request", async () => {
    const listing = {
      kind: "folder",
      share: { expires_at: null, max_downloads: null, download_count: 0 },
      folder: { name: "docs", path: "" },
      subfolders: [],
      files: [],
    };
    let body: unknown = listing;
    const { client, last } = makeClient(() => jsonResponse(body), { validate: true });
    expect(await client.shares.listing("http://vola.test/vola/s/tok#S")).toEqual(listing);
    expect(last().headers.get("x-share-secret")).toBe("S");
    expect(last().headers.get("authorization")).toBeNull();
    body = { kind: "nope" };
    await expect(client.shares.listing("http://vola.test/vola/s/tok")).rejects.toMatchObject({
      code: "invalid_response",
    });
    const { client: loose } = makeClient(() => jsonResponse(body));
    expect(await loose.shares.listing("http://vola.test/vola/s/tok")).toEqual({ kind: "nope" });
  });
});

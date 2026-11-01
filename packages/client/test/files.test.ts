import { describe, expect, it } from "vitest";
import { VolaError } from "../src/index.js";
import { errorResponse, FILE, jsonResponse, makeClient } from "./fake.js";

const T = "tickets";
const I = FILE.instance_id;
const base = `/vola/files/${T}/${I}`;

describe("files.upload", () => {
  it("POSTs a multipart with the fields BEFORE the file, the encryption header, the unlock token", async () => {
    const { client, last } = makeClient(() => jsonResponse(FILE, 201), { userId: "u" });
    const info = await client.files.upload(T, I, new Uint8Array([1, 2, 3]), {
      filename: "a.txt",
      contentType: "text/plain",
      folderPath: "docs/q4",
      parentId: "p-1",
      metadata: { tag: "x" },
      encryption: "keyring",
      unlock: "tok",
    });
    expect(info).toEqual(FILE);
    const call = last();
    expect(call.method).toBe("POST");
    expect(call.path).toBe(base);
    expect(call.headers.get("x-vola-encryption")).toBe("keyring");
    expect(call.headers.get("x-vola-unlock")).toBe("tok");
    expect(call.body).toBeInstanceOf(FormData);
    const form = call.form as FormData;
    expect([...form.keys()]).toEqual(["folder_path", "parent_id", "metadata", "file"]);
    expect(form.get("folder_path")).toBe("docs/q4");
    expect(form.get("parent_id")).toBe("p-1");
    expect(form.get("metadata")).toBe('{"tag":"x"}');
    const file = form.get("file") as File;
    expect(file.name).toBe("a.txt");
    expect(file.type).toBe("text/plain");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("takes the name and type of a File, sends folder_id ('' for the root), defaults the type", async () => {
    const { client, last } = makeClient(() => jsonResponse(FILE, 201));
    await client.files.upload(
      T,
      I,
      new File([new Blob(["x"])], "named.bin", { type: "image/png" }),
    );
    let form = last().form as FormData;
    expect((form.get("file") as File).name).toBe("named.bin");
    expect((form.get("file") as File).type).toBe("image/png");
    await client.files.upload(T, I, new ArrayBuffer(2), { filename: "b", folderId: null });
    form = last().form as FormData;
    expect(form.get("folder_id")).toBe("");
    expect((form.get("file") as File).type).toBe("application/octet-stream");
    await client.files.upload(T, I, new Blob(["x"]), { filename: "c", folderId: "f-1" });
    expect((last().form as FormData).get("folder_id")).toBe("f-1");
  });

  it("slug → PUT …/slug/:slug (and putSlug is the same)", async () => {
    const { client, last } = makeClient(() => jsonResponse(FILE, 201));
    await client.files.upload(T, I, new Blob(["x"]), { filename: "a", slug: "avatar" });
    expect(last().method).toBe("PUT");
    expect(last().path).toBe(`${base}/slug/avatar`);
    await client.files.putSlug(T, I, "cover", new Blob(["x"]), { filename: "a" });
    expect(last().path).toBe(`${base}/slug/cover`);
  });

  it("streams a ReadableStream or an async iterable as a self-framed multipart with duplex: half", async () => {
    const { client, last } = makeClient(() => jsonResponse(FILE, 201));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });
    await client.files.upload(T, I, stream, { filename: 'we"ird\nname.txt', folderPath: "a" });
    const call = last();
    expect(call.body).toBeInstanceOf(ReadableStream);
    expect((call.init as { duplex?: string }).duplex).toBe("half");
    expect(call.headers.get("content-type")).toMatch(
      /^multipart\/form-data; boundary=----VolaFormBoundary/,
    );
    const form = call.form as FormData;
    expect(form.get("folder_path")).toBe("a");
    const file = form.get("file") as File;
    expect(file.name).toBe('we"ird\nname.txt'); // percent-escaped on the wire, decoded by the parser
    expect(await file.text()).toBe("hello world");

    async function* chunks() {
      yield new TextEncoder().encode("ab");
      yield new TextEncoder().encode("cd");
    }
    await client.files.upload(T, I, chunks(), { filename: "it.txt" });
    expect(await ((last().form as FormData).get("file") as File).text()).toBe("abcd");
  });

  it("refuses a nameless source and folderPath together with folderId, before any request", async () => {
    const { client, calls } = makeClient();
    await expect(client.files.upload(T, I, new Blob(["x"]))).rejects.toMatchObject({
      status: 0,
      code: "bad_request",
    });
    await expect(
      client.files.upload(T, I, new Blob(["x"]), { filename: "a", folderPath: "a", folderId: "b" }),
    ).rejects.toBeInstanceOf(VolaError);
    expect(calls).toHaveLength(0);
  });

  it("surfaces the server's refusal", async () => {
    const { client } = makeClient(() => errorResponse(413, "file_too_large"));
    await expect(
      client.files.upload(T, I, new Blob(["x"]), { filename: "a" }),
    ).rejects.toMatchObject({
      status: 413,
      code: "file_too_large",
    });
  });
});

describe("files.download and friends", () => {
  it("download: a streaming Response with Range, ?download=1, If-None-Match; 206 and 304 are answers", async () => {
    const { client, last } = makeClient((call) => {
      if (call.headers.get("if-none-match")) return new Response(null, { status: 304 });
      return new Response("abc", { status: call.headers.has("range") ? 206 : 200 });
    });
    let response = await client.files.download(T, I, FILE.id);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abc");
    expect(last().url).toBe(`http://vola.test${base}/${FILE.id}`);

    response = await client.files.download(T, I, FILE.id, {
      range: { start: 10, end: 20 },
      download: true,
      contentKey: new Uint8Array(32),
    });
    expect(response.status).toBe(206);
    expect(last().headers.get("range")).toBe("bytes=10-20");
    expect(last().headers.get("x-vola-content-key")).not.toBeNull();
    expect(last().query.get("download")).toBe("1");

    await client.files.download(T, I, FILE.id, { range: { suffix: 5 } });
    expect(last().headers.get("range")).toBe("bytes=-5");
    await client.files.download(T, I, FILE.id, { range: { start: 7 } });
    expect(last().headers.get("range")).toBe("bytes=7-");
    await client.files.download(T, I, FILE.id, { range: "bytes=1-2" });
    expect(last().headers.get("range")).toBe("bytes=1-2");

    response = await client.files.download(T, I, FILE.id, { ifNoneMatch: '"x"' });
    expect(response.status).toBe(304);
  });

  it("head, byPath, bySlug, public hit their routes; public is anonymous", async () => {
    const { client, last } = makeClient(() => new Response("", { status: 200 }));
    await client.files.head(T, I, FILE.id);
    expect(last().method).toBe("HEAD");
    expect(last().path).toBe(`${base}/${FILE.id}`);
    await client.files.byPath(T, I, "/docs/q4/re port.pdf");
    expect(last().path).toBe(`${base}/path/docs/q4/re%20port.pdf`);
    await client.files.bySlug(T, I, "avatar", { range: { start: 0 } });
    expect(last().path).toBe(`${base}/slug/avatar`);
    expect(last().headers.get("range")).toBe("bytes=0-");
    await client.files.public(FILE.id, { download: true });
    expect(last().path).toBe(`/vola/public/${FILE.id}`);
    expect(last().query.get("download")).toBe("1");
    expect(last().headers.get("authorization")).toBeNull();
  });

  it("downloadUrl, publicUrl and thumbUrl carry no credentials", () => {
    const { client } = makeClient();
    expect(client.files.downloadUrl(T, I, FILE.id)).toBe(`http://vola.test${base}/${FILE.id}`);
    expect(client.files.downloadUrl(T, I, FILE.id, { download: true })).toBe(
      `http://vola.test${base}/${FILE.id}?download=1`,
    );
    expect(client.files.publicUrl(FILE.id)).toBe(`http://vola.test/vola/public/${FILE.id}`);
    expect(client.files.thumbUrl(T, I, FILE.id, 128, { crop: "fit" })).toBe(
      `http://vola.test${base}/${FILE.id}/thumb/128?crop=fit`,
    );
    expect(client.files.thumbUrl(T, I, FILE.id, 64)).not.toContain("vola_test_k");
  });

  it("info, list, iterate, versions build their queries", async () => {
    const pages: Record<string, unknown> = {
      "": { files: [FILE], next_cursor: "c2" },
      c2: { files: [{ ...FILE, id: "f2" }], next_cursor: null },
    };
    const { client, last, calls } = makeClient((call) => {
      if (call.path.endsWith("/info")) return jsonResponse({ ...FILE, ocr: { status: null } });
      if (call.path.endsWith("/versions")) return jsonResponse({ versions: [FILE] });
      return jsonResponse(pages[call.query.get("cursor") ?? ""]);
    });
    const detail = await client.files.info(T, I, FILE.id, { includeDeleted: true, ocr: "full" });
    expect(detail.ocr).toEqual({ status: null });
    expect(last().url).toBe(`http://vola.test${base}/${FILE.id}/info?include_deleted=1&ocr=full`);
    await client.files.info(T, I, FILE.id);
    expect(last().url).toBe(`http://vola.test${base}/${FILE.id}/info`);

    const page = await client.files.list(T, I, { limit: 10, includeDeleted: false });
    expect(page.next_cursor).toBe("c2");
    expect(last().url).toBe(`http://vola.test${base}?limit=10`);

    const all = [];
    for await (const file of client.files.iterate(T, I)) all.push(file.id);
    expect(all).toEqual([FILE.id, "f2"]);
    expect(calls.filter((c) => c.path === base)).toHaveLength(3);

    await client.files.versions(T, I, FILE.id, { includeDeleted: true });
    expect(last().url).toBe(`http://vola.test${base}/${FILE.id}/versions?include_deleted=1`);
  });

  it("patch, delete, purge", async () => {
    const { client, last } = makeClient((call) =>
      call.path.endsWith("/purge") ? jsonResponse({ files: 2, blobs: 1 }) : jsonResponse(FILE),
    );
    await client.files.patch(T, I, FILE.id, { folder_path: "", is_public: true });
    expect(last().method).toBe("PATCH");
    expect(last().json).toEqual({ folder_path: "", is_public: true });
    await client.files.delete(T, I, FILE.id);
    expect(last().method).toBe("DELETE");
    expect(last().path).toBe(`${base}/${FILE.id}`);
    expect(await client.files.purge(T, I, FILE.id)).toEqual({ files: 2, blobs: 1 });
    expect(last().path).toBe(`${base}/${FILE.id}/purge`);
  });

  it("thumb: ready / generating (202 is not the image) / failed / not_modified / 404 throws", async () => {
    let mode = "ready";
    const { client, last } = makeClient(() => {
      if (mode === "ready")
        return new Response("webp", {
          status: 200,
          headers: { "x-thumbnail-status": "ready", etag: '"e"', "content-type": "image/webp" },
        });
      if (mode === "generating")
        return new Response("placeholder", {
          status: 202,
          headers: { "x-thumbnail-status": "generating" },
        });
      if (mode === "failed")
        return new Response("placeholder", {
          status: 200,
          headers: { "x-thumbnail-status": "failed" },
        });
      if (mode === "304") return new Response(null, { status: 304, headers: { etag: '"e"' } });
      return errorResponse(404, "no_thumbnail");
    });
    const ready = await client.files.thumb(T, I, FILE.id, 256, { crop: "attention" });
    expect(ready.status).toBe("ready");
    if (ready.status === "ready") {
      expect(await ready.blob.text()).toBe("webp");
      expect(ready.etag).toBe('"e"');
    }
    expect(last().url).toBe(`http://vola.test${base}/${FILE.id}/thumb/256?crop=attention`);
    mode = "generating";
    expect((await client.files.thumb(T, I, FILE.id, 64)).status).toBe("generating");
    mode = "failed";
    expect((await client.files.thumb(T, I, FILE.id, 64)).status).toBe("failed");
    mode = "304";
    expect((await client.files.thumb(T, I, FILE.id, 64, { ifNoneMatch: '"e"' })).status).toBe(
      "not_modified",
    );
    mode = "404";
    await expect(client.files.thumb(T, I, FILE.id, 64)).rejects.toMatchObject({
      code: "no_thumbnail",
    });
  });
});

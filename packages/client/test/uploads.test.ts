import { decodeTusMetadata } from "@vola/core";
import { describe, expect, it } from "vitest";
import { MemoryFingerprintStore, storageFingerprintStore, VolaError } from "../src/index.js";
import { errorResponse, type Handler, makeClient, type RecordedCall } from "./fake.js";

const T = "tickets";
const I = "33333333-3333-4333-8333-333333333333";

interface ServerUpload {
  id: string;
  length: number;
  bytes: Uint8Array;
  offset: number;
  fileId: string | null;
  metadata: string;
  gone?: boolean;
}

/** An in-memory tus server: creation, HEAD, PATCH, DELETE — enough to drive `resumable()`. */
function tusServer(
  options: { onPatch?: (call: RecordedCall, upload: ServerUpload) => Response | undefined } = {},
) {
  const uploads = new Map<string, ServerUpload>();
  let next = 1;
  const tusHeaders = (u: ServerUpload) => ({
    "tus-resumable": "1.0.0",
    "upload-offset": String(u.offset),
    "upload-length": String(u.length),
    "upload-expires": "Thu, 01 Jan 2099 00:00:00 GMT",
    ...(u.fileId ? { "vola-file-id": u.fileId } : {}),
  });
  const handler: Handler = async (call) => {
    if (call.headers.get("tus-resumable") !== "1.0.0" && call.method !== "OPTIONS") {
      return errorResponse(412, "tus_version_unsupported");
    }
    if (call.path === "/vola/uploads" && call.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "tus-version": "1.0.0",
          "tus-extension": "creation,termination,expiration",
          "tus-max-size": "1000",
        },
      });
    }
    if (call.path === "/vola/uploads" && call.method === "POST") {
      const length = Number(call.headers.get("upload-length"));
      const id = `up-${next++}`;
      const upload: ServerUpload = {
        id,
        length,
        bytes: new Uint8Array(length),
        offset: 0,
        fileId: null,
        metadata: call.headers.get("upload-metadata") ?? "",
      };
      uploads.set(id, upload);
      return new Response(null, {
        status: 201,
        headers: { location: `/vola/uploads/${id}`, ...tusHeaders(upload) },
      });
    }
    const id = call.path.split("/").pop() ?? "";
    const upload = uploads.get(id);
    if (!upload) return errorResponse(404, "upload_not_found");
    if (upload.gone) return errorResponse(410, "upload_gone");
    if (call.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          ...tusHeaders(upload),
          "upload-metadata": upload.metadata,
          "cache-control": "no-store",
        },
      });
    }
    if (call.method === "DELETE") {
      uploads.delete(id);
      return new Response(null, { status: 204, headers: { "tus-resumable": "1.0.0" } });
    }
    if (call.method === "PATCH") {
      const custom = options.onPatch?.(call, upload);
      if (custom) return custom;
      if (call.headers.get("content-type") !== "application/offset+octet-stream") {
        return errorResponse(415, "unsupported_media_type");
      }
      const offset = Number(call.headers.get("upload-offset"));
      if (offset !== upload.offset) return errorResponse(409, "upload_offset_mismatch");
      const chunk = new Uint8Array(await new Response(call.body as BodyInit).arrayBuffer());
      upload.bytes.set(chunk, offset);
      upload.offset += chunk.length;
      if (upload.offset === upload.length) upload.fileId = `file-of-${id}`;
      return new Response(null, { status: 204, headers: tusHeaders(upload) });
    }
    return undefined;
  };
  return { handler, uploads };
}

const data = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

describe("uploads: the steps", () => {
  it("protocol, create (metadata, headers, Location), status, append, abort", async () => {
    const server = tusServer();
    const { client, last } = makeClient(server.handler, { userId: "u-1" });
    expect(await client.uploads.protocol()).toEqual({
      version: "1.0.0",
      extensions: ["creation", "termination", "expiration"],
      maxSize: 1000,
    });
    expect(last().headers.get("authorization")).toBeNull();

    const created = await client.uploads.create(T, I, {
      length: 10,
      filename: "Račun.pdf",
      contentType: "application/pdf",
      folderPath: "docs",
      parentId: "p",
      slug: "s",
      metadata: { a: 1 },
      encryption: "tenant",
      unlock: "tok",
    });
    expect(created).toMatchObject({ uploadId: "up-1", offset: 0, length: 10, fileId: null });
    expect(created.expiresAt).toContain("2099");
    const call = last();
    expect(call.headers.get("upload-length")).toBe("10");
    expect(call.headers.get("x-vola-encryption")).toBe("tenant");
    expect(call.headers.get("x-vola-unlock")).toBe("tok");
    expect(call.headers.get("x-user-id")).toBe("u-1");
    expect(decodeTusMetadata(call.headers.get("upload-metadata"))).toEqual({
      instance_type: T,
      instance_id: I,
      filename: "Račun.pdf",
      folder_path: "docs",
      parent_id: "p",
      slug: "s",
      content_type: "application/pdf",
      metadata: '{"a":1}',
      encryption: "tenant",
    });

    const status = await client.uploads.status("up-1");
    expect(status).toMatchObject({ uploadId: "up-1", offset: 0, length: 10, fileId: null });
    expect(status.metadata.filename).toBe("Račun.pdf");

    const chunk = await client.uploads.append("up-1", data(10).subarray(0, 4), 0);
    expect(chunk).toEqual({ offset: 4, fileId: null });
    expect(last().headers.get("content-type")).toBe("application/offset+octet-stream");
    expect(last().headers.get("upload-offset")).toBe("0");
    const done = await client.uploads.append("up-1", new Blob([data(10).subarray(4)]), 4);
    expect(done).toEqual({ offset: 10, fileId: "file-of-up-1" });
    expect((await client.uploads.status("up-1")).fileId).toBe("file-of-up-1");

    await client.uploads.abort("up-1");
    expect(last().method).toBe("DELETE");
    await expect(client.uploads.status("up-1")).rejects.toMatchObject({ status: 404 });
    await expect(
      client.uploads.create(T, I, { length: 1, filename: "f", folderId: "x" }),
    ).rejects.toBeInstanceOf(VolaError);
  });
});

describe("uploads.resumable", () => {
  it("uploads in chunks, reports progress, resolves with the file id, forgets the fingerprint", async () => {
    const server = tusServer();
    const { client, calls } = makeClient(server.handler);
    const store = new MemoryFingerprintStore();
    const bytes = data(1000);
    const progress: number[] = [];
    const result = await client.uploads.resumable(T, I, bytes, {
      filename: "big.bin",
      chunkSize: 300,
      store,
      onProgress: (p) => progress.push(p.uploaded),
    });
    expect(result).toEqual({ fileId: "file-of-up-1", uploadId: "up-1" });
    expect(progress).toEqual([0, 300, 600, 900, 1000]);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(4);
    expect(server.uploads.get("up-1")?.bytes).toEqual(bytes);
    expect(await store.get(client.uploads.fingerprintOf(T, I, bytes, "big.bin"))).toBeNull();
  });

  it("resumes after an abort in the middle of a PATCH: HEAD for the offset, then PATCH from there", async () => {
    const controller = new AbortController();
    let patches = 0;
    const server = tusServer({
      onPatch: (_call, upload) => {
        patches++;
        if (patches === 2) {
          // The second chunk: the server took half of it when the client gave up.
          upload.offset += 100;
          controller.abort();
          throw controller.signal.reason;
        }
        return undefined;
      },
    });
    const { client, calls } = makeClient(server.handler);
    const store = new MemoryFingerprintStore();
    const bytes = data(1000);
    const options = { filename: "big.bin", chunkSize: 300, store };
    const first = client.uploads.resumable(T, I, bytes, { ...options, signal: controller.signal });
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const key = client.uploads.fingerprintOf(T, I, bytes, "big.bin");
    expect(await store.get(key)).toBe("up-1");

    const progress: number[] = [];
    const second = await client.uploads.resumable(T, I, bytes, {
      ...options,
      onProgress: (p) => progress.push(p.uploaded),
    });
    expect(second).toEqual({ fileId: "file-of-up-1", uploadId: "up-1" });
    expect(progress[0]).toBe(400); // HEAD said 400: 300 of the first chunk + the 100 the abort left behind
    const resumed = calls.slice(calls.findIndex((c) => c.method === "HEAD"));
    expect(resumed[0]?.method).toBe("HEAD");
    expect(resumed[1]?.method).toBe("PATCH");
    expect(resumed[1]?.headers.get("upload-offset")).toBe("400");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(await store.get(key)).toBeNull();
  });

  it("a remembered upload the server no longer has is forgotten and started again", async () => {
    const server = tusServer();
    const { client, calls } = makeClient(server.handler);
    const store = new MemoryFingerprintStore();
    const bytes = data(50);
    await store.set(client.uploads.fingerprintOf(T, I, bytes, "x.bin"), "up-gone");
    const result = await client.uploads.resumable(T, I, bytes, { filename: "x.bin", store });
    expect(result.uploadId).toBe("up-1");
    expect(calls.map((c) => c.method)).toEqual(["HEAD", "POST", "PATCH"]);
  });

  it("a 409 (the offset moved) re-reads the offset and goes on", async () => {
    let first = true;
    const server = tusServer({
      onPatch: (_call, upload) => {
        if (first) {
          first = false;
          upload.offset = 20; // somebody else appended
          return errorResponse(409, "upload_offset_mismatch");
        }
        return undefined;
      },
    });
    const { client, calls } = makeClient(server.handler);
    const result = await client.uploads.resumable(T, I, data(50), {
      filename: "y.bin",
      fingerprint: false,
    });
    expect(result.fileId).toBe("file-of-up-1");
    expect(calls.map((c) => c.method)).toEqual(["POST", "PATCH", "HEAD", "PATCH"]);
    expect(calls[3]?.headers.get("upload-offset")).toBe("20");
  });

  it("other errors propagate; a stream or a nameless source is refused up front", async () => {
    const server = tusServer({ onPatch: () => errorResponse(423, "vola_locked") });
    const { client } = makeClient(server.handler);
    await expect(
      client.uploads.resumable(T, I, data(5), { filename: "z", fingerprint: false }),
    ).rejects.toMatchObject({ status: 423 });
    await expect(
      client.uploads.resumable(T, I, new ReadableStream() as never, { filename: "z" }),
    ).rejects.toMatchObject({ status: 0 });
    await expect(client.uploads.resumable(T, I, new Blob(["x"]))).rejects.toMatchObject({
      status: 0,
    });
  });

  it("uses a File's name and lastModified in the fingerprint; a custom fingerprint and a Storage store work", async () => {
    const server = tusServer();
    const { client } = makeClient(server.handler);
    const file = new File([data(10)], "f.bin", { lastModified: 1234 });
    expect(client.uploads.fingerprintOf(T, I, file, "f.bin")).toBe(
      `vola-upload:http://vola.test/vola:${T}/${I}:f.bin:10:1234`,
    );
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    } as unknown as Storage;
    const store = storageFingerprintStore(storage);
    const result = await client.uploads.resumable(T, I, file, { fingerprint: "custom", store });
    expect(result.fileId).toBe("file-of-up-1");
    expect(map.size).toBe(0);
  });
});

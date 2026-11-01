import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BlobNotFoundError,
  FilesystemBackend,
  FileTooLargeError,
  InvalidDerivedNameError,
  InvalidHashError,
} from "../src/storage/index.js";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const readAll = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};
/** A readable that yields `data` in small pieces, like a network body. */
const chunked = (data: Buffer, size = 7) =>
  Readable.from(
    (function* () {
      for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
    })(),
  );

let root: string;
let storage: FilesystemBackend;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vola-storage-"));
  // The directory does not exist yet: the backend creates blobs/ and tmp/ itself.
  storage = new FilesystemBackend(join(root, "store"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FilesystemBackend.put", () => {
  it("stores a blob under blobs/aa/bb/cc/<sha256> with its hash and size, and leaves tmp/ empty", async () => {
    const data = randomBytes(10_000);
    const hash = sha256(data);
    const stored = await storage.put(chunked(data));
    expect(stored).toEqual({
      hash,
      size: data.length,
      deduplicated: false,
      path: join(storage.blobsDir, hash.slice(0, 2), hash.slice(2, 4), hash.slice(4, 6), hash),
    });
    expect(await readFile(stored.path)).toEqual(data);
    expect((await stat(stored.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(storage.tmpDir)).toEqual([]);
    expect(await storage.exists(hash)).toBe(true);
    expect(await storage.stat(hash)).toEqual({ size: data.length, path: stored.path });
    expect(storage.blobPath(hash)).toBe(stored.path);
  });

  it("deduplicates: the same bytes are one blob and the second temp file is dropped", async () => {
    const data = Buffer.from("twice uploaded content");
    const first = await storage.put(Readable.from([data]));
    const second = await storage.put(chunked(data, 3));
    expect(first.deduplicated).toBe(false);
    expect(second).toEqual({ ...first, deduplicated: true });
    expect(await readdir(storage.tmpDir)).toEqual([]);
  });

  it("never overwrites an existing blob", async () => {
    const data = Buffer.from("original bytes of this blob");
    const stored = await storage.put(Readable.from([data]));
    // Simulate a blob whose bytes differ from what its name says: a later put of the real
    // content must not touch it (the store does not rewrite, it only adds).
    await writeFile(stored.path, "tampered");
    const again = await storage.put(Readable.from([data]));
    expect(again.deduplicated).toBe(true);
    expect(await readFile(stored.path, "utf8")).toBe("tampered");
  });

  it("stores the empty file too", async () => {
    const stored = await storage.put(Readable.from([]));
    expect(stored.size).toBe(0);
    expect(stored.hash).toBe(sha256(Buffer.alloc(0)));
    expect(await readAll(await storage.open(stored.hash))).toHaveLength(0);
  });

  it("writes atomically: a stream that fails midway leaves neither a temp file nor a blob", async () => {
    const before = await readdir(storage.blobsDir, { recursive: true });
    const failing = new Readable({
      read() {
        this.push(Buffer.from("some bytes"));
        this.destroy(new Error("connection reset"));
      },
    });
    await expect(storage.put(failing)).rejects.toThrow("connection reset");
    expect(await readdir(storage.tmpDir)).toEqual([]);
    expect(await readdir(storage.blobsDir, { recursive: true })).toEqual(before);
  });

  it("enforces maxBytes with FileTooLargeError and cleans up", async () => {
    await expect(storage.put(chunked(randomBytes(1000)), { maxBytes: 999 })).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    expect(await readdir(storage.tmpDir)).toEqual([]);
    const exact = await storage.put(chunked(randomBytes(1000)), { maxBytes: 1000 });
    expect(exact.size).toBe(1000);
  });

  it("stage / commit / discard: a discarded stage leaves nothing, a committed one is the blob", async () => {
    const data = randomBytes(500);
    const staged = await storage.stage(chunked(data));
    expect(staged.hash).toBe(sha256(data));
    expect(staged.tmpPath.startsWith(storage.tmpDir)).toBe(true);
    expect(await storage.exists(staged.hash)).toBe(false);
    await storage.discard(staged);
    expect(await readdir(storage.tmpDir)).toEqual([]);
    expect(await storage.exists(staged.hash)).toBe(false);

    const again = await storage.stage(chunked(data));
    const stored = await storage.commit(again);
    expect(stored).toMatchObject({ hash: staged.hash, size: 500, deduplicated: false });
    expect(await readAll(await storage.open(staged.hash))).toEqual(data);
  });
});

describe("FilesystemBackend.open", () => {
  it("streams the whole blob or an inclusive byte range", async () => {
    const data = Buffer.from("0123456789abcdef");
    const { hash } = await storage.put(Readable.from([data]));
    expect(await readAll(await storage.open(hash))).toEqual(data);
    expect((await readAll(await storage.open(hash, { start: 0, end: 3 }))).toString()).toBe("0123");
    expect((await readAll(await storage.open(hash, { start: 10, end: 15 }))).toString()).toBe(
      "abcdef",
    );
    expect((await readAll(await storage.open(hash, { start: 5, end: 5 }))).toString()).toBe("5");
    await expect(storage.open(hash, { start: 0, end: 16 })).rejects.toBeInstanceOf(RangeError);
    await expect(storage.open(hash, { start: 3, end: 2 })).rejects.toBeInstanceOf(RangeError);
  });

  it("throws BlobNotFoundError for a hash that is not stored", async () => {
    const missing = "0".repeat(64);
    await expect(storage.open(missing)).rejects.toBeInstanceOf(BlobNotFoundError);
    expect(await storage.stat(missing)).toBeNull();
    expect(await storage.exists(missing)).toBe(false);
  });
});

describe("path traversal protection", () => {
  it("refuses anything but a lowercase sha256 hex as a hash", async () => {
    for (const bad of [
      "../../etc/passwd",
      `${"a".repeat(62)}/.`,
      "A".repeat(64),
      "g".repeat(64),
      "a".repeat(63),
      "",
    ]) {
      expect(() => storage.blobPath(bad), bad).toThrow(InvalidHashError);
      await expect(storage.open(bad), bad).rejects.toBeInstanceOf(InvalidHashError);
      await expect(storage.remove(bad), bad).rejects.toBeInstanceOf(InvalidHashError);
    }
  });

  it("refuses derived names that are not plain filename tokens", async () => {
    const { hash } = await storage.put(Readable.from([Buffer.from("derived host")]));
    for (const bad of ["../x", "/etc/passwd", ".hidden", "a/b", "with space", "UPPER", ""]) {
      await expect(storage.putDerived(hash, bad, Buffer.from("x")), bad).rejects.toBeInstanceOf(
        InvalidDerivedNameError,
      );
      await expect(storage.openDerived(hash, bad), bad).rejects.toBeInstanceOf(
        InvalidDerivedNameError,
      );
    }
  });
});

describe("derived files and remove", () => {
  it("keeps derived files next to the blob, replaces them, and removes them with the blob", async () => {
    const { hash, path } = await storage.put(Readable.from([Buffer.from("an image")]));
    const thumb = await storage.putDerived(hash, "thumb.128.center.webp", Buffer.from("v1"));
    expect(thumb).toBe(`${path}.thumb.128.center.webp`);
    expect(
      (await readAll(await storage.openDerived(hash, "thumb.128.center.webp"))).toString(),
    ).toBe("v1");
    await storage.putDerived(hash, "thumb.128.center.webp", Readable.from([Buffer.from("v2")]));
    expect(
      (await readAll(await storage.openDerived(hash, "thumb.128.center.webp"))).toString(),
    ).toBe("v2");
    expect(await storage.statDerived(hash, "thumb.128.center.webp")).toEqual({
      size: 2,
      path: thumb,
    });
    await storage.putDerived(hash, "ocr.txt", Buffer.from("text"));
    expect(await readdir(storage.tmpDir)).toEqual([]);

    expect(await storage.remove(hash)).toBe(true);
    expect(await storage.exists(hash)).toBe(false);
    expect(await storage.statDerived(hash, "thumb.128.center.webp")).toBeNull();
    expect(await storage.statDerived(hash, "ocr.txt")).toBeNull();
    await expect(storage.openDerived(hash, "ocr.txt")).rejects.toBeInstanceOf(BlobNotFoundError);
    // Idempotent.
    expect(await storage.remove(hash)).toBe(false);
  });

  it("refuses a derived file for a blob that does not exist", async () => {
    await expect(
      storage.putDerived("f".repeat(64), "thumb.webp", Buffer.from("x")),
    ).rejects.toBeInstanceOf(BlobNotFoundError);
    expect(await storage.statDerived("f".repeat(64), "thumb.webp")).toBeNull();
  });

  it("does not remove a neighbour that merely shares a prefix", async () => {
    const a = await storage.put(Readable.from([Buffer.from("neighbour a")]));
    // Put a fake sibling whose name starts with the hash but is not a derived file of it
    // (`<hash>x` has no dot): remove() must leave it alone.
    const fake = `${a.path}x`;
    await writeFile(fake, "keep");
    await storage.remove(a.hash);
    expect(await readFile(fake, "utf8")).toBe("keep");
    await rm(fake);
  });
});

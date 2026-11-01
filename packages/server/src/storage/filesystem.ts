import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertDerivedName,
  assertHash,
  BlobNotFoundError,
  type BlobStat,
  type ByteSpan,
  FileTooLargeError,
  type PutOptions,
  type StagedBlob,
  type StorageBackend,
  type StoredBlob,
} from "./backend.js";

/** `ENOENT` and friends carry a `code`. */
const errno = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

/** Errors a filesystem without (usable) hard links answers `link()` with. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "ENOSYS"]);

/**
 * Content-addressable storage on the local filesystem:
 *
 * ```
 * <root>/blobs/aa/bb/cc/<sha256>              the blob (no extension: the name is not data)
 * <root>/blobs/aa/bb/cc/<sha256>.<derived>    derived files (thumbnails, …) of that blob
 * <root>/tmp/<uuid>                           an upload in flight
 * ```
 *
 * A blob is written to `tmp/` with the SHA-256 computed on the way, `fsync`ed, and then
 * hard-linked into its shard — `link()` fails with `EEXIST` when the blob is already there, so
 * an existing blob is never overwritten and two concurrent uploads of the same bytes cannot
 * corrupt each other (on a filesystem without hard links the fallback is an existence check
 * plus `rename`). Every path is derived from a validated hash, so no input can escape `root`.
 */
export class FilesystemBackend implements StorageBackend {
  readonly root: string;
  readonly blobsDir: string;
  readonly tmpDir: string;
  private ready: Promise<void> | undefined;

  constructor(root: string) {
    this.root = resolve(root);
    this.blobsDir = join(this.root, "blobs");
    this.tmpDir = join(this.root, "tmp");
  }

  /** Creates `blobs/` and `tmp/` (once). */
  init(): Promise<void> {
    this.ready ??= Promise.all([
      mkdir(this.blobsDir, { recursive: true }),
      mkdir(this.tmpDir, { recursive: true }),
    ]).then(() => undefined);
    return this.ready;
  }

  private shardDir(hash: string): string {
    return join(this.blobsDir, hash.slice(0, 2), hash.slice(2, 4), hash.slice(4, 6));
  }

  blobPath(hash: string): string {
    const path = join(this.shardDir(assertHash(hash)), hash);
    if (!path.startsWith(this.blobsDir + sep)) throw new Error("blob path escapes the store");
    return path;
  }

  derivedPath(hash: string, name: string): string {
    return `${this.blobPath(hash)}.${assertDerivedName(name)}`;
  }

  async stage(stream: Readable, options: PutOptions = {}): Promise<StagedBlob> {
    await this.init();
    const tmpPath = join(this.tmpDir, randomUUID());
    const hasher = createHash("sha256");
    let size = 0;
    const max = options.maxBytes;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (max !== undefined && size > max) {
          callback(new FileTooLargeError(max));
          return;
        }
        hasher.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(tmpPath, { flags: "wx", mode: 0o600 }));
      await fsyncFile(tmpPath);
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
    return { hash: hasher.digest("hex"), size, tmpPath };
  }

  async commit(staged: StagedBlob): Promise<StoredBlob> {
    const target = this.blobPath(staged.hash);
    const shard = dirname(target);
    await mkdir(shard, { recursive: true });
    let deduplicated: boolean;
    try {
      await link(staged.tmpPath, target);
      deduplicated = false;
    } catch (error) {
      const code = errno(error);
      if (code === "EEXIST") {
        deduplicated = true;
      } else if (code && NO_HARD_LINKS.has(code)) {
        if (await this.stat(staged.hash)) {
          deduplicated = true;
        } else {
          await rename(staged.tmpPath, target);
          deduplicated = false;
        }
      } else {
        await rm(staged.tmpPath, { force: true });
        throw error;
      }
    }
    await rm(staged.tmpPath, { force: true });
    if (!deduplicated) await fsyncDir(shard);
    return { hash: staged.hash, size: staged.size, path: target, deduplicated };
  }

  async discard(staged: StagedBlob): Promise<void> {
    await rm(staged.tmpPath, { force: true });
  }

  async put(stream: Readable, options: PutOptions = {}): Promise<StoredBlob> {
    const staged = await this.stage(stream, options);
    try {
      return await this.commit(staged);
    } catch (error) {
      await this.discard(staged);
      throw error;
    }
  }

  async open(hash: string, range?: ByteSpan): Promise<Readable> {
    const found = await this.stat(hash);
    if (!found) throw new BlobNotFoundError(hash);
    if (range) {
      if (range.start < 0 || range.end < range.start || range.end >= found.size) {
        throw new RangeError(
          `range ${range.start}-${range.end} outside a blob of ${found.size} bytes`,
        );
      }
      return createReadStream(found.path, { start: range.start, end: range.end });
    }
    return createReadStream(found.path);
  }

  async stat(hash: string): Promise<BlobStat | null> {
    return statPath(this.blobPath(hash));
  }

  async exists(hash: string): Promise<boolean> {
    return (await this.stat(hash)) !== null;
  }

  async remove(hash: string): Promise<boolean> {
    const path = this.blobPath(hash);
    let removed = false;
    try {
      await unlink(path);
      removed = true;
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
    // Derived files sit next to the blob as `<hash>.<name>`.
    let siblings: string[] = [];
    try {
      siblings = await readdir(dirname(path));
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
    for (const entry of siblings) {
      if (entry.startsWith(`${hash}.`)) await rm(join(dirname(path), entry), { force: true });
    }
    return removed;
  }

  async putDerived(hash: string, name: string, data: Buffer | Readable): Promise<string> {
    const target = this.derivedPath(hash, name);
    if (!(await this.exists(hash))) throw new BlobNotFoundError(hash);
    await this.init();
    const tmpPath = join(this.tmpDir, randomUUID());
    try {
      const source = Buffer.isBuffer(data) ? Readable.from([data]) : data;
      await pipeline(source, createWriteStream(tmpPath, { flags: "wx", mode: 0o600 }));
      await fsyncFile(tmpPath);
      // A derived file MAY be regenerated: rename replaces atomically.
      await rename(tmpPath, target);
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
    return target;
  }

  async openDerived(hash: string, name: string): Promise<Readable> {
    const found = await this.statDerived(hash, name);
    if (!found) throw new BlobNotFoundError(hash, name);
    return createReadStream(found.path);
  }

  async statDerived(hash: string, name: string): Promise<BlobStat | null> {
    return statPath(this.derivedPath(hash, name));
  }
}

async function statPath(path: string): Promise<BlobStat | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size, path } : null;
  } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

/** Flushes a written file to the device before it is linked into the store. */
async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Makes the new directory entry durable; best effort (not every filesystem allows it). */
async function fsyncDir(dir: string): Promise<void> {
  try {
    await fsyncFile(dir);
  } catch {
    // Not supported here: the data itself was already fsynced.
  }
}

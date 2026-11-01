import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { type Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { headSniffer, type StagedUpload } from "../services/files.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PART_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.part$/;

/** The PATCH body carried more bytes than the upload has room for (`offset + body > length`). */
export class PartOverflowError extends Error {
  constructor(readonly room: number) {
    super(`the body exceeds the ${room} bytes left in the upload`);
    this.name = "PartOverflowError";
  }
}

export interface AppendResult {
  /** Bytes durably on disk after the append (the new `Upload-Offset`), after `fsync`. */
  size: number;
  /**
   * The source stream failed (the client went away mid-body). What arrived before that is
   * on disk and counted in `size`; the caller commits the offset and then reports the error.
   */
  error: Error | null;
}

/**
 * The partial files of resumable uploads: `<dir>/<upload id>.part`, one per upload, written
 * strictly sequentially at the committed offset. Nothing here knows about segment sizes —
 * a PATCH of any length is appended as it comes (`append`), and the encrypted upload of
 * plan 6.3 writes its sealed segments through `writeAt` / `truncate` and keeps the sealed,
 * incomplete last segment in `<dir>/<upload id>.partial` (`writePartial` / `readPartial`),
 * so a `.part` of an encrypted upload is ciphertext from its first byte. `dir` sits under
 * the storage root so a finished part can be hard-linked into the blob store instead of
 * copied.
 */
export class PartStore {
  readonly dir: string;
  private ready: Promise<void> | undefined;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  /** Creates the directory (once). */
  init(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }

  /** Where the part file of `uploadId` is (or would be); the id is validated, so no input escapes `dir`. */
  path(uploadId: string): string {
    if (!UUID_RE.test(uploadId)) throw new Error(`invalid upload id: ${JSON.stringify(uploadId)}`);
    const path = join(this.dir, `${uploadId}.part`);
    if (!path.startsWith(this.dir + sep)) throw new Error("part path escapes the store");
    return path;
  }

  /** An empty part file (fails when one exists already). */
  async create(uploadId: string): Promise<void> {
    await this.init();
    const handle = await open(this.path(uploadId), "wx", 0o600);
    await handle.close();
  }

  /** Bytes on disk, or `null` when there is no part file. */
  async size(uploadId: string): Promise<number | null> {
    try {
      return (await stat(this.path(uploadId))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Appends `stream` at `offset`: anything past `offset` (a previous PATCH that died after
   * writing but before committing) is cut off first, the bytes are written to disk as they
   * come and `fsync`ed, and the durable size is returned. A body longer than `room` is a
   * `PartOverflowError` — the file is cut back to `offset`, as if the PATCH never happened,
   * and the rest of the body is drained (never destroyed: the client must still get its
   * answer). A source that fails mid-way is reported in `error`, with what arrived counted.
   */
  async append(
    uploadId: string,
    offset: number,
    stream: Readable,
    room: number,
  ): Promise<AppendResult> {
    const path = this.path(uploadId);
    const handle = await open(path, "r+");
    try {
      await handle.truncate(offset);
      let position = offset;
      let received = 0;
      let overflow = false;
      let error: Error | null = null;
      try {
        // `destroyOnReturn: false`: breaking out on overflow must not kill the request socket.
        for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
          const bytes = chunk as Buffer;
          received += bytes.length;
          if (received > room) {
            overflow = true;
            break;
          }
          await handle.write(bytes, 0, bytes.length, position);
          position += bytes.length;
        }
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }
      if (overflow) {
        stream.resume();
        await handle.truncate(offset);
        throw new PartOverflowError(room);
      }
      await handle.sync();
      const size = (await handle.stat()).size;
      return { size, error };
    } finally {
      await handle.close();
    }
  }

  /** Removes the part file (and the sealed partial segment, if any); nothing happens when there is none. */
  async remove(uploadId: string): Promise<void> {
    await rm(this.path(uploadId), { force: true });
    await rm(this.partialPath(uploadId), { force: true });
  }

  // --- the encrypted upload (plan 6.3) ---------------------------------------------------

  /** Where the sealed incomplete segment of `uploadId` is (or would be). */
  partialPath(uploadId: string): string {
    return `${this.path(uploadId)}ial`; // `<id>.partial`
  }

  /** Cuts the part file back to `size` bytes (a PATCH that died after writing but before committing). */
  async truncate(uploadId: string, size: number): Promise<void> {
    const handle = await open(this.path(uploadId), "r+");
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
  }

  /**
   * A handle for writing sealed segments at their offsets; `fsync` and close through
   * `handle.sync()` / `handle.close()` (the caller owns it).
   */
  async openForWrite(uploadId: string): Promise<import("node:fs/promises").FileHandle> {
    return open(this.path(uploadId), "r+");
  }

  /** Writes `data` at `offset` of the part file and `fsync`s (the header of an encrypted upload). */
  async writeAt(uploadId: string, offset: number, data: Buffer): Promise<void> {
    const handle = await open(this.path(uploadId), "r+");
    try {
      await handle.write(data, 0, data.length, offset);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** The sealed incomplete segment, or `null` when there is none. */
  async readPartial(uploadId: string): Promise<Buffer | null> {
    try {
      return await readFile(this.partialPath(uploadId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Replaces the sealed incomplete segment atomically (write to a sibling, `fsync`, rename). */
  async writePartial(uploadId: string, sealed: Buffer): Promise<void> {
    const target = this.partialPath(uploadId);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, sealed, { mode: 0o600, flag: "w" });
    const handle = await open(tmp, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
  }

  /** Removes the sealed incomplete segment; nothing happens when there is none. */
  async removePartial(uploadId: string): Promise<void> {
    await rm(this.partialPath(uploadId), { force: true });
    await rm(`${this.partialPath(uploadId)}.tmp`, { force: true });
  }

  /**
   * Reads the finished part once to compute what `finalizeUpload` needs — SHA-256, size and
   * the sniffing head — and hands the file over as the staged blob: `commit` links it into
   * the store and removes it here, `discard` removes it. No copy.
   */
  async stage(uploadId: string): Promise<StagedUpload> {
    const path = this.path(uploadId);
    const hasher = createHash("sha256");
    const sniffer = headSniffer();
    let size = 0;
    await pipeline(
      createReadStream(path),
      sniffer.transform,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          hasher.update(chunk);
          size += chunk.length;
          callback();
        },
      }),
    );
    return { staged: { hash: hasher.digest("hex"), size, tmpPath: path }, head: sniffer.head() };
  }

  /** The upload ids that have a part file, with the time each was last written. */
  async list(): Promise<{ uploadId: string; modifiedAt: Date }[]> {
    await this.init();
    const out: { uploadId: string; modifiedAt: Date }[] = [];
    for (const entry of await readdir(this.dir)) {
      const match = PART_FILE_RE.exec(entry);
      if (!match?.[1]) continue;
      try {
        out.push({ uploadId: match[1], modifiedAt: (await stat(join(this.dir, entry))).mtime });
      } catch {
        // removed meanwhile
      }
    }
    return out;
  }
}

/**
 * The `JSV` blob format, version 1 — one encrypted file on disk (`docs/CRYPTO.md` has the
 * same thing byte by byte, with the reasoning). Segmented AES-256-GCM under the file key
 * `FK`, so a `Range` request decrypts only the segments it touches and memory stays constant
 * per request:
 *
 * ```
 * header (24 B, plaintext, in the AAD of every segment)
 *   0   3  magic "JSV"
 *   3   1  version = 1
 *   4   4  segment_size S, u32 BE (default 1 MiB, 64 KiB ≤ S ≤ 64 MiB)
 *   8   8  nonce_prefix, random per file
 *  16   8  plaintext_length L, u64 BE — or 0xFFFF_FFFF_FFFF_FFFF: "deferred" (see below)
 * segment i (i = 0 … n−1, n = max(1, ceil(L / S)))
 *   ct_i ∥ tag_i = AES-256-GCM(FK, nonce_i, plaintext[i·S … (i+1)·S), aad_i)
 *   nonce_i = nonce_prefix ∥ i (u32 BE)                       — derived, not stored
 *   aad_i   = header ∥ file_id ∥ i (u32 BE) ∥ last (u8)       — plus L (u64 BE) when last = 1
 * ```
 *
 * A file of 0 bytes is one empty segment (its tag alone). The plaintext length when it is
 * NOT known up front (a multipart upload is a stream): the header says "deferred" and L is
 * DERIVED from the ciphertext length when reading — n = ceil((|blob| − 24) / (S + 16)),
 * L = (n − 1)·S + |last segment| − 16 — and then authenticated by the AAD of the last
 * segment, which carries `last = 1` and L. That is what makes every edit fail: a truncated
 * blob makes an earlier segment "last" (its tag was computed with last = 0, without L); an
 * appended segment turns the real last one into a middle one (same failure) and has no valid
 * tag of its own; reordered segments fail on the index; a blob copied onto another row fails
 * on the file id; a changed header fails everywhere. A header that does carry L (the length
 * was known, e.g. a resumable upload) is checked against the ciphertext length before a
 * single segment is read.
 *
 * `version` is read and DISPATCHED (`decryptors`), unlike the Notes model this comes from
 * where it was only written: a version nobody knows is an `IntegrityError`.
 */
import { randomBytes } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { assertKey, gcmDecrypt, gcmEncrypt, TAG_BYTES } from "./aead.js";
import { IntegrityError } from "./errors.js";

export const JSV_MAGIC = Buffer.from("JSV", "ascii");
export const JSV_VERSION = 1;
export const HEADER_BYTES = 24;
export const NONCE_PREFIX_BYTES = 8;
export const DEFAULT_SEGMENT_BYTES = 1024 * 1024;
export const MIN_SEGMENT_BYTES = 64 * 1024;
/** A reader buffers one segment: the cap bounds what a hostile header can make it allocate. */
export const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
/** The `plaintext_length` that means "derive it from the ciphertext length". */
export const DEFERRED_LENGTH = 0xffff_ffff_ffff_ffffn;
/** Indices are u32: more segments than that and the nonce would repeat. */
export const MAX_SEGMENTS = 0x1_0000_0000;
export { TAG_BYTES };

/** The parsed header of a blob. */
export interface JsvHeader {
  version: number;
  segmentSize: number;
  noncePrefix: Buffer;
  /** `null`: deferred — the length is derived from the ciphertext length. */
  plaintextLength: number | null;
  /** The 24 header bytes as stored (what goes into every AAD). */
  raw: Buffer;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}
function u64(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(value);
  return b;
}

/** Throws unless `size` is a segment size this format accepts. */
export function assertSegmentSize(size: number): number {
  if (
    !Number.isInteger(size) ||
    size < MIN_SEGMENT_BYTES ||
    size > MAX_SEGMENT_BYTES ||
    size % 1024 !== 0
  ) {
    throw new RangeError(
      `segment size must be a multiple of 1024 between ${MIN_SEGMENT_BYTES} and ${MAX_SEGMENT_BYTES} bytes`,
    );
  }
  return size;
}

/** The 24 header bytes. `plaintextLength` `null` writes the deferred marker. */
export function encodeHeader(input: {
  segmentSize: number;
  noncePrefix: Buffer;
  plaintextLength: number | null;
}): Buffer {
  if (input.noncePrefix.length !== NONCE_PREFIX_BYTES) {
    throw new RangeError(`nonce prefix must be ${NONCE_PREFIX_BYTES} bytes`);
  }
  const length =
    input.plaintextLength === null ? DEFERRED_LENGTH : BigInt(assertLength(input.plaintextLength));
  return Buffer.concat([
    JSV_MAGIC,
    Buffer.from([JSV_VERSION]),
    u32(assertSegmentSize(input.segmentSize)),
    input.noncePrefix,
    u64(length),
  ]);
}

function assertLength(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("plaintext length must be a non-negative safe integer");
  }
  return length;
}

/**
 * Parses the first 24 bytes of a blob. `IntegrityError` for a short buffer, a wrong magic,
 * an unknown version or a segment size outside the accepted range — a blob that cannot be
 * read is reported exactly like one that does not authenticate.
 */
export function parseHeader(buffer: Buffer): JsvHeader {
  if (buffer.length < HEADER_BYTES) throw new IntegrityError("header too short");
  const raw = Buffer.from(buffer.subarray(0, HEADER_BYTES));
  if (!raw.subarray(0, 3).equals(JSV_MAGIC)) throw new IntegrityError("not a JSV blob");
  const version = raw.readUInt8(3);
  if (!(version in decryptors)) throw new IntegrityError(`unknown JSV version ${version}`);
  const segmentSize = raw.readUInt32BE(4);
  try {
    assertSegmentSize(segmentSize);
  } catch {
    throw new IntegrityError(`segment size ${segmentSize} outside the accepted range`);
  }
  const noncePrefix = Buffer.from(raw.subarray(8, 16));
  const length = raw.readBigUInt64BE(16);
  let plaintextLength: number | null;
  if (length === DEFERRED_LENGTH) plaintextLength = null;
  else if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IntegrityError("plaintext length beyond a safe integer");
  } else plaintextLength = Number(length);
  return { version, segmentSize, noncePrefix, plaintextLength, raw };
}

/** `nonce_prefix ∥ i`. */
export function segmentNonce(noncePrefix: Buffer, index: number): Buffer {
  return Buffer.concat([noncePrefix, u32(index)]);
}

/** `header ∥ file_id ∥ i ∥ last` (∥ L when last). */
export function segmentAad(
  header: Buffer,
  fileId: string,
  index: number,
  last: boolean,
  plaintextLength: number,
): Buffer {
  const parts = [header, Buffer.from(fileId, "utf8"), u32(index), Buffer.from([last ? 1 : 0])];
  if (last) parts.push(u64(BigInt(plaintextLength)));
  return Buffer.concat(parts);
}

/** How many segments a plaintext of `length` bytes takes: at least one. */
export function segmentCount(length: number, segmentSize: number): number {
  return Math.max(1, Math.ceil(length / segmentSize));
}

/** The ciphertext length (`|blob|`) of a plaintext of `length` bytes. */
export function ciphertextLengthFor(length: number, segmentSize: number): number {
  return HEADER_BYTES + length + segmentCount(length, segmentSize) * TAG_BYTES;
}

/**
 * The plaintext length a blob of `ciphertextLength` bytes holds — the header's when it has
 * one (checked against the blob), derived otherwise. `IntegrityError` when the arithmetic
 * does not work out (a blob cut or padded mid-way).
 */
export function plaintextLengthOf(header: JsvHeader, ciphertextLength: number): number {
  const S = header.segmentSize;
  const body = ciphertextLength - HEADER_BYTES;
  if (body < TAG_BYTES) throw new IntegrityError("blob shorter than one segment");
  const n = Math.ceil(body / (S + TAG_BYTES));
  const lastCt = body - (n - 1) * (S + TAG_BYTES);
  if (lastCt < TAG_BYTES) throw new IntegrityError("last segment shorter than a tag");
  const derived = (n - 1) * S + (lastCt - TAG_BYTES);
  if (header.plaintextLength !== null && header.plaintextLength !== derived) {
    throw new IntegrityError("plaintext length in the header does not match the blob");
  }
  return derived;
}

/** The ciphertext bytes of segment `index` of a blob with `count` segments and `length` plaintext bytes. */
export function segmentCiphertextLength(
  header: Pick<JsvHeader, "segmentSize">,
  index: number,
  count: number,
  length: number,
): number {
  const S = header.segmentSize;
  return index < count - 1 ? S + TAG_BYTES : length - (count - 1) * S + TAG_BYTES;
}

/** Where segment `index` starts in the blob. */
export function segmentOffset(header: Pick<JsvHeader, "segmentSize">, index: number): number {
  return HEADER_BYTES + index * (header.segmentSize + TAG_BYTES);
}

/** A closed byte interval, `end` inclusive (the `Range` convention). */
export interface ByteSpan {
  start: number;
  end: number;
}

export interface CiphertextRange extends ByteSpan {
  firstSegment: number;
  lastSegment: number;
}

/**
 * The ciphertext span that holds plaintext bytes `plainStart … plainEnd` (inclusive): the
 * segments `floor(start/S) … floor(end/S)`, whole. `ciphertextLength` clamps the end to the
 * blob (the last segment is shorter than S + 16).
 */
export function ciphertextRangeFor(
  plainStart: number,
  plainEnd: number,
  header: Pick<JsvHeader, "segmentSize">,
  ciphertextLength?: number,
): CiphertextRange {
  if (plainStart < 0 || plainEnd < plainStart) throw new RangeError("bad plaintext range");
  const S = header.segmentSize;
  const firstSegment = Math.floor(plainStart / S);
  const lastSegment = Math.floor(plainEnd / S);
  const start = segmentOffset(header, firstSegment);
  let end = segmentOffset(header, lastSegment + 1) - 1;
  if (ciphertextLength !== undefined) end = Math.min(end, ciphertextLength - 1);
  return { start, end, firstSegment, lastSegment };
}

// --- encrypt -----------------------------------------------------------------------------

export interface EncryptOptions {
  /** Default 1 MiB; 64 KiB … 64 MiB, a multiple of 1024. */
  segmentSize?: number | undefined;
  /** The length when it is known up front (written into the header); otherwise deferred. */
  plaintextLength?: number | undefined;
  /** Tests only: a fixed nonce prefix. Production always draws a random one. */
  noncePrefix?: Buffer | undefined;
}

/**
 * Plaintext in, `JSV` blob out. A segment is emitted only once a byte BEYOND it has arrived
 * (or the input ended), so the last segment — which carries `last = 1` and the length — is
 * always known as such. Memory: one segment plus one input chunk. After `end`, `plaintextLength`
 * is the number of bytes that went through.
 */
export class EncryptStream extends Transform {
  readonly header: Buffer;
  readonly segmentSize: number;
  private readonly key: Buffer;
  private readonly fileId: string;
  private readonly noncePrefix: Buffer;
  private readonly expected: number | null;
  private readonly held: Buffer[] = [];
  private heldBytes = 0;
  private index = 0;
  private total = 0;
  private headerSent = false;

  constructor(fk: Buffer, fileId: string, options: EncryptOptions = {}) {
    super();
    this.key = Buffer.from(assertKey(fk, "file key"));
    if (!fileId) throw new TypeError("a file id is required");
    this.fileId = fileId;
    this.segmentSize = assertSegmentSize(options.segmentSize ?? DEFAULT_SEGMENT_BYTES);
    this.noncePrefix = options.noncePrefix ?? randomBytes(NONCE_PREFIX_BYTES);
    this.expected = options.plaintextLength === undefined ? null : options.plaintextLength;
    this.header = encodeHeader({
      segmentSize: this.segmentSize,
      noncePrefix: this.noncePrefix,
      plaintextLength: this.expected,
    });
  }

  /** Bytes encrypted so far; the plaintext length once the stream ended. */
  get plaintextLength(): number {
    return this.total;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.sendHeader();
      if (chunk.length > 0) {
        this.held.push(chunk);
        this.heldBytes += chunk.length;
        this.total += chunk.length;
        if (this.expected !== null && this.total > this.expected) {
          throw new RangeError("more plaintext than the declared length");
        }
      }
      // Strictly more than a segment: the segment is complete AND not the last one.
      while (this.heldBytes > this.segmentSize) {
        this.emitSegment(this.takeHeld(this.segmentSize), false);
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.sendHeader();
      if (this.expected !== null && this.total !== this.expected) {
        throw new RangeError(
          `plaintext length ${this.total} does not match the declared ${this.expected}`,
        );
      }
      this.emitSegment(this.takeHeld(this.heldBytes), true);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private sendHeader(): void {
    if (this.headerSent) return;
    this.headerSent = true;
    this.push(this.header);
  }

  /** Exactly `n` bytes off the front of the held chunks (`n` ≤ heldBytes). */
  private takeHeld(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.held[0] as Buffer;
      const need = n - filled;
      if (head.length <= need) {
        head.copy(out, filled);
        filled += head.length;
        this.held.shift();
      } else {
        head.copy(out, filled, 0, need);
        this.held[0] = head.subarray(need);
        filled += need;
      }
    }
    this.heldBytes -= n;
    return out;
  }

  private emitSegment(plain: Buffer, last: boolean): void {
    if (this.index >= MAX_SEGMENTS) throw new RangeError("too many segments for one file");
    const aad = segmentAad(this.header, this.fileId, this.index, last, this.total);
    this.push(gcmEncrypt(this.key, segmentNonce(this.noncePrefix, this.index), plain, aad));
    this.index++;
  }
}

/** The Transform that turns a plaintext stream into a `JSV` blob. */
export function createEncryptStream(
  fk: Buffer,
  fileId: string,
  options: EncryptOptions = {},
): EncryptStream {
  return new EncryptStream(fk, fileId, options);
}

/** Whole-buffer convenience (tests, small payloads). */
export async function encryptBuffer(
  fk: Buffer,
  fileId: string,
  plaintext: Buffer,
  options: EncryptOptions = {},
): Promise<Buffer> {
  const stream = createEncryptStream(fk, fileId, options);
  const out: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => out.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  stream.end(plaintext);
  await done;
  return Buffer.concat(out);
}

// --- decrypt -----------------------------------------------------------------------------

/**
 * Where the ciphertext comes from: the blob's size and a reader of one byte span of it — a
 * `StorageBackend` with the hash bound (`storage.open(hash, range)`), or a buffer in tests.
 * The crypto layer never touches storage itself.
 */
export interface CiphertextSource {
  size: number;
  open(range: ByteSpan): Promise<Readable>;
}

/** A `CiphertextSource` over a buffer. */
export function bufferSource(blob: Buffer): CiphertextSource {
  return {
    size: blob.length,
    async open(range) {
      return Readable.from([blob.subarray(range.start, range.end + 1)]);
    },
  };
}

export interface DecryptOptions {
  /** First plaintext byte wanted (inclusive). Default 0. */
  start?: number | undefined;
  /** Last plaintext byte wanted (inclusive). Default: the end of the file. */
  end?: number | undefined;
  /**
   * The plaintext length the caller knows (the row's `size`): checked against the blob
   * before a segment is read. This is what catches a deferred-length blob cut at an exact
   * segment boundary when the request's range never reaches the last segment — the segments
   * it does read authenticate on their own, but only the last one binds the total.
   */
  expectedLength?: number | undefined;
}

export interface DecryptedRange {
  /** The plaintext bytes `start … end`, segment by segment. */
  stream: Readable;
  header: JsvHeader;
  /** Of the whole file. */
  plaintextLength: number;
  /** The span actually asked for (clamped to the file). */
  start: number;
  end: number;
  /** The ciphertext span read for it. */
  ciphertext: CiphertextRange;
}

/** Pulls exactly the bytes asked for out of a Readable; `IntegrityError` when it ends early. */
class ExactReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly source: Readable) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async exactly(n: number): Promise<Buffer> {
    while (this.pendingBytes < n) {
      const next = await this.iterator.next();
      if (next.done) throw new IntegrityError("ciphertext ended before the segment did");
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
    }
    const joined =
      this.pending.length === 1 ? (this.pending[0] as Buffer) : Buffer.concat(this.pending);
    const out = joined.subarray(0, n);
    const rest = joined.subarray(n);
    this.pending = rest.length > 0 ? [rest] : [];
    this.pendingBytes = rest.length;
    return out;
  }

  /** Stops reading (an early close of the consumer). */
  close(): void {
    this.source.destroy();
  }
}

/** The v1 decryptor: `createDecryptStream` dispatches here by the header's version. */
async function decryptV1(
  fk: Buffer,
  fileId: string,
  source: CiphertextSource,
  header: JsvHeader,
  options: DecryptOptions,
): Promise<DecryptedRange> {
  // A private copy: the caller may zero its key buffer as soon as the stream is handed out,
  // while the segments after the first are decrypted lazily, as the stream is read.
  const key = Buffer.from(fk);
  const length = plaintextLengthOf(header, source.size);
  if (options.expectedLength !== undefined && options.expectedLength !== length) {
    throw new IntegrityError(
      `blob holds ${length} plaintext bytes, the file is recorded with ${options.expectedLength}`,
    );
  }
  const count = segmentCount(length, header.segmentSize);
  const start = options.start ?? 0;
  const end = options.end ?? length - 1;
  if (length > 0 && (start < 0 || end < start || end >= length)) {
    throw new RangeError(`plaintext range ${start}-${end} outside a file of ${length} bytes`);
  }
  // An empty file still verifies its one (empty) segment: a truncated blob must not pass.
  const range =
    length === 0
      ? { start: HEADER_BYTES, end: source.size - 1, firstSegment: 0, lastSegment: 0 }
      : ciphertextRangeFor(start, end, header, source.size);
  const ciphertext = await source.open({ start: range.start, end: range.end });
  const reader = new ExactReader(ciphertext);
  const S = header.segmentSize;

  const decryptSegment = async (index: number): Promise<Buffer> => {
    const sealed = await reader.exactly(segmentCiphertextLength(header, index, count, length));
    const last = index === count - 1;
    const plain = gcmDecrypt(
      key,
      segmentNonce(header.noncePrefix, index),
      sealed,
      segmentAad(header.raw, fileId, index, last, length),
    );
    if (plain.length !== (last ? length - (count - 1) * S : S)) {
      throw new IntegrityError("segment length mismatch");
    }
    // The part of this segment inside the requested range.
    const from = Math.max(start, index * S) - index * S;
    const to = Math.min(end, (index + 1) * S - 1) - index * S;
    return plain.subarray(from, to + 1);
  };

  // The first segment is verified BEFORE the stream is handed out: a wrong key, a tampered
  // header or a transplanted blob is a 409 to the client, not a connection that dies mid-body.
  let first: Buffer;
  try {
    first = length === 0 ? await verifyEmpty() : await decryptSegment(range.firstSegment);
  } catch (error) {
    reader.close();
    key.fill(0);
    throw error;
  }
  async function verifyEmpty(): Promise<Buffer> {
    const sealed = await reader.exactly(TAG_BYTES);
    gcmDecrypt(
      key,
      segmentNonce(header.noncePrefix, 0),
      sealed,
      segmentAad(header.raw, fileId, 0, true, 0),
    );
    return Buffer.alloc(0);
  }

  async function* generate(): AsyncGenerator<Buffer> {
    try {
      if (first.length > 0) yield first;
      for (let index = range.firstSegment + 1; index <= range.lastSegment; index++) {
        const plain = await decryptSegment(index);
        if (plain.length > 0) yield plain;
      }
    } finally {
      reader.close();
      key.fill(0);
    }
  }
  return {
    stream: Readable.from(generate(), { objectMode: false }),
    header,
    plaintextLength: length,
    start: length === 0 ? 0 : start,
    end: length === 0 ? -1 : end,
    ciphertext: range,
  };
}

type Decryptor = typeof decryptV1;

/** The readers by header version — the dispatch table a new format version joins. */
const decryptors: Record<number, Decryptor> = { [JSV_VERSION]: decryptV1 };

/**
 * Opens plaintext bytes `start … end` of the blob behind `source`: reads the header (24
 * bytes), dispatches on its version, verifies the first segment, and answers a stream that
 * decrypts the remaining needed segments as it is read — `source.open` is called once for the
 * header and once for the ciphertext span of exactly those segments. `IntegrityError` when
 * anything does not authenticate; `RangeError` for a range outside the file (callers check
 * ranges against the row's size first).
 */
export async function createDecryptStream(
  fk: Buffer,
  fileId: string,
  source: CiphertextSource,
  options: DecryptOptions = {},
): Promise<DecryptedRange> {
  assertKey(fk, "file key");
  if (source.size < HEADER_BYTES + TAG_BYTES) throw new IntegrityError("blob too short");
  const headerStream = await source.open({ start: 0, end: HEADER_BYTES - 1 });
  const header = parseHeader(await new ExactReader(headerStream).exactly(HEADER_BYTES));
  headerStream.destroy();
  const decrypt = decryptors[header.version];
  if (!decrypt) throw new IntegrityError(`unknown JSV version ${header.version}`);
  return decrypt(fk, fileId, source, header, options);
}

/** Whole-buffer convenience: the plaintext of `blob` (or `options` range of it). */
export async function decryptBuffer(
  fk: Buffer,
  fileId: string,
  blob: Buffer,
  options: DecryptOptions = {},
): Promise<Buffer> {
  const { stream } = await createDecryptStream(fk, fileId, bufferSource(blob), options);
  const out: Buffer[] = [];
  for await (const chunk of stream) out.push(chunk as Buffer);
  return Buffer.concat(out);
}

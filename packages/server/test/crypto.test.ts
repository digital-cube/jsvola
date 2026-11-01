import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  aeadOpen,
  aeadSeal,
  bufferSource,
  type CiphertextSource,
  ciphertextLengthFor,
  ciphertextRangeFor,
  createDecryptStream,
  createEncryptStream,
  DEFERRED_LENGTH,
  decryptBuffer,
  deriveTenantKek,
  EncryptionUnavailableError,
  encryptBuffer,
  generateKeyLine,
  HEADER_BYTES,
  INTEGRITY_MESSAGE,
  IntegrityError,
  KeyFile,
  KeyFileError,
  keyId,
  MIN_SEGMENT_BYTES,
  newFileKey,
  openMeta,
  parseHeader,
  parseKeyFile,
  plaintextLengthOf,
  StaticKeys,
  sealMeta,
  segmentNonce,
  TAG_BYTES,
  TENANT_FK_CT_BYTES,
  TenantWrapProvider,
  wrapAad,
} from "../src/crypto/index.js";

const S = MIN_SEGMENT_BYTES; // 64 KiB keeps the suite fast; the arithmetic is the same at 1 MiB
const FILE = randomUUID();
const fk = newFileKey();

/** A deterministic plaintext of `n` bytes whose every byte depends on its offset. */
function plaintext(n: number): Buffer {
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
  return out;
}

/** A source that records every span it was asked for. */
function spySource(blob: Buffer): CiphertextSource & { opened: { start: number; end: number }[] } {
  const inner = bufferSource(blob);
  const opened: { start: number; end: number }[] = [];
  return {
    opened,
    size: inner.size,
    open(range) {
      opened.push({ ...range });
      return inner.open(range);
    },
  };
}

const integrity = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(IntegrityError);
  await expect(promise).rejects.toThrow(INTEGRITY_MESSAGE);
};

describe("JSV v1 format", () => {
  it("writes the 24-byte header exactly as specified, with the deferred length by default", async () => {
    const blob = await encryptBuffer(fk, FILE, Buffer.from("hi"), { segmentSize: S });
    expect(blob.subarray(0, 3).toString("ascii")).toBe("JSV");
    expect(blob[3]).toBe(1);
    expect(blob.readUInt32BE(4)).toBe(S);
    expect(blob.readBigUInt64BE(16)).toBe(DEFERRED_LENGTH);
    expect(blob.length).toBe(HEADER_BYTES + 2 + TAG_BYTES);
    const header = parseHeader(blob);
    expect(header).toMatchObject({ version: 1, segmentSize: S, plaintextLength: null });
    expect(header.noncePrefix).toEqual(blob.subarray(8, 16));
    expect(plaintextLengthOf(header, blob.length)).toBe(2);
  });

  it("writes the real length into the header when it is known up front and checks it on read", async () => {
    const data = plaintext(S + 5);
    const blob = await encryptBuffer(fk, FILE, data, { segmentSize: S, plaintextLength: S + 5 });
    expect(Number(blob.readBigUInt64BE(16))).toBe(S + 5);
    expect(parseHeader(blob).plaintextLength).toBe(S + 5);
    expect(await decryptBuffer(fk, FILE, blob)).toEqual(data);
    // A declared length the stream does not deliver is refused at encryption time.
    await expect(
      encryptBuffer(fk, FILE, data, { segmentSize: S, plaintextLength: S + 6 }),
    ).rejects.toThrow(/does not match/);
    await expect(
      encryptBuffer(fk, FILE, data, { segmentSize: S, plaintextLength: 3 }),
    ).rejects.toThrow(/more plaintext/);
  });

  it.each([0, 1, S - 1, S, S + 1, 3 * S + 7])("round-trips a plaintext of %i bytes", async (n) => {
    const data = plaintext(n);
    const blob = await encryptBuffer(fk, FILE, data, { segmentSize: S });
    expect(blob.length).toBe(ciphertextLengthFor(n, S));
    expect(await decryptBuffer(fk, FILE, blob)).toEqual(data);
    // Chunk boundaries of the input do not matter.
    const chunked = createEncryptStream(fk, FILE, { segmentSize: S });
    const out: Buffer[] = [];
    chunked.on("data", (c: Buffer) => out.push(c));
    const pieces: Buffer[] = [];
    for (let at = 0; at < n; at += 7919) pieces.push(data.subarray(at, Math.min(n, at + 7919)));
    await pipeline(Readable.from(pieces), chunked);
    expect(chunked.plaintextLength).toBe(n);
    expect(await decryptBuffer(fk, FILE, Buffer.concat(out))).toEqual(data);
  });

  it("decrypts every range at the segment boundaries and reads only the segments it needs", async () => {
    const n = 3 * S + 7;
    const data = plaintext(n);
    const blob = await encryptBuffer(fk, FILE, data, { segmentSize: S });
    const header = parseHeader(blob);
    const cases: [number, number][] = [
      [0, 0],
      [0, S - 1],
      [S - 1, S],
      [S, S],
      [S, 2 * S - 1],
      [2 * S - 1, 2 * S + 1],
      [3 * S, 3 * S + 6],
      [3 * S + 6, 3 * S + 6],
      [5, 2 * S + 3],
      [0, n - 1],
    ];
    for (const [start, end] of cases) {
      const source = spySource(blob);
      const result = await createDecryptStream(fk, FILE, source, { start, end });
      const chunks: Buffer[] = [];
      for await (const c of result.stream) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks), `${start}-${end}`).toEqual(data.subarray(start, end + 1));
      expect(result.plaintextLength).toBe(n);
      const expected = ciphertextRangeFor(start, end, header, blob.length);
      expect(result.ciphertext).toEqual(expected);
      expect(expected.firstSegment).toBe(Math.floor(start / S));
      expect(expected.lastSegment).toBe(Math.floor(end / S));
      // One read of the header, one read of exactly the needed ciphertext span.
      expect(source.opened).toEqual([
        { start: 0, end: HEADER_BYTES - 1 },
        { start: expected.start, end: expected.end },
      ]);
      expect(expected.start).toBe(HEADER_BYTES + expected.firstSegment * (S + TAG_BYTES));
    }
  });

  it("refuses a range outside the file", async () => {
    const blob = await encryptBuffer(fk, FILE, plaintext(10), { segmentSize: S });
    await expect(decryptBuffer(fk, FILE, blob, { start: 0, end: 10 })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(decryptBuffer(fk, FILE, blob, { start: 4, end: 3 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it("fails on a truncated blob (a byte, a tag, a whole segment)", async () => {
    const data = plaintext(2 * S + 100);
    const blob = await encryptBuffer(fk, FILE, data, { segmentSize: S });
    await integrity(decryptBuffer(fk, FILE, blob.subarray(0, blob.length - 1)));
    await integrity(decryptBuffer(fk, FILE, blob.subarray(0, blob.length - TAG_BYTES)));
    // Without the last segment the second one becomes "last": its tag said otherwise.
    const twoSegments = blob.subarray(0, HEADER_BYTES + 2 * (S + TAG_BYTES));
    await integrity(decryptBuffer(fk, FILE, twoSegments));
    // A Range that never reaches the last segment cannot see a cut at an exact segment
    // boundary on its own (early segments do not bind the total) — the caller's known length does.
    expect(await decryptBuffer(fk, FILE, twoSegments, { start: 0, end: 10 })).toEqual(
      data.subarray(0, 11),
    );
    await integrity(
      decryptBuffer(fk, FILE, twoSegments, { start: 0, end: 10, expectedLength: 2 * S + 100 }),
    );
    expect(
      await decryptBuffer(fk, FILE, blob, { start: 0, end: 10, expectedLength: 2 * S + 100 }),
    ).toEqual(data.subarray(0, 11));
    // A deferred-length blob of exactly one empty segment: the tag alone, nothing to cut.
    const empty = await encryptBuffer(fk, FILE, Buffer.alloc(0), { segmentSize: S });
    await integrity(decryptBuffer(fk, FILE, empty.subarray(0, empty.length - 1)));
  });

  it("fails on an added segment", async () => {
    const data = plaintext(2 * S);
    const blob = await encryptBuffer(fk, FILE, data, { segmentSize: S });
    const first = blob.subarray(HEADER_BYTES, HEADER_BYTES + S + TAG_BYTES);
    await integrity(decryptBuffer(fk, FILE, Buffer.concat([blob, first])));
    // A copy of a valid segment of ANOTHER blob under the same key does not help either.
    const other = await encryptBuffer(fk, FILE, plaintext(S), { segmentSize: S });
    await integrity(decryptBuffer(fk, FILE, Buffer.concat([blob, other.subarray(HEADER_BYTES)])));
  });

  it("fails on reordered segments", async () => {
    const data = plaintext(3 * S);
    const blob = await encryptBuffer(fk, FILE, data, { segmentSize: S });
    const seg = (i: number) =>
      blob.subarray(HEADER_BYTES + i * (S + TAG_BYTES), HEADER_BYTES + (i + 1) * (S + TAG_BYTES));
    const swapped = Buffer.concat([blob.subarray(0, HEADER_BYTES), seg(1), seg(0), seg(2)]);
    await integrity(decryptBuffer(fk, FILE, swapped));
    // Reading only the swapped part: the index is in the AAD, so even a Range catches it.
    await integrity(decryptBuffer(fk, FILE, swapped, { start: 0, end: 3 }));
  });

  it("fails on a changed header (any byte) and on an unknown version", async () => {
    const blob = await encryptBuffer(fk, FILE, plaintext(100), { segmentSize: S });
    for (const at of [8, 15, 16, 23]) {
      const tampered = Buffer.from(blob);
      tampered[at] = (tampered[at] as number) ^ 0x01;
      await integrity(decryptBuffer(fk, FILE, tampered));
    }
    const bigger = Buffer.from(blob);
    bigger.writeUInt32BE(S * 2, 4); // another segment size: the arithmetic and the AAD both fail
    await integrity(decryptBuffer(fk, FILE, bigger));
    const v2 = Buffer.from(blob);
    v2[3] = 2;
    await integrity(decryptBuffer(fk, FILE, v2));
    expect(() => parseHeader(v2)).toThrow(IntegrityError);
    const v0 = Buffer.from(blob);
    v0[3] = 0;
    await integrity(decryptBuffer(fk, FILE, v0));
    const magic = Buffer.from(blob);
    magic[0] = 0x4b;
    await integrity(decryptBuffer(fk, FILE, magic));
  });

  it("fails on a blob transplanted onto another file id", async () => {
    const blob = await encryptBuffer(fk, FILE, plaintext(S + 1), { segmentSize: S });
    await integrity(decryptBuffer(fk, randomUUID(), blob));
    await integrity(decryptBuffer(newFileKey(), FILE, blob));
  });

  it("never reuses a nonce: a random prefix per file, the index per segment", async () => {
    const a = await encryptBuffer(fk, FILE, plaintext(S + 1), { segmentSize: S });
    const b = await encryptBuffer(fk, FILE, plaintext(S + 1), { segmentSize: S });
    expect(a.subarray(8, 16)).not.toEqual(b.subarray(8, 16));
    expect(a.subarray(HEADER_BYTES)).not.toEqual(b.subarray(HEADER_BYTES));
    const prefix = parseHeader(a).noncePrefix;
    const nonces = new Set<string>();
    for (let i = 0; i < 1000; i++) nonces.add(segmentNonce(prefix, i).toString("hex"));
    expect(nonces.size).toBe(1000);
    expect(segmentNonce(prefix, 0).length).toBe(12);
    expect(segmentNonce(prefix, 258).subarray(8)).toEqual(Buffer.from([0, 0, 1, 2]));
  });

  it("verifies the first segment before handing out the stream", async () => {
    const blob = await encryptBuffer(fk, FILE, plaintext(2 * S), { segmentSize: S });
    const tampered = Buffer.from(blob);
    tampered[HEADER_BYTES + 3] = (tampered[HEADER_BYTES + 3] as number) ^ 0xff;
    await integrity(createDecryptStream(fk, FILE, bufferSource(tampered)));
    // Damage further in surfaces as the stream is read.
    const later = Buffer.from(blob);
    later[HEADER_BYTES + S + TAG_BYTES + 3] =
      (later[HEADER_BYTES + S + TAG_BYTES + 3] as number) ^ 1;
    const { stream } = await createDecryptStream(fk, FILE, bufferSource(later));
    await expect(
      (async () => {
        for await (const _ of stream) {
          // drain
        }
      })(),
    ).rejects.toBeInstanceOf(IntegrityError);
  });

  it("keeps its own copy of the key: the caller may zero its buffer once the stream is out", async () => {
    const data = plaintext(2 * S + 3);
    const key = Buffer.from(fk);
    const blob = await encryptBuffer(key, FILE, data, { segmentSize: S });
    const { stream } = await createDecryptStream(key, FILE, bufferSource(blob));
    key.fill(0);
    const out: Buffer[] = [];
    for await (const chunk of stream) out.push(chunk as Buffer);
    expect(Buffer.concat(out)).toEqual(data);
  });

  it("rejects a bad key or segment size up front", () => {
    expect(() => createEncryptStream(Buffer.alloc(16), FILE)).toThrow(TypeError);
    expect(() => createEncryptStream(fk, FILE, { segmentSize: 1000 })).toThrow(RangeError);
    expect(() => createEncryptStream(fk, "")).toThrow(TypeError);
  });
});

describe("metadata record", () => {
  const meta = {
    filename: "Račun ž.pdf",
    mime: "application/pdf",
    metadata: { a: 1 },
    sniffed: true,
  };

  it("round-trips and is bound to the file id and the key", () => {
    const sealed = sealMeta(fk, FILE, meta);
    expect(openMeta(fk, FILE, sealed)).toEqual(meta);
    expect(() => openMeta(fk, randomUUID(), sealed)).toThrow(IntegrityError);
    expect(() => openMeta(newFileKey(), FILE, sealed)).toThrow(IntegrityError);
    const tampered = Buffer.from(sealed);
    tampered[20] = (tampered[20] as number) ^ 1;
    expect(() => openMeta(fk, FILE, tampered)).toThrow(IntegrityError);
    expect(() => openMeta(fk, FILE, sealed.subarray(0, 10))).toThrow(IntegrityError);
  });

  it("refuses a record whose body is not a metadata object", () => {
    const aad = Buffer.from(`${FILE}:meta`);
    expect(() => openMeta(fk, FILE, aeadSeal(fk, Buffer.from("[]"), aad))).toThrow(IntegrityError);
    expect(() =>
      openMeta(
        fk,
        FILE,
        aeadSeal(
          fk,
          Buffer.from(JSON.stringify({ v: 2, filename: "a", mime: "b", metadata: {} })),
          aad,
        ),
      ),
    ).toThrow(IntegrityError);
    expect(() =>
      openMeta(
        fk,
        FILE,
        aeadSeal(fk, Buffer.from(JSON.stringify({ v: 1, mime: "b", metadata: {} })), aad),
      ),
    ).toThrow(IntegrityError);
    expect(aeadOpen(fk, aeadSeal(fk, Buffer.from("x"), aad), aad)).toEqual(Buffer.from("x"));
  });
});

describe("tenant wrap provider", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const line0 = generateKeyLine();
  const line1 = generateKeyLine();

  it("wraps a file key the same tenant unwraps, and no other tenant does", async () => {
    const provider = new TenantWrapProvider(new StaticKeys([line0]));
    const ct = await provider.wrap(fk, { fileId: FILE, tenantId: tenantA });
    expect(ct.length).toBe(TENANT_FK_CT_BYTES);
    expect(ct.subarray(0, 4)).toEqual(keyId(Buffer.from(line0, "base64")));
    expect(await provider.unwrap(ct, { fileId: FILE, tenantId: tenantA })).toEqual({ fk });
    await expect(provider.unwrap(ct, { fileId: FILE, tenantId: tenantB })).rejects.toBeInstanceOf(
      IntegrityError,
    );
    await expect(
      provider.unwrap(ct, { fileId: randomUUID(), tenantId: tenantA }),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      provider.unwrap(ct.subarray(1), { fileId: FILE, tenantId: tenantA }),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect(wrapAad("tenant", FILE, tenantA).toString()).toBe(`${FILE}:key:tenant:${tenantA}`);
  });

  it("derives one KEK per tenant from one key line", () => {
    const key = Buffer.from(line0, "base64");
    expect(deriveTenantKek(key, tenantA)).not.toEqual(deriveTenantKek(key, tenantB));
    expect(deriveTenantKek(key, tenantA)).toEqual(deriveTenantKek(key, tenantA));
    expect(deriveTenantKek(key, tenantA).length).toBe(32);
    expect(deriveTenantKek(Buffer.from(line1, "base64"), tenantA)).not.toEqual(
      deriveTenantKek(key, tenantA),
    );
  });

  it("rotates lazily: an older line still opens, and the key comes back re-wrapped under the active one", async () => {
    const old = new TenantWrapProvider(new StaticKeys([line1]));
    const ct = await old.wrap(fk, { fileId: FILE, tenantId: tenantA });
    const rotated = new TenantWrapProvider(new StaticKeys([line0, line1]));
    const result = await rotated.unwrap(ct, { fileId: FILE, tenantId: tenantA });
    expect(result.fk).toEqual(fk);
    expect(result.rewrapped).toBeInstanceOf(Buffer);
    expect(result.rewrapped?.subarray(0, 4)).toEqual(keyId(Buffer.from(line0, "base64")));
    expect(
      await rotated.unwrap(result.rewrapped as Buffer, { fileId: FILE, tenantId: tenantA }),
    ).toEqual({ fk });
    // A hint that lies costs a try, not the file.
    const lying = Buffer.concat([Buffer.from([9, 9, 9, 9]), ct.subarray(4)]);
    expect((await rotated.unwrap(lying, { fileId: FILE, tenantId: tenantA })).fk).toEqual(fk);
    // The old line removed: nothing opens the old wrap any more.
    const dropped = new TenantWrapProvider(new StaticKeys([line0]));
    await expect(dropped.unwrap(ct, { fileId: FILE, tenantId: tenantA })).rejects.toBeInstanceOf(
      IntegrityError,
    );
  });

  it("parses a key file and refuses a malformed one", () => {
    const lines = parseKeyFile(`# comment\n${line0}\n\n${line1}\n`);
    expect(lines.map((l) => l.index)).toEqual([0, 1]);
    expect(lines[0]?.key).toEqual(Buffer.from(line0, "base64"));
    expect(() => parseKeyFile("")).toThrow(KeyFileError);
    expect(() => parseKeyFile("not base64!")).toThrow(KeyFileError);
    expect(() => parseKeyFile(randomBytes(16).toString("base64"))).toThrow(KeyFileError);
    expect(() => parseKeyFile(`${line0}\n${line0}`)).toThrow(KeyFileError);
  });

  it("reads VOLA_KEY_FILE lazily: missing is unavailable (not an error at start), present is used, a rewrite is picked up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vola-keys-"));
    try {
      const path = join(dir, "vola.key");
      const file = new KeyFile(path);
      const provider = new TenantWrapProvider(file);
      await expect(file.lines()).rejects.toBeInstanceOf(EncryptionUnavailableError);
      await expect(provider.wrap(fk, { fileId: FILE, tenantId: tenantA })).rejects.toBeInstanceOf(
        EncryptionUnavailableError,
      );
      await writeFile(path, `${line1}\n`, { mode: 0o600 });
      const ct = await provider.wrap(fk, { fileId: FILE, tenantId: tenantA });
      expect(
        (await provider.unwrap(ct, { fileId: FILE, tenantId: tenantA })).rewrapped,
      ).toBeUndefined();
      // Rotation: a new first line; the old one stays. The new mtime invalidates the cache.
      await writeFile(path, `${line0}\n${line1}\n`, { mode: 0o600 });
      await utimes(path, new Date(), new Date(Date.now() + 5000));
      const result = await provider.unwrap(ct, { fileId: FILE, tenantId: tenantA });
      expect(result.rewrapped).toBeDefined();
      await writeFile(path, "garbage\n");
      await utimes(path, new Date(), new Date(Date.now() + 10_000));
      await expect(file.lines()).rejects.toBeInstanceOf(EncryptionUnavailableError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

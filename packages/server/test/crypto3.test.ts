import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CALLER_FK_CT_BYTES,
  CallerWrapProvider,
  INTEGRITY_MESSAGE,
  IntegrityError,
  LockedError,
  newFileKey,
  openOcr,
  openPartial,
  openThumbnail,
  parseContentKey,
  partialNonce,
  ResumableSha256,
  sealOcr,
  sealPartial,
  sealThumbnail,
  segmentNonce,
  thumbnailAad,
  wrapAad,
} from "../src/crypto/index.js";

/**
 * The pure parts of phase 6.3: the `caller` wrap provider, the resumable SHA-256 of the
 * encrypted upload, and the sealed derivatives / partial segment (`crypto/derived.ts`).
 */
const FILE = randomUUID();
const TENANT = randomUUID();

describe("caller wrap provider", () => {
  const provider = new CallerWrapProvider();
  const key = randomBytes(32);

  it("wraps a file key the same caller key unwraps (60 bytes), and refuses without a key, with another key or for another file or tenant", async () => {
    const fk = newFileKey();
    const ct = await provider.wrap(fk, { fileId: FILE, tenantId: TENANT, callerKey: key });
    expect(ct.length).toBe(CALLER_FK_CT_BYTES);
    expect(ct.includes(fk)).toBe(false);
    const opened = await provider.unwrap(ct, { fileId: FILE, tenantId: TENANT, callerKey: key });
    expect(opened.fk).toEqual(fk);
    expect(opened.rewrapped).toBeUndefined(); // nothing to rotate to
    // No key: locked (423), never an integrity failure — the caller forgot the header.
    await expect(provider.unwrap(ct, { fileId: FILE, tenantId: TENANT })).rejects.toBeInstanceOf(
      LockedError,
    );
    await expect(provider.wrap(fk, { fileId: FILE, tenantId: TENANT })).rejects.toBeInstanceOf(
      LockedError,
    );
    // The wrong key, another file, another tenant: the fixed sentence.
    for (const ctx of [
      { fileId: FILE, tenantId: TENANT, callerKey: randomBytes(32) },
      { fileId: randomUUID(), tenantId: TENANT, callerKey: key },
      { fileId: FILE, tenantId: randomUUID(), callerKey: key },
    ]) {
      const failing = provider.unwrap(ct, ctx);
      await expect(failing).rejects.toBeInstanceOf(IntegrityError);
      await expect(failing).rejects.toThrow(INTEGRITY_MESSAGE);
    }
    await expect(
      provider.unwrap(ct.subarray(1), { fileId: FILE, tenantId: TENANT, callerKey: key }),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect(wrapAad("caller", FILE, TENANT).toString()).toBe(`${FILE}:key:caller:${TENANT}`);
  });

  it("parses X-Vola-Content-Key as 32 bytes of base64 (standard or URL-safe) and nothing else", () => {
    expect(parseContentKey(undefined)).toBeNull();
    expect(parseContentKey("")).toBeNull();
    expect(parseContentKey(key.toString("base64"))).toEqual(key);
    expect(parseContentKey(key.toString("base64url"))).toEqual(key);
    expect(() => parseContentKey("not base64!")).toThrow(RangeError);
    expect(() => parseContentKey(randomBytes(16).toString("base64"))).toThrow(RangeError);
    expect(() => parseContentKey(randomBytes(33).toString("base64"))).toThrow(RangeError);
  });
});

describe("resumable SHA-256", () => {
  const nodeHash = (data: Buffer) => createHash("sha256").update(data).digest("hex");

  it("matches node:crypto on empty, short, block-sized and random inputs", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 4096, 70_001]) {
      const data = randomBytes(n);
      expect(new ResumableSha256().update(data).digest(), `n=${n}`).toBe(nodeHash(data));
    }
  });

  it("gives the same digest however the input is split, and across export / import at every split", () => {
    const data = randomBytes(3000);
    const expected = nodeHash(data);
    for (const split of [0, 1, 63, 64, 65, 127, 128, 1000, 2999, 3000]) {
      const first = new ResumableSha256().update(data.subarray(0, split));
      const state = first.export();
      expect(state.length).toBe(split);
      expect(state.tail.length / 2).toBe(split % 64);
      const second = new ResumableSha256(state).update(data.subarray(split));
      expect(second.digest(), `split=${split}`).toBe(expected);
      // The exported state is plain JSON (what `enc_state` stores).
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    }
    // Many small updates, as a PATCH body arrives in chunks.
    const many = new ResumableSha256();
    for (let i = 0; i < data.length; i += 7) many.update(data.subarray(i, i + 7));
    expect(many.digest()).toBe(expected);
  });

  it("refuses a state that is not one, and a second digest", () => {
    expect(() => new ResumableSha256({ h: "zz", tail: "", length: 0 })).toThrow(RangeError);
    expect(() => new ResumableSha256({ h: "0".repeat(64), tail: "ab", length: 0 })).toThrow(
      RangeError,
    );
    const h = new ResumableSha256();
    h.digest();
    expect(() => h.digest()).toThrow();
    expect(() => h.update(Buffer.from("x"))).toThrow();
  });
});

describe("sealed derivatives", () => {
  const fk = newFileKey();

  it("a thumbnail opens only for its file, size and crop — and the sealed bytes carry no WebP magic", () => {
    const webp = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPVP8 "), randomBytes(200)]);
    const sealed = sealThumbnail(fk, FILE, 128, "cover", webp);
    expect(sealed.includes(Buffer.from("WEBP"))).toBe(false);
    expect(sealed.includes(Buffer.from("RIFF"))).toBe(false);
    expect(openThumbnail(fk, FILE, 128, "cover", sealed)).toEqual(webp);
    expect(() => openThumbnail(fk, FILE, 256, "cover", sealed)).toThrow(IntegrityError);
    expect(() => openThumbnail(fk, FILE, 128, "fit", sealed)).toThrow(IntegrityError);
    expect(() => openThumbnail(fk, randomUUID(), 128, "cover", sealed)).toThrow(IntegrityError);
    expect(() => openThumbnail(newFileKey(), FILE, 128, "cover", sealed)).toThrow(IntegrityError);
    expect(thumbnailAad(FILE, 128, "cover").toString()).toBe(`${FILE}:thumb:128:cover`);
  });

  it("an OCR record round-trips with text, language and pages, bound to the file", () => {
    const record = { text: "Invoice 42\fpage two", lang: "eng+srp", pages: 2 };
    const sealed = sealOcr(fk, FILE, record);
    expect(sealed.includes(Buffer.from("Invoice"))).toBe(false);
    expect(openOcr(fk, FILE, sealed)).toEqual(record);
    expect(() => openOcr(fk, randomUUID(), sealed)).toThrow(IntegrityError);
    expect(() => openOcr(newFileKey(), FILE, sealed)).toThrow(IntegrityError);
  });

  it("the partial segment's nonce never meets a segment nonce, and its AAD carries the write counter", () => {
    const blobPrefix = randomBytes(8);
    const partialPrefix = randomBytes(8);
    const plain = randomBytes(1000);
    // The same index 3 as a segment and as a partial: different nonces (different prefix).
    expect(partialNonce(partialPrefix, 3).equals(segmentNonce(blobPrefix, 3))).toBe(false);
    expect(partialNonce(partialPrefix, 1).equals(partialNonce(partialPrefix, 2))).toBe(false);
    const sealed = sealPartial(fk, FILE, partialPrefix, 3, 7, plain);
    expect(sealed.includes(plain.subarray(0, 32))).toBe(false);
    expect(openPartial(fk, FILE, partialPrefix, 3, 7, sealed)).toEqual(plain);
    // A stale partial (an earlier write), another index, another file: refused.
    expect(() => openPartial(fk, FILE, partialPrefix, 3, 6, sealed)).toThrow(IntegrityError);
    expect(() => openPartial(fk, FILE, partialPrefix, 4, 7, sealed)).toThrow(IntegrityError);
    expect(() => openPartial(fk, randomUUID(), partialPrefix, 3, 7, sealed)).toThrow(
      IntegrityError,
    );
    expect(() => partialNonce(randomBytes(7), 1)).toThrow(RangeError);
  });
});

/**
 * The encrypted resumable upload (plan 6.3, `docs/CRYPTO.md` § 10): the incoming plaintext is
 * cut into `JSV` segments AS IT ARRIVES and only ciphertext ever reaches the part file. What
 * one upload keeps between PATCHes sits in `vola_upload.enc_state` (`EncState`):
 *
 * ```
 * <uploads>/<upload id>.part     header (24 B) ∥ sealed segment 0 ∥ … ∥ sealed segment next_index − 1
 * <uploads>/<upload id>.partial  AES-GCM(FK, nonce partial_prefix ∥ partial_writes, plaintext tail,
 *                                AAD "<file id>:partial:<next_index>:<partial_writes>")   — or absent
 * enc_state                      {file_id, fk_ct, keyring_id, nonce_prefix, segment_size, next_index,
 *                                partial_bytes, partial_prefix, partial_writes, hash, head_ct}
 * ```
 *
 * A PATCH unwraps the file key under the request's material (`tenant`: the key file;
 * `keyring`: `X-Vola-Unlock`; `caller`: `X-Vola-Content-Key` — on EVERY PATCH), opens the
 * sealed tail, cuts the part file back to the committed ciphertext length, appends the body
 * to the tail and seals every segment that is complete — segment `i` is complete at `S` bytes,
 * the last one (`i = n − 1`, known because `Upload-Length` is known) at `L − (n − 1)·S` — at
 * its offset `24 + i·(S + 16)`, running the blob's SHA-256 forward over each sealed segment.
 * Whatever is left (less than a segment) is re-sealed into `.partial` under a nonce that is
 * never reused (`derived.ts`), the plaintext buffers are dropped, and the row commits
 * `offset = next_index·S + partial_bytes` — the PLAINTEXT offset `HEAD` reports. Memory per
 * PATCH is one segment plus one chunk; the disk never holds more than one segment of the
 * file's bytes outside the `JSV` blob, and that one is sealed too. An interrupted PATCH is
 * caught up to the byte: the next one resumes from `Upload-Offset`.
 *
 * Completion needs no second read of the part: the hash comes out of `enc_state.hash`, the
 * sniffing head out of `head_ct`, and the part file — already the final blob — is hard-linked
 * into the store like any staged blob.
 */
import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { FileEncryption } from "@vola/core";
import {
  ciphertextLengthFor,
  encodeHeader,
  gcmEncrypt,
  HEADER_BYTES,
  IntegrityError,
  JSV_VERSION,
  NONCE_PREFIX_BYTES,
  newFileKey,
  openHead,
  openPartial,
  PARTIAL_PREFIX_BYTES,
  ResumableSha256,
  type Sha256State,
  sealHead,
  sealPartial,
  segmentAad,
  segmentCount,
  segmentNonce,
  segmentOffset,
} from "../crypto/index.js";
import { uuidv7 } from "../db/uuid.js";
import { VolaError } from "../errors.js";
import { SNIFF_BYTES } from "../files/mime.js";
import { PartOverflowError, type PartStore } from "../uploads/part-store.js";
import type { EncryptionService } from "./encryption.js";

export const ENC_STATE_VERSION = 1;

/** `vola_upload.enc_state` of a server-encrypted upload (`tenant` | `keyring` | `caller`). */
export interface EncState {
  v: typeof ENC_STATE_VERSION;
  mode: Exclude<FileEncryption, "none" | "client">;
  /** The id of the row to come (in every AAD). */
  file_id: string;
  /** base64 of the wrapped file key under the mode's provider (re-wrapped lazily like a row's). */
  fk_ct: string;
  keyring_id: string | null;
  /** base64, 8 B. */
  nonce_prefix: string;
  segment_size: number;
  /** Segments sealed and on disk. */
  next_index: number;
  /** Plaintext bytes in the sealed tail (`.partial`); 0 when there is none. */
  partial_bytes: number;
  /** base64, 8 B: the nonce prefix of the sealed tail (never the blob's). */
  partial_prefix: string;
  /** How many times the tail was sealed: the nonce counter and part of its AAD. */
  partial_writes: number;
  /** The blob's SHA-256 so far (header and every sealed segment). */
  hash: Sha256State;
  /** base64 of the sealed first `SNIFF_BYTES` of the plaintext; `null` before any byte. */
  head_ct: string | null;
}

/** `vola_upload.enc_state` of a `client` upload: the server stores the key as given. */
export interface ClientEncState {
  v: typeof ENC_STATE_VERSION;
  mode: "client";
  file_id: string;
  /** base64, as the client sent it. */
  fk_ct: string;
  /** base64, as the client sent it; `null` when it sent none. */
  meta_ct: string | null;
}

export type AnyEncState = EncState | ClientEncState;

const b64 = (b: Buffer) => b.toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

/** The stored state, or `null` when the row has none (a plain upload). Throws for a record of another version. */
export function parseEncState(raw: Record<string, unknown> | null | undefined): AnyEncState | null {
  if (!raw) return null;
  if (raw.v !== ENC_STATE_VERSION || typeof raw.mode !== "string") {
    throw new VolaError("upload_lost", 410, "the upload's encryption state is not readable");
  }
  return raw as unknown as AnyEncState;
}

/**
 * The state of a fresh server-encrypted upload: a new file key (wrapped under `mode` with the
 * request's material — `423` / `503` as for any upload of that mode) and the header of the
 * blob to come, which also starts the hash. The part file gets the header right away.
 */
export async function createEncState(
  crypto: EncryptionService,
  parts: PartStore,
  input: {
    uploadId: string;
    tenantId: string;
    mode: Exclude<FileEncryption, "none" | "client">;
    keyringId: string | null;
    length: number;
  },
): Promise<EncState> {
  const fileId = uuidv7();
  const fk = newFileKey();
  try {
    const { fkCt, keyringId } = await crypto.wrapNewKey(input.mode, fk, {
      fileId,
      tenantId: input.tenantId,
      keyringId: input.keyringId,
    });
    const noncePrefix = randomBytes(NONCE_PREFIX_BYTES);
    const header = encodeHeader({
      segmentSize: crypto.segmentSize,
      noncePrefix,
      plaintextLength: input.length,
    });
    await parts.writeAt(input.uploadId, 0, header);
    return {
      v: ENC_STATE_VERSION,
      mode: input.mode,
      file_id: fileId,
      fk_ct: b64(fkCt),
      keyring_id: keyringId,
      nonce_prefix: b64(noncePrefix),
      segment_size: crypto.segmentSize,
      next_index: 0,
      partial_bytes: 0,
      partial_prefix: b64(randomBytes(PARTIAL_PREFIX_BYTES)),
      partial_writes: 0,
      hash: new ResumableSha256().update(header).export(),
      head_ct: null,
    };
  } finally {
    fk.fill(0);
  }
}

/** The header of the blob an upload builds (the same bytes `createEncState` wrote). */
export function headerOf(enc: EncState, length: number): Buffer {
  return encodeHeader({
    segmentSize: enc.segment_size,
    noncePrefix: unb64(enc.nonce_prefix),
    plaintextLength: length,
  });
}

/** The plaintext length of segment `index` of a file of `length` bytes. */
function segmentPlainLength(index: number, length: number, S: number): number {
  const n = segmentCount(length, S);
  return index < n - 1 ? S : length - (n - 1) * S;
}

export interface EncryptedAppendInput {
  uploadId: string;
  tenantId: string;
  /** `Upload-Length`. */
  length: number;
  /** The committed plaintext offset (what `enc` describes). */
  offset: number;
  /** The body; `null` for the flush of a zero-length upload. */
  body: Readable | null;
  /** Bytes the body may carry at most (`length − offset`). */
  room: number;
}

export interface EncryptedAppendResult {
  /** The new plaintext offset. */
  offset: number;
  /** The state to commit. */
  enc: EncState;
  /** The body failed mid-way; what arrived is sealed and counted in `offset`. */
  error: Error | null;
}

/** The sealed tail or the sealed head does not open against the committed state: the upload cannot go on. */
function stateMismatch(what: string): VolaError {
  return new VolaError(
    "upload_lost",
    410,
    `the ${what} of this upload does not match its committed state; start a new one`,
  );
}

/**
 * The PATCH of an encrypted upload (see the module comment). Throws `PartOverflowError` when
 * the body exceeds `room` — nothing is committed then — and the crypto service's `423` /
 * `409` / `503` before a byte is read. A failing body is reported in `error`, with the
 * state that holds what arrived.
 */
export async function appendEncrypted(
  crypto: EncryptionService,
  parts: PartStore,
  enc: EncState,
  input: EncryptedAppendInput,
): Promise<EncryptedAppendResult> {
  const fileId = enc.file_id;
  const S = enc.segment_size;
  const L = input.length;
  const n = segmentCount(L, S);
  const unwrapped = await crypto.unwrapKey(enc.mode, unb64(enc.fk_ct), {
    fileId,
    tenantId: input.tenantId,
    keyringId: enc.keyring_id,
  });
  const fk = unwrapped.fk;
  const state: EncState = { ...enc };
  if (unwrapped.rewrapped) state.fk_ct = b64(unwrapped.rewrapped);
  try {
    const header = headerOf(enc, L);
    const partialPrefix = unb64(enc.partial_prefix);
    // The tail of the previous PATCH, back in memory.
    const held: Buffer[] = [];
    let heldBytes = 0;
    if (enc.partial_bytes > 0) {
      const sealed = await parts.readPartial(input.uploadId);
      if (!sealed) throw stateMismatch("sealed tail");
      let tail: Buffer;
      try {
        tail = openPartial(fk, fileId, partialPrefix, enc.next_index, enc.partial_writes, sealed);
      } catch (error) {
        if (error instanceof IntegrityError) throw stateMismatch("sealed tail");
        throw error;
      }
      if (tail.length !== enc.partial_bytes) throw stateMismatch("sealed tail");
      held.push(tail);
      heldBytes = tail.length;
    }
    // The sniffing head so far (the first SNIFF_BYTES of the plaintext).
    let head: Buffer = Buffer.alloc(0);
    if (enc.head_ct) {
      try {
        head = openHead(fk, fileId, unb64(enc.head_ct));
      } catch (error) {
        if (error instanceof IntegrityError) throw stateMismatch("sealed head");
        throw error;
      }
    }
    const headBefore = head.length;
    // Plaintext bytes already committed (segments + tail): what the head must not re-count.
    const committedPlain = enc.next_index * S + enc.partial_bytes;
    if (head.length !== Math.min(SNIFF_BYTES, committedPlain)) throw stateMismatch("sealed head");

    // A previous PATCH that died after writing a segment but before committing: cut it off.
    const expectedCiphertext = segmentOffset({ segmentSize: S }, enc.next_index);
    await parts.truncate(input.uploadId, expectedCiphertext);
    const hash = new ResumableSha256(enc.hash);
    const handle: FileHandle = await parts.openForWrite(input.uploadId);
    let index = enc.next_index;
    let received = 0;
    let overflow = false;
    let error: Error | null = null;
    let plainSeen = committedPlain;
    const headChunks: Buffer[] = [head];
    let headBytes = head.length;

    /** Exactly `count` bytes off the front of `held`. */
    const take = (count: number): Buffer => {
      const out = Buffer.allocUnsafe(count);
      let filled = 0;
      while (filled < count) {
        const first = held[0] as Buffer;
        const need = count - filled;
        if (first.length <= need) {
          first.copy(out, filled);
          filled += first.length;
          held.shift();
        } else {
          first.copy(out, filled, 0, need);
          held[0] = first.subarray(need) as Buffer;
          filled += need;
        }
      }
      heldBytes -= count;
      return out;
    };

    const sealComplete = async (): Promise<void> => {
      while (index < n && heldBytes >= segmentPlainLength(index, L, S)) {
        const plain = take(segmentPlainLength(index, L, S));
        const last = index === n - 1;
        const sealed = gcmEncrypt(
          fk,
          segmentNonce(unb64(enc.nonce_prefix), index),
          plain,
          segmentAad(header, fileId, index, last, L),
        );
        plain.fill(0);
        await handle.write(sealed, 0, sealed.length, segmentOffset({ segmentSize: S }, index));
        hash.update(sealed);
        index++;
      }
    };

    try {
      try {
        if (input.body) {
          // `destroyOnReturn: false`: breaking out on overflow must not kill the request socket.
          for await (const chunk of input.body.iterator({ destroyOnReturn: false })) {
            const bytes = chunk as Buffer;
            received += bytes.length;
            if (received > input.room) {
              overflow = true;
              break;
            }
            if (headBytes < SNIFF_BYTES) {
              const part = bytes.subarray(0, SNIFF_BYTES - headBytes);
              headChunks.push(Buffer.from(part));
              headBytes += part.length;
            }
            plainSeen += bytes.length;
            held.push(bytes);
            heldBytes += bytes.length;
            await sealComplete();
          }
        }
        if (!overflow) await sealComplete(); // the empty last segment of a 0-byte file
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }
      if (overflow) {
        input.body?.resume();
        await handle.truncate(expectedCiphertext);
        throw new PartOverflowError(input.room);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    // The tail, sealed under a nonce nobody used before; or no tail at all.
    if (heldBytes > 0) {
      const rest = take(heldBytes);
      const write = enc.partial_writes + 1;
      await parts.writePartial(
        input.uploadId,
        sealPartial(fk, fileId, partialPrefix, index, write, rest),
      );
      rest.fill(0);
      state.partial_bytes = rest.length;
      state.partial_writes = write;
    } else {
      await parts.removePartial(input.uploadId);
      state.partial_bytes = 0;
    }
    const newHead = Buffer.concat(headChunks);
    if (newHead.length !== headBefore || enc.head_ct === null) {
      state.head_ct =
        plainSeen > 0 || newHead.length > 0 ? b64(sealHead(fk, fileId, newHead)) : null;
    }
    state.next_index = index;
    state.hash = hash.export();
    const offset = index === n ? L : index * S + state.partial_bytes;
    return { offset, enc: state, error };
  } finally {
    fk.fill(0);
  }
}

/** What completion needs out of a finished encrypted upload: the blob's hash and the sniffing head. */
export interface FinishedEncryptedPart {
  hash: string;
  ciphertextLength: number;
  head: Buffer;
  fk: Buffer;
  format: number;
}

/**
 * Checks that the upload holds every segment and no tail, and hands back the blob hash (from
 * the running state), the plaintext head and the file key (the caller zeroes it). `410
 * upload_lost` when the state and the part file disagree.
 */
export async function finishEncrypted(
  crypto: EncryptionService,
  parts: PartStore,
  enc: EncState,
  input: { uploadId: string; tenantId: string; length: number },
): Promise<FinishedEncryptedPart> {
  const n = segmentCount(input.length, enc.segment_size);
  const expected = ciphertextLengthFor(input.length, enc.segment_size);
  const size = await parts.size(input.uploadId);
  if (enc.next_index !== n || enc.partial_bytes !== 0 || size !== expected) {
    throw new VolaError(
      "upload_lost",
      410,
      `the part file holds ${size ?? 0} bytes, the upload expects ${expected}`,
    );
  }
  const { fk } = await crypto.unwrapKey(enc.mode, unb64(enc.fk_ct), {
    fileId: enc.file_id,
    tenantId: input.tenantId,
    keyringId: enc.keyring_id,
  });
  let head: Buffer = Buffer.alloc(0);
  if (enc.head_ct) {
    try {
      head = openHead(fk, enc.file_id, unb64(enc.head_ct));
    } catch (error) {
      fk.fill(0);
      if (error instanceof IntegrityError) throw stateMismatch("sealed head");
      throw error;
    }
  }
  return {
    hash: new ResumableSha256(enc.hash).digest(),
    ciphertextLength: expected,
    head,
    fk,
    format: JSV_VERSION,
  };
}

/** The ciphertext length of the blob an encrypted upload of `length` plaintext bytes ends as. */
export function encryptedPartLength(enc: EncState, length: number): number {
  return ciphertextLengthFor(length, enc.segment_size);
}

export { HEADER_BYTES };

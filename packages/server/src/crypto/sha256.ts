/**
 * SHA-256 with an EXPORTABLE midstate, for the content hash of a resumable encrypted upload
 * (plan 6.3): every PATCH adds the ciphertext it appended and the state goes into
 * `vola_upload.enc_state`, so completion knows the blob's hash without reading the part file
 * again — however many PATCHes, over however many days, the upload took. `node:crypto` cannot
 * serialise a running hash, which is the only reason this file exists.
 *
 * This is NOT a security primitive here: the hash is the blob's storage address (the same
 * `sha256` of the stored bytes a plain upload gets through `node:crypto`), computed over
 * ciphertext. `test/crypto.test.ts` checks it against `createHash("sha256")` on random inputs
 * and at every split point; `digest()` of a state that was exported and imported is the same
 * digest.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** The serialised midstate: eight words as hex, the unprocessed tail as hex, the byte count. */
export interface Sha256State {
  h: string;
  tail: string;
  /** Bytes hashed so far (a safe integer: 2⁵³ bytes is far beyond any blob). */
  length: number;
}

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export class ResumableSha256 {
  private readonly h = new Uint32Array(8);
  private readonly w = new Uint32Array(64);
  private tail = Buffer.alloc(0);
  private length = 0;
  private finished = false;

  constructor(state?: Sha256State) {
    if (state) {
      if (!/^[0-9a-f]{64}$/.test(state.h) || !/^([0-9a-f]{2}){0,63}$/.test(state.tail)) {
        throw new RangeError("not a SHA-256 state");
      }
      if (!Number.isSafeInteger(state.length) || state.length < 0) {
        throw new RangeError("not a SHA-256 state");
      }
      for (let i = 0; i < 8; i++) this.h[i] = Number.parseInt(state.h.slice(i * 8, i * 8 + 8), 16);
      this.tail = Buffer.from(state.tail, "hex");
      this.length = state.length;
      if (this.tail.length !== this.length % 64) throw new RangeError("not a SHA-256 state");
    } else {
      this.h.set(INITIAL);
    }
  }

  /** Adds `data`; returns `this`. */
  update(data: Buffer): this {
    if (this.finished) throw new Error("digest already taken");
    if (data.length === 0) return this;
    this.length += data.length;
    let input = this.tail.length > 0 ? Buffer.concat([this.tail, data]) : data;
    let offset = 0;
    while (input.length - offset >= 64) {
      this.block(input, offset);
      offset += 64;
    }
    this.tail = Buffer.from(input.subarray(offset));
    input = Buffer.alloc(0);
    return this;
  }

  /** The midstate, to be stored and given to a later `new ResumableSha256(state)`. */
  export(): Sha256State {
    if (this.finished) throw new Error("digest already taken");
    let h = "";
    for (let i = 0; i < 8; i++) h += (this.h[i] as number).toString(16).padStart(8, "0");
    return { h, tail: this.tail.toString("hex"), length: this.length };
  }

  /** The digest as lowercase hex. The instance is finished afterwards. */
  digest(): string {
    if (this.finished) throw new Error("digest already taken");
    this.finished = true;
    const bitLength = BigInt(this.length) * 8n;
    const padLength = (this.tail.length < 56 ? 56 : 120) - this.tail.length;
    const padded = Buffer.alloc(this.tail.length + padLength + 8);
    this.tail.copy(padded, 0);
    padded[this.tail.length] = 0x80;
    padded.writeBigUInt64BE(bitLength, padded.length - 8);
    for (let offset = 0; offset < padded.length; offset += 64) this.block(padded, offset);
    let out = "";
    for (let i = 0; i < 8; i++) out += (this.h[i] as number).toString(16).padStart(8, "0");
    return out;
  }

  private block(data: Buffer, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = data.readUInt32BE(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.h[0] = (this.h[0] as number) + a;
    this.h[1] = (this.h[1] as number) + b;
    this.h[2] = (this.h[2] as number) + c;
    this.h[3] = (this.h[3] as number) + d;
    this.h[4] = (this.h[4] as number) + e;
    this.h[5] = (this.h[5] as number) + f;
    this.h[6] = (this.h[6] as number) + g;
    this.h[7] = (this.h[7] as number) + h;
  }
}

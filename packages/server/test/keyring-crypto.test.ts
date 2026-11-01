import { randomBytes } from "node:crypto";
import { PIN_LENGTH } from "@vola/core";
import { describe, expect, it } from "vitest";
import {
  ARGON2_ITERATIONS,
  ARGON2_LANES,
  ARGON2_MEMORY_KIB,
  attemptDelayS,
  base32Encode,
  DEFAULT_KDF_COST,
  deriveKek,
  deriveUnlockKek,
  FREE_ATTEMPTS,
  freshKdf,
  hasPinShape,
  IntegrityError,
  isRecoveryKeyShaped,
  KEYRING_FK_CT_BYTES,
  KeyringWrapProvider,
  kdfSalt,
  LOCKOUT_AT,
  LockedError,
  MK_CT_BYTES,
  mkAad,
  newFileKey,
  newMasterKey,
  newRecoveryKey,
  normalizeRecoveryKey,
  parseKeyFile,
  pinInvalidReason,
  SALT_BYTES,
  secretsEqual,
  unwrapFromStore,
  unwrapMasterKey,
  wrapForStore,
  wrapMasterKey,
} from "../src/crypto/index.js";

/** Small Argon2 parameters: the unit tests exercise the wiring, not the cost. */
const FAST = { m: 1024, t: 1, p: 1 };
const peppers = parseKeyFile(
  [randomBytes(32).toString("base64"), randomBytes(32).toString("base64")].join("\n"),
);
const active = peppers[0] as (typeof peppers)[number];
const older = peppers[1] as (typeof peppers)[number];

describe("PIN validation", () => {
  it("the length is one constant", () => {
    expect(PIN_LENGTH).toBe(6);
  });
  it.each([
    ["", "length"],
    ["12345", "length"],
    ["1234567", "length"],
    ["12a456", "digits"],
    ["12 456", "digits"],
    ["１２３４５６", "digits"],
    ["000000", "trivial"],
    ["777777", "trivial"],
    ["123456", "trivial"],
    ["456789", "trivial"],
    ["654321", "trivial"],
    ["987654", "trivial"],
  ])("refuses %j (%s)", (pin, reason) => {
    expect(pinInvalidReason(pin)).toBe(reason);
  });
  it.each(["135790", "112233", "102030", "246810", "909090", "123457", "764532"])(
    "accepts %s",
    (pin) => {
      expect(pinInvalidReason(pin)).toBeNull();
    },
  );
  it("hasPinShape checks only length and digits (a trivial PIN still has the shape)", () => {
    expect(hasPinShape("123456")).toBe(true);
    expect(hasPinShape("12345")).toBe(false);
    expect(hasPinShape("12345a")).toBe(false);
    expect(hasPinShape(123456)).toBe(false);
  });
});

describe("recovery key", () => {
  it("is 8 groups of 4 base32 characters, 160 bits, different every time", () => {
    const a = newRecoveryKey();
    const b = newRecoveryKey();
    expect(a).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
    expect(a).not.toBe(b);
    expect(isRecoveryKeyShaped(normalizeRecoveryKey(a))).toBe(true);
  });
  it("normalises case, separators, 0→O and 1→I", () => {
    expect(normalizeRecoveryKey(" k7qm-2p9x 0o1i\tABCD ")).toBe("K7QM2P9XOOIIABCD");
    const key = newRecoveryKey();
    const typed = key.toLowerCase().replace(/-/g, " ").replace(/O/gi, "0").replace(/I/gi, "1");
    expect(normalizeRecoveryKey(typed)).toBe(key.replace(/-/g, ""));
  });
  it("shape: exactly 32 characters of the alphabet after normalisation", () => {
    expect(isRecoveryKeyShaped("A".repeat(32))).toBe(true);
    expect(isRecoveryKeyShaped("A".repeat(31))).toBe(false);
    expect(isRecoveryKeyShaped(`${"A".repeat(31)}8`)).toBe(false);
    expect(isRecoveryKeyShaped(`${"A".repeat(31)}a`)).toBe(false);
  });
  it("base32 encodes RFC 4648 test vectors", () => {
    expect(base32Encode(Buffer.from(""))).toBe("");
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(Buffer.alloc(20)).length).toBe(32);
  });
});

describe("attempt delay table", () => {
  it("is the Notes table: free, 1 s, 5 s, 30 s ×5, an hour, then doubling", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(attemptDelayS)).toEqual([
      0, 0, 0, 1, 5, 30, 30, 30, 30, 30, 3600, 7200, 14400, 28800,
    ]);
    expect(FREE_ATTEMPTS).toBe(3);
    expect(LOCKOUT_AT).toBe(10);
  });
  it("never overflows", () => {
    expect(attemptDelayS(1000)).toBe(attemptDelayS(999));
    expect(Number.isFinite(attemptDelayS(1_000_000))).toBe(true);
    expect(attemptDelayS(-1)).toBe(0);
    expect(attemptDelayS(1.5)).toBe(0);
  });
});

describe("Argon2id + pepper", () => {
  it("the defaults are RFC 9106's second profile, stored per keyring", () => {
    expect(DEFAULT_KDF_COST).toEqual({ m: 65536, t: 3, p: 1 });
    expect([ARGON2_MEMORY_KIB, ARGON2_ITERATIONS, ARGON2_LANES]).toEqual([65536, 3, 1]);
    const kdf = freshKdf(active, FAST);
    expect(kdf).toMatchObject({ alg: "argon2id", m: 1024, t: 1, p: 1 });
    expect(kdf.pepper_line).toBe(active.kid.toString("hex"));
    expect(kdfSalt(kdf)).toHaveLength(SALT_BYTES);
    expect(kdfSalt(freshKdf(active, FAST))).not.toEqual(kdfSalt(kdf));
  });
  it("a different PIN, salt or pepper gives a different key; the same inputs the same", async () => {
    const salt = randomBytes(SALT_BYTES);
    const a = await deriveKek("135790", salt, active.key, FAST);
    expect(a).toHaveLength(32);
    expect(await deriveKek("135790", salt, active.key, FAST)).toEqual(a);
    expect(await deriveKek("135791", salt, active.key, FAST)).not.toEqual(a);
    expect(await deriveKek("135790", randomBytes(SALT_BYTES), active.key, FAST)).not.toEqual(a);
    expect(await deriveKek("135790", salt, older.key, FAST)).not.toEqual(a);
  });
  it("refuses a bad salt or kdf record", async () => {
    await expect(deriveKek("135790", randomBytes(8), active.key, FAST)).rejects.toThrow(TypeError);
    expect(() =>
      kdfSalt({ alg: "argon2id", salt: "AAAA", m: 1, t: 1, p: 1, pepper_line: "" }),
    ).toThrow(IntegrityError);
    expect(() =>
      kdfSalt({ alg: "scrypt", salt: "", m: 1, t: 1, p: 1, pepper_line: "" } as never),
    ).toThrow(IntegrityError);
  });
});

describe("master key wrap", () => {
  it("wraps and unwraps under the right KEK and AAD only", async () => {
    const mk = newMasterKey();
    const kek = await deriveKek("135790", randomBytes(SALT_BYTES), active.key, FAST);
    const aad = mkAad("kr-1", "pin");
    const ct = wrapMasterKey(kek, mk, aad);
    expect(ct).toHaveLength(MK_CT_BYTES);
    expect(unwrapMasterKey(kek, ct, aad)).toEqual(mk);
    expect(() => unwrapMasterKey(kek, ct, mkAad("kr-1", "recovery"))).toThrow(IntegrityError);
    expect(() => unwrapMasterKey(kek, ct, mkAad("kr-2", "pin"))).toThrow(IntegrityError);
    const other = await deriveKek("135791", randomBytes(SALT_BYTES), active.key, FAST);
    expect(() => unwrapMasterKey(other, ct, aad)).toThrow(IntegrityError);
    const cut = Buffer.from(ct);
    cut[20] = (cut[20] as number) ^ 1;
    expect(() => unwrapMasterKey(kek, cut, aad)).toThrow(IntegrityError);
  });
  it("pepper rotation: a wrap under the older line still opens with that line, not with the active one", async () => {
    const mk = newMasterKey();
    const salt = randomBytes(SALT_BYTES);
    const aad = mkAad("kr-1", "pin");
    const underOld = wrapMasterKey(await deriveKek("135790", salt, older.key, FAST), mk, aad);
    expect(() => unwrapMasterKey(Buffer.alloc(32, 1), underOld, aad)).toThrow(IntegrityError);
    // What the service does on unlock: try every line, the hinted one first.
    let opened: Buffer | null = null;
    for (const line of peppers) {
      try {
        opened = unwrapMasterKey(await deriveKek("135790", salt, line.key, FAST), underOld, aad);
        break;
      } catch (error) {
        if (!(error instanceof IntegrityError)) throw error;
      }
    }
    expect(opened).toEqual(mk);
  });
});

describe("KeyringWrapProvider", () => {
  const provider = new KeyringWrapProvider();
  const mk = newMasterKey();
  const ctx = { fileId: "file-1", tenantId: "t-1", keyringId: "kr-1", unlock: mk };

  it("wraps a file key under the master key, bound to the file and the keyring", async () => {
    const fk = newFileKey();
    const fkCt = await provider.wrap(fk, ctx);
    expect(fkCt).toHaveLength(KEYRING_FK_CT_BYTES);
    expect((await provider.unwrap(fkCt, ctx)).fk).toEqual(fk);
    expect((await provider.unwrap(fkCt, ctx)).rewrapped).toBeUndefined();
    await expect(provider.unwrap(fkCt, { ...ctx, fileId: "file-2" })).rejects.toThrow(
      IntegrityError,
    );
    await expect(provider.unwrap(fkCt, { ...ctx, keyringId: "kr-2" })).rejects.toThrow(
      IntegrityError,
    );
    await expect(provider.unwrap(fkCt, { ...ctx, unlock: newMasterKey() })).rejects.toThrow(
      IntegrityError,
    );
    await expect(provider.unwrap(fkCt.subarray(1), ctx)).rejects.toThrow(IntegrityError);
  });
  it("is locked without a master key or a keyring", async () => {
    const fk = newFileKey();
    await expect(provider.wrap(fk, { ...ctx, unlock: undefined })).rejects.toThrow(LockedError);
    await expect(provider.wrap(fk, { ...ctx, keyringId: null })).rejects.toThrow(LockedError);
    const fkCt = await provider.wrap(fk, ctx);
    await expect(provider.unwrap(fkCt, { ...ctx, unlock: undefined })).rejects.toThrow(LockedError);
  });
});

describe("the master key in the unlock store", () => {
  const lines = parseKeyFile(
    [randomBytes(32).toString("base64"), randomBytes(32).toString("base64")].join("\n"),
  );
  const [line0, line1] = lines as [(typeof lines)[number], (typeof lines)[number]];

  it("is wrapped under the key file, per tenant, bound to the token", () => {
    const mk = newMasterKey();
    const aad = Buffer.from("token-1");
    const sealed = wrapForStore(line0, mk, "t-1", aad);
    expect(sealed.subarray(0, 4)).toEqual(line0.kid);
    expect(unwrapFromStore(lines, sealed, "t-1", aad)).toEqual(mk);
    expect(() => unwrapFromStore(lines, sealed, "t-2", aad)).toThrow(IntegrityError);
    expect(() => unwrapFromStore(lines, sealed, "t-1", Buffer.from("token-2"))).toThrow(
      IntegrityError,
    );
    expect(() => unwrapFromStore([line1], sealed, "t-1", aad)).toThrow(IntegrityError);
    expect(() => unwrapFromStore(lines, sealed.subarray(2), "t-1", aad)).toThrow(IntegrityError);
    // An older line still opens its entries, whatever the hint says.
    const underOld = wrapForStore(line1, mk, "t-1", aad);
    expect(unwrapFromStore(lines, underOld, "t-1", aad)).toEqual(mk);
    expect(deriveUnlockKek(line0.key, "t-1")).not.toEqual(deriveUnlockKek(line0.key, "t-2"));
  });
  it("secretsEqual compares in constant time and refuses different lengths", () => {
    expect(secretsEqual(Buffer.from("ab"), Buffer.from("ab"))).toBe(true);
    expect(secretsEqual(Buffer.from("ab"), Buffer.from("abc"))).toBe(false);
    expect(secretsEqual(Buffer.from("ab"), Buffer.from("ac"))).toBe(false);
  });
});

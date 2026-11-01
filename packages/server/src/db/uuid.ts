import { randomBytes } from "node:crypto";

/**
 * A UUID v7 (RFC 9562): 48 bits of Unix milliseconds, then random bits. Rows sort by creation
 * time and ids stay unguessable. Generated here (PostgreSQL 16 has no `uuidv7()`); the
 * schema uses it as the default of every `id`.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  // 48-bit big-endian timestamp.
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, bytesToBase64Url, randomBytes } from "../src/index.js";

describe("env helpers", () => {
  it("base64 round-trips, base64url has no padding, malformed input throws", () => {
    const bytes = randomBytes(33);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    const url = bytesToBase64Url(bytes);
    expect(url).not.toMatch(/[+/=]/);
    expect(base64ToBytes(url)).toEqual(bytes);
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe("+/8=");
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(() => base64ToBytes("***")).toThrow(TypeError);
  });
});

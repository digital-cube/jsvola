import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_MAX_FILES,
  AccessTokenCreatedSchema,
  AccessTokenCreateSchema,
  isAccessToken,
  SCOPES,
  TENANT_SCOPES,
} from "../src/index.js";

const U1 = "0190a8c2-1b2c-7d3e-8f40-123456789abc";
const U2 = "0190a8c2-1b2c-7d3e-8f40-123456789abd";

describe("access tokens", () => {
  it("adds access:grant to the scopes a tenant key may hold", () => {
    expect(SCOPES).toContain("access:grant");
    expect(TENANT_SCOPES).toContain("access:grant");
  });

  it("recognises a token by its own prefix, never an API key", () => {
    expect(isAccessToken(`vola_at_${"a".repeat(40)}`)).toBe(true);
    expect(isAccessToken(`vola_at_${"a".repeat(39)}`)).toBe(false);
    expect(isAccessToken(`vola_live_${"a".repeat(32)}`)).toBe(false);
  });

  it("takes exactly one of file_ids or instance, and a principal", () => {
    expect(AccessTokenCreateSchema.safeParse({ file_ids: [U1], principal: "u1" }).success).toBe(
      true,
    );
    expect(
      AccessTokenCreateSchema.safeParse({
        instance: { instance_type: "mail", instance_id: U2 },
        principal: "u1",
        expires_in: 60,
      }).success,
    ).toBe(true);
    expect(AccessTokenCreateSchema.safeParse({ principal: "u1" }).success).toBe(false);
    expect(
      AccessTokenCreateSchema.safeParse({
        file_ids: [U1],
        instance: { instance_type: "mail", instance_id: U2 },
        principal: "u1",
      }).success,
    ).toBe(false);
    expect(AccessTokenCreateSchema.safeParse({ file_ids: [U1] }).success).toBe(false);
    expect(AccessTokenCreateSchema.safeParse({ file_ids: [U1], principal: "a\nb" }).success).toBe(
      false,
    );
    expect(AccessTokenCreateSchema.safeParse({ file_ids: [], principal: "u" }).success).toBe(false);
    const many = Array.from({ length: ACCESS_TOKEN_MAX_FILES + 1 }, () => U1);
    expect(AccessTokenCreateSchema.safeParse({ file_ids: many, principal: "u" }).success).toBe(
      false,
    );
    expect(
      AccessTokenCreateSchema.safeParse({ file_ids: [U1], principal: "u", expires_in: 0 }).success,
    ).toBe(false);
    expect(
      AccessTokenCreateSchema.safeParse({ file_ids: [U1], principal: "u", extra: 1 }).success,
    ).toBe(false);
  });

  it("describes the 201", () => {
    expect(
      AccessTokenCreatedSchema.safeParse({
        id: U1,
        token: `vola_at_${"Z".repeat(40)}`,
        expires_at: "2026-11-18T10:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

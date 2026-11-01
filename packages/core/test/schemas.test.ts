import { describe, expect, it } from "vitest";
import {
  ErrorResponseSchema,
  errorResponse,
  LiveResponseSchema,
  REQUEST_ID_HEADER,
  ReadyResponseSchema,
} from "../src/index.js";

describe("@vola/core schemas", () => {
  it("builds and validates the error envelope", () => {
    const body = errorResponse("not_found", "route GET /x not found");
    expect(ErrorResponseSchema.parse(body)).toEqual({
      error: { code: "not_found", message: "route GET /x not found" },
    });
    expect(
      ErrorResponseSchema.safeParse({ error: { code: "NotFound", message: "" } }).success,
    ).toBe(false);
  });

  it("validates health responses", () => {
    expect(LiveResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
    expect(
      ReadyResponseSchema.parse({ status: "fail", checks: { database: "fail", redis: "ok" } }),
    ).toMatchObject({ status: "fail" });
    expect(ReadyResponseSchema.safeParse({ status: "ok", checks: {} }).success).toBe(false);
  });

  it("names the request id header", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });
});

import { ErrorResponseSchema, LiveResponseSchema, ReadyResponseSchema } from "@vol-a/core";
import { describe, expect, inject, it } from "vitest";

const server = inject("server");

describe("health (built server)", () => {
  it('GET /health/live answers {status:"ok"}', async () => {
    const response = await fetch(`${server}/health/live`);
    expect(response.status).toBe(200);
    expect(LiveResponseSchema.parse(await response.json())).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toMatch(/\S/);
  });

  it("GET /health/ready reaches the database", async () => {
    const response = await fetch(`${server}/health/ready`);
    expect(response.status).toBe(200);
    const body = ReadyResponseSchema.parse(await response.json());
    expect(body.status).toBe("ok");
    expect(body.checks.database).toBe("ok");
  });

  it("echoes X-Request-ID and answers 404 in the error envelope", async () => {
    const response = await fetch(`${server}/nope`, { headers: { "x-request-id": "e2e-42" } });
    expect(response.status).toBe(404);
    expect(response.headers.get("x-request-id")).toBe("e2e-42");
    expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe("not_found");
  });
});

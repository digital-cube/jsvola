import { describe, expect, it } from "vitest";
import { VolaApiError, VolaClient } from "../src/index.js";

function fakeFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const match = Object.entries(routes).find(([path]) => url.endsWith(path));
    if (!match)
      return new Response(JSON.stringify({ error: { code: "not_found", message: url } }), {
        status: 404,
      });
    return new Response(JSON.stringify(match[1].body), { status: match[1].status });
  }) as typeof fetch;
}

describe("VolaClient", () => {
  it("reads health/live and strips a trailing slash from the base URL", async () => {
    const client = new VolaClient({
      baseUrl: "http://vola.test/vola/",
      fetch: fakeFetch({ "/vola/health/live": { status: 200, body: { status: "ok" } } }),
    });
    expect(client.baseUrl).toBe("http://vola.test/vola");
    expect(await client.live()).toEqual({ status: "ok" });
  });

  it("returns a 503 readiness answer instead of throwing", async () => {
    const client = new VolaClient({
      baseUrl: "http://vola.test/vola",
      fetch: fakeFetch({
        "/vola/health/ready": {
          status: 503,
          body: { status: "fail", checks: { database: "fail" } },
        },
      }),
    });
    expect(await client.ready()).toEqual({ status: "fail", checks: { database: "fail" } });
  });

  it("throws VolaApiError with the server's code and sends the API key", async () => {
    let authorization: string | null = null;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ error: { code: "teapot", message: "no" } }), {
        status: 418,
      });
    }) as typeof fetch;
    const client = new VolaClient({ baseUrl: "http://x", apiKey: "vola_test_k", fetch: fetchImpl });
    await expect(client.live()).rejects.toMatchObject({ status: 418, code: "teapot" });
    await expect(client.ready()).rejects.toBeInstanceOf(VolaApiError);
    expect(authorization).toBe("Bearer vola_test_k");
  });

  it("falls back to unknown_error when the body is not the envelope", async () => {
    const client = new VolaClient({
      baseUrl: "http://x",
      fetch: fakeFetch({ "/health/live": { status: 500, body: "boom" } }),
    });
    await expect(client.live()).rejects.toMatchObject({
      code: "unknown_error",
      message: "HTTP 500",
    });
  });
});

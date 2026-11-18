import { describe, expect, it, vi } from "vitest";
import { VolaClient, VolaError } from "../src/index.js";
import { errorResponse, FILE, fakeFetch, jsonResponse } from "./fake.js";

const BASE = "http://vola.test/vola";
const T1 = `vola_at_${"1".repeat(40)}`;
const T2 = `vola_at_${"2".repeat(40)}`;
const URL_A = `/vola/files/${FILE.instance_type}/${FILE.instance_id}/${FILE.id}`;

/** A server that accepts only `valid` as the token of the file route. */
function tokenServer(valid: () => string) {
  return fakeFetch((call) => {
    if (call.path.startsWith(URL_A)) {
      if (call.headers.get("authorization") !== `Bearer ${valid()}`) {
        return errorResponse(401, "unauthorized", "a valid API key is required");
      }
      if (call.path.endsWith("/thumb/128")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/webp", "x-thumbnail-status": "ready" },
        });
      }
      return new Response("abc", { headers: { "content-type": "text/plain" } });
    }
    return undefined;
  });
}

describe("VolaClient with an access token", () => {
  it("sends the token as Authorization: Bearer and downloads with it", async () => {
    const { fetch, calls } = tokenServer(() => T1);
    const client = new VolaClient({ baseUrl: BASE, accessToken: T1, fetch });
    expect(client.accessToken).toBe(T1);
    const response = await client.files.download(FILE.instance_type, FILE.instance_id, FILE.id);
    expect(await response.text()).toBe("abc");
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${T1}`);
    const thumb = await client.files.thumb(FILE.instance_type, FILE.instance_id, FILE.id, 128);
    expect(thumb.status).toBe("ready");
    expect(calls[1]?.headers.get("authorization")).toBe(`Bearer ${T1}`);
  });

  it("gets a fresh token after a 401 and sends the request once more", async () => {
    let valid = T1;
    const { fetch, calls } = tokenServer(() => valid);
    const getAccessToken = vi.fn(async () => T2);
    const client = new VolaClient({ baseUrl: BASE, accessToken: T1, getAccessToken, fetch });
    expect(await (await client.files.download("tickets", FILE.instance_id, FILE.id)).text()).toBe(
      "abc",
    );
    expect(getAccessToken).not.toHaveBeenCalled();

    valid = T2; // T1 expired on the server
    const response = await client.files.download("tickets", FILE.instance_id, FILE.id);
    expect(await response.text()).toBe("abc");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.headers.get("authorization"))).toEqual([
      `Bearer ${T1}`,
      `Bearer ${T1}`,
      `Bearer ${T2}`,
    ]);
    expect(client.accessToken).toBe(T2);
  });

  it("asks for the first token before the first request when none was given", async () => {
    const { fetch, calls } = tokenServer(() => T1);
    const getAccessToken = vi.fn(() => T1);
    const client = new VolaClient({ baseUrl: BASE, getAccessToken, fetch });
    await client.files.download("tickets", FILE.instance_id, FILE.id);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it("tries only once: a second 401 is thrown, and concurrent 401s share one refresh", async () => {
    const { fetch, calls } = tokenServer(() => "never");
    const getAccessToken = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return T2;
    });
    const client = new VolaClient({ baseUrl: BASE, accessToken: T1, getAccessToken, fetch });
    const results = await Promise.allSettled([
      client.files.download("tickets", FILE.instance_id, FILE.id),
      client.files.download("tickets", FILE.instance_id, FILE.id),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      const error = (result as PromiseRejectedResult).reason as VolaError;
      expect(error).toBeInstanceOf(VolaError);
      expect(error.status).toBe(401);
    }
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(4);
  });

  it("does not refresh on a route a token cannot read (its 401 is final)", async () => {
    const { fetch, calls } = fakeFetch(() => errorResponse(401, "unauthorized"));
    const getAccessToken = vi.fn(() => T2);
    const client = new VolaClient({ baseUrl: BASE, accessToken: T1, getAccessToken, fetch });
    await expect(client.files.list("tickets", FILE.instance_id)).rejects.toMatchObject({
      status: 401,
    });
    await expect(client.files.info("tickets", FILE.instance_id, FILE.id)).rejects.toMatchObject({
      status: 401,
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
  });

  it("without getAccessToken a 401 is thrown at once", async () => {
    const { fetch, calls } = tokenServer(() => T2);
    const client = new VolaClient({ baseUrl: BASE, accessToken: T1, fetch });
    await expect(client.files.download("tickets", FILE.instance_id, FILE.id)).rejects.toMatchObject(
      { status: 401, code: "unauthorized" },
    );
    expect(calls).toHaveLength(1);
  });

  it("refuses an API key together with a token, and keeps the token out of options", () => {
    expect(() => new VolaClient({ baseUrl: BASE, apiKey: "vola_test_k", accessToken: T1 })).toThrow(
      /not both/,
    );
    expect(
      () => new VolaClient({ baseUrl: BASE, apiKey: "vola_test_k", getAccessToken: () => T1 }),
    ).toThrow(/not both/);
    const client = new VolaClient({ baseUrl: BASE, accessToken: T1 });
    expect(JSON.stringify(client.options)).not.toContain(T1);
    client.setAccessToken(T2);
    expect(client.accessToken).toBe(T2);
    expect(client.withUnlock("u").accessToken).toBe(T2);
  });
});

describe("client.accessTokens (the host's backend)", () => {
  it("creates and revokes a token with the API key", async () => {
    const created = {
      id: "44444444-4444-4444-8444-444444444444",
      token: T1,
      expires_at: "2026-11-18T12:05:00.000Z",
    };
    const { fetch, calls } = fakeFetch((call) => {
      if (call.method === "POST" && call.path === "/vola/access-tokens") {
        return jsonResponse(created, 201);
      }
      if (call.method === "DELETE" && call.path === `/vola/access-tokens/${created.id}`) {
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    const backend = new VolaClient({ baseUrl: BASE, apiKey: "vola_live_k", fetch, validate: true });
    const result = await backend.accessTokens.create({
      file_ids: [FILE.id],
      principal: "user-a",
      expires_in: 300,
    });
    expect(result).toEqual(created);
    expect(calls[0]?.json).toEqual({ file_ids: [FILE.id], principal: "user-a", expires_in: 300 });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer vola_live_k");
    await expect(backend.accessTokens.revoke(created.id)).resolves.toBeUndefined();
    expect(calls[1]?.method).toBe("DELETE");
  });

  it("throws the server's refusal", async () => {
    const { fetch } = fakeFetch(() =>
      errorResponse(403, "forbidden", 'this API key lacks the scope "access:grant"', {
        required: ["access:grant"],
      }),
    );
    const backend = new VolaClient({ baseUrl: BASE, apiKey: "vola_live_k", fetch });
    await expect(
      backend.accessTokens.create({
        instance: { instance_type: "mail", instance_id: FILE.id },
        principal: "u",
      }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isBrowser,
  VolaClient,
  VolaError,
  VolaIntegrityError,
  VolaLockedError,
} from "../src/index.js";
import { errorResponse, jsonResponse, makeClient } from "./fake.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VolaClient transport", () => {
  it("strips a trailing slash, sends the key, the principal, the tenant and the extra headers", async () => {
    const { client, last } = makeClient(() => jsonResponse({ status: "ok" }), {
      baseUrl: "http://vola.test/vola/",
      userId: "u-1",
      tenantSlug: "acme",
      headers: { "x-request-id": "r-1" },
    });
    expect(client.baseUrl).toBe("http://vola.test/vola");
    await client.instanceTypes();
    expect(last().url).toBe("http://vola.test/vola/instance-types");
    expect(last().headers.get("authorization")).toBe("Bearer vola_test_k");
    expect(last().headers.get("x-user-id")).toBe("u-1");
    expect(last().headers.get("x-tenant-slug")).toBe("acme");
    expect(last().headers.get("x-request-id")).toBe("r-1");
    expect(last().headers.get("accept")).toBe("application/json");
  });

  it("builds query strings: true → 1, false/null/undefined dropped, the rest stringified", () => {
    const { client } = makeClient();
    expect(client.url("/x", { a: true, b: false, c: null, d: undefined, e: 5, f: "s p" })).toBe(
      "http://vola.test/vola/x?a=1&e=5&f=s+p",
    );
    expect(client.url("/x")).toBe("http://vola.test/vola/x");
  });

  it("the health routes work without a key (a 503 readiness is an answer) and send one when there is one", async () => {
    const handler = (call: { path: string }) =>
      call.path.endsWith("/ready")
        ? jsonResponse({ status: "fail", checks: { database: "fail" } }, 503)
        : jsonResponse({ status: "ok" });
    const { client, calls } = makeClient(handler, { apiKey: undefined });
    expect(await client.live()).toEqual({ status: "ok" });
    expect(await client.ready()).toEqual({ status: "fail", checks: { database: "fail" } });
    expect(calls.every((c) => c.headers.get("authorization") === null)).toBe(true);
    const { client: keyed, last } = makeClient(handler);
    await keyed.live();
    expect(last().headers.get("authorization")).toBe("Bearer vola_test_k");
  });

  it("lookups needs no key and takes a locale", async () => {
    const { client, last } = makeClient(
      () => jsonResponse({ locale: "sr", locales: ["en", "sr"], lookups: {} }),
      { apiKey: undefined },
    );
    expect((await client.lookups("sr")).locale).toBe("sr");
    expect(last().url).toBe("http://vola.test/vola/lookups?locale=sr");
    expect(last().headers.get("authorization")).toBeNull();
  });

  it("maps a non-2xx to VolaError with code, message, details, retryAfter and requestId", async () => {
    const { client } = makeClient(() =>
      errorResponse(
        429,
        "too_many_attempts",
        "locked out",
        { attempts: 7, retry_after: 30 },
        { "retry-after": "30", "x-request-id": "req-9" },
      ),
    );
    const error = await client.instanceTypes().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VolaError);
    const vola = error as VolaError;
    expect(vola.status).toBe(429);
    expect(vola.code).toBe("too_many_attempts");
    expect(vola.message).toBe("locked out");
    expect(vola.retryAfter).toBe(30);
    expect(vola.details).toEqual({ attempts: 7, retry_after: 30 });
    expect(vola.requestId).toBe("req-9");
    expect(vola.name).toBe("VolaError");
  });

  it("retryAfter falls back to the body's retry_after when the header is absent", async () => {
    const { client } = makeClient(() => errorResponse(403, "pin_wrong", "no", { retry_after: 5 }));
    await expect(client.instanceTypes()).rejects.toMatchObject({
      retryAfter: 5,
      code: "pin_wrong",
    });
  });

  it("423 is a VolaLockedError, 409 vola_integrity a VolaIntegrityError, another 409 a plain VolaError", async () => {
    let status = 423;
    let code = "vola_locked";
    const { client } = makeClient(() => errorResponse(status, code));
    await expect(client.instanceTypes()).rejects.toBeInstanceOf(VolaLockedError);
    status = 409;
    code = "vola_integrity";
    await expect(client.instanceTypes()).rejects.toBeInstanceOf(VolaIntegrityError);
    code = "file_exists";
    const plain = await client.instanceTypes().catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(VolaError);
    expect(plain).not.toBeInstanceOf(VolaIntegrityError);
  });

  it("falls back to unknown_error for a body that is not the envelope", async () => {
    const { client } = makeClient(() => new Response("boom", { status: 500 }));
    await expect(client.instanceTypes()).rejects.toMatchObject({
      code: "unknown_error",
      message: "HTTP 500",
      status: 500,
    });
  });

  it("validate: a schema mismatch is invalid_response; off by default", async () => {
    const { client: loose } = makeClient(() => jsonResponse({ nope: 1 }));
    expect(await loose.instanceTypes()).toEqual({ nope: 1 });
    const { client: strict } = makeClient(() => jsonResponse({ nope: 1 }), { validate: true });
    await expect(strict.instanceTypes()).rejects.toMatchObject({ code: "invalid_response" });
    const { client: good } = makeClient(() => jsonResponse({ instance_types: [] }), {
      validate: true,
    });
    expect(await good.instanceTypes()).toEqual({ instance_types: [] });
  });

  it("passes the signal to fetch and lets an abort through unchanged", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = makeClient(() => jsonResponse({}));
    await expect(client.instanceTypes({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("sends the unlock token it holds, per-call override wins, withUnlock makes a second instance", async () => {
    const { client, last } = makeClient(() => jsonResponse({ instance_types: [] }));
    await client.instanceTypes();
    expect(last().headers.get("x-vola-unlock")).toBeNull();
    expect(client.unlocked).toBe(false);
    const unlocked = client.withUnlock("tok-1");
    expect(unlocked.unlocked).toBe(true);
    expect(client.unlocked).toBe(false);
    expect(unlocked.options).not.toHaveProperty("unlock");
    await unlocked.instanceTypes();
    expect(last().headers.get("x-vola-unlock")).toBe("tok-1");
    await unlocked.instanceTypes({ unlock: "tok-2" });
    expect(last().headers.get("x-vola-unlock")).toBe("tok-2");
    unlocked.setUnlock(null);
    await unlocked.instanceTypes();
    expect(last().headers.get("x-vola-unlock")).toBeNull();
  });

  it("sends the content key as base64 (bytes or string) and checks the length", async () => {
    const { client, last } = makeClient(() => jsonResponse({ instance_types: [] }));
    const key = new Uint8Array(32).fill(7);
    await client.instanceTypes({ contentKey: key });
    expect(last().headers.get("x-vola-content-key")).toBe(Buffer.from(key).toString("base64"));
    await client.instanceTypes({ contentKey: "YWJj" });
    expect(last().headers.get("x-vola-content-key")).toBe("YWJj");
    await expect(client.instanceTypes({ contentKey: new Uint8Array(5) })).rejects.toMatchObject({
      status: 0,
      code: "bad_request",
    });
  });

  it("refuses the content key in a browser with a clear message, before any request", async () => {
    vi.stubGlobal("window", { document: {} });
    expect(isBrowser()).toBe(true);
    const { client, calls } = makeClient(() => jsonResponse({}));
    const error = await client
      .instanceTypes({ contentKey: new Uint8Array(32) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VolaError);
    expect((error as VolaError).code).toBe("caller_key_from_browser");
    expect((error as VolaError).message).toMatch(/browser/);
    expect(calls).toHaveLength(0);
  });

  it("lockOnUnload is a no-op outside a browser and a beacon with the token in the body inside one", () => {
    const { client } = makeClient();
    expect(typeof client.lockOnUnload()).toBe("function");

    const listeners = new Map<string, () => void>();
    const beacons: { url: string; body: Blob }[] = [];
    vi.stubGlobal("window", {
      document: {},
      addEventListener: (event: string, handler: () => void) => listeners.set(event, handler),
      removeEventListener: (event: string) => listeners.delete(event),
    });
    vi.stubGlobal("navigator", {
      sendBeacon: (url: string, body: Blob) => beacons.push({ url, body }),
    });
    const unlocked = client.withUnlock("tok-beacon");
    const off = unlocked.lockOnUnload();
    expect(listeners.has("pagehide")).toBe(true);
    listeners.get("pagehide")?.();
    expect(beacons).toHaveLength(1);
    expect(beacons[0]?.url).toBe("http://vola.test/vola/keyrings/me/unlock/close");
    expect(beacons[0]?.url).not.toContain("tok-beacon");
    expect(unlocked.unlocked).toBe(false);
    listeners.get("pagehide")?.(); // nothing held any more: no second beacon
    expect(beacons).toHaveLength(1);
    off();
    expect(listeners.has("pagehide")).toBe(false);
  });

  it("udc: a UdcClient on /udc with this instance's auth headers on every call", async () => {
    const { client, last } = makeClient(() =>
      jsonResponse({ kind: "udc.collections.ok", id: "1", payload: { collections: [] } }),
    );
    const udc = client.udc;
    expect(client.udc).toBe(udc);
    expect(await udc.collections()).toEqual({ collections: [] });
    expect(last().url).toBe("http://vola.test/vola/udc/collections");
    expect(last().method).toBe("POST");
    expect(last().headers.get("authorization")).toBe("Bearer vola_test_k");
    expect(last().headers.get("content-type")).toBe("application/json");
  });

  it("openShare (static): the fragment becomes X-Share-Secret and never reaches the URL", async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("bytes", { status: 200 });
    }) as typeof fetch;
    const response = await VolaClient.openShare("http://vola.test/vola/s/tok#S3cr3t", {
      fetch: fetchImpl,
      password: "pw",
      range: { start: 0, end: 1 },
    });
    expect(await response.text()).toBe("bytes");
    expect(seen[0]?.url).toBe("http://vola.test/vola/s/tok");
    expect(seen[0]?.headers.get("x-share-secret")).toBe("S3cr3t");
    expect(seen[0]?.headers.get("x-share-password")).toBe("pw");
    expect(seen[0]?.headers.get("range")).toBe("bytes=0-1");
    expect(seen[0]?.headers.get("authorization")).toBeNull();
  });

  it("request() is the escape hatch: json bodies, custom ok, raw responses", async () => {
    const { client, last } = makeClient((call) =>
      call.json ? new Response(null, { status: 204 }) : errorResponse(418, "teapot"),
    );
    const response = await client.request("/anything", { method: "PUT", json: { a: 1 } });
    expect(response.status).toBe(204);
    expect(last().headers.get("content-type")).toBe("application/json");
    expect(last().text).toBe('{"a":1}');
    const teapot = await client.request("/anything", { ok: (s) => s === 418 });
    expect(teapot.status).toBe(418);
    await expect(client.request("/anything")).rejects.toMatchObject({ code: "teapot" });
  });
});

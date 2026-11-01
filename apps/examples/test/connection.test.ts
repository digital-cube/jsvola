import { describe, expect, it, vi } from "vitest";
import {
  apiPath,
  connectionOf,
  DEFAULT_INSTANCE,
  demoFetch,
  fetchExamplesConfig,
  needsProxy,
} from "../src/connection.js";
import {
  defaultSettings,
  formatBytes,
  loadSettings,
  newVisitorId,
  resetVisitorId,
  STORAGE_KEY,
  saveSettings,
  VISITOR_KEY,
  visitorId,
} from "../src/settings.js";
import { CONFIG, fakeVola, INSTANCE, READ_KEY } from "./fake.js";

const settings = { ...defaultSettings({} as ImportMetaEnv) };

describe("the examples configuration", () => {
  it("is read from the server, null on 404 or a bad answer", async () => {
    expect(await fetchExamplesConfig("/vola", fakeVola().fetch)).toMatchObject({
      api_key: READ_KEY,
    });
    expect(await fetchExamplesConfig("/vola/", fakeVola({ examples: false }).fetch)).toBeNull();
    const broken = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await fetchExamplesConfig("/vola", broken as unknown as typeof fetch)).toBeNull();
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await fetchExamplesConfig("/vola", down as unknown as typeof fetch)).toBeNull();
  });

  it("decides the connection: own key > demo key > none, the instance from the settings or the server", () => {
    const demo = { status: "ready" as const, config: CONFIG };
    expect(connectionOf(settings, demo, "demo-abcdef")).toMatchObject({
      apiKey: READ_KEY,
      source: "demo",
      proxied: true,
      instanceType: "demo",
      instanceId: INSTANCE,
      visitor: "demo-abcdef",
    });
    expect(connectionOf({ ...settings, apiKey: "vola_live_x" }, demo, "demo-a1b2c3")).toMatchObject(
      {
        apiKey: "vola_live_x",
        source: "own",
        proxied: false,
        instanceId: INSTANCE,
      },
    );
    expect(
      connectionOf(
        {
          ...settings,
          instanceType: "tickets",
          instanceId: "11111111-1111-4111-8111-111111111111",
        },
        demo,
        "demo-a1b2c3",
      ),
    ).toMatchObject({
      instanceType: "tickets",
      instanceId: "11111111-1111-4111-8111-111111111111",
    });
    expect(connectionOf(settings, { status: "loading" }, "demo-a1b2c3")).toMatchObject({
      apiKey: "",
      source: "pending",
    });
    expect(connectionOf(settings, { status: "none" }, "demo-a1b2c3")).toMatchObject({
      apiKey: "",
      source: "none",
      instanceType: DEFAULT_INSTANCE.type,
      instanceId: DEFAULT_INSTANCE.id,
    });
    expect(
      connectionOf({ ...settings, baseUrl: "http://x/vola/" }, { status: "none" }, "demo-a1b2c3")
        .baseUrl,
    ).toBe("http://x/vola");
  });
});

describe("the write proxy on the client side", () => {
  it("knows which requests go through the proxy", () => {
    expect(needsProxy("GET", "/files/demo/x")).toBe(false);
    expect(needsProxy("HEAD", "/files/demo/x/y")).toBe(false);
    expect(needsProxy("POST", "/files/demo/x")).toBe(true);
    expect(needsProxy("PATCH", "/files/demo/x/y")).toBe(true);
    expect(needsProxy("DELETE", "/folders/demo/x/a")).toBe(true);
    expect(needsProxy("HEAD", "/uploads/abc")).toBe(true);
    expect(needsProxy("OPTIONS", "/uploads")).toBe(false);
    expect(needsProxy("GET", "/shares?file_id=1")).toBe(false);
    expect(needsProxy("GET", "/shares")).toBe(true);
    expect(needsProxy("GET", "/keyrings/me/status")).toBe(true);
    expect(needsProxy("POST", "/keyrings/me/unlock/close")).toBe(false);
    expect(needsProxy("GET", "/udc/subscribe")).toBe(false);
    expect(needsProxy("POST", "/udc/collections")).toBe(false);
    expect(needsProxy("POST", "/udc/list")).toBe(false);
    expect(needsProxy("POST", "/examples/regenerate/x")).toBe(false);
  });

  it("finds the API path of a request under the base URL", () => {
    expect(apiPath("/vola/files/demo/x", "/vola")).toBe("/files/demo/x");
    expect(apiPath("http://localhost:3000/vola/shares", "/vola")).toBe("/shares");
    expect(apiPath("/vola", "/vola")).toBe("/");
    expect(apiPath("/volatile/x", "/vola")).toBeNull();
    expect(apiPath("https://files.example.com/vola/x", "/vola")).toBeNull();
    expect(apiPath("https://files.example.com/vola/x", "https://files.example.com/vola")).toBe(
      "/x",
    );
  });

  it("rewrites a write to the proxy without the key and leaves reads alone", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const real = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response("{}", { status: 200 });
    });
    const f = demoFetch({
      baseUrl: "/vola",
      writePath: "/vola/examples/write/",
      enabled: true,
      fetch: real as unknown as typeof fetch,
    });
    await f("/vola/files/demo/x", { method: "GET", headers: { authorization: "Bearer k" } });
    expect(seen[0]?.url).toBe("/vola/files/demo/x");
    expect(new Headers(seen[0]?.init?.headers).get("authorization")).toBe("Bearer k");

    const headers = new Headers({
      authorization: "Bearer k",
      "x-user-id": "demo-abcdef",
      "x-vola-unlock": "t",
    });
    await f("/vola/files/demo/x?a=1", { method: "POST", headers, body: "b" });
    expect(seen[1]?.url).toBe("/vola/examples/write/files/demo/x?a=1");
    const sent = new Headers(seen[1]?.init?.headers);
    expect(sent.get("authorization")).toBeNull();
    expect(sent.get("x-user-id")).toBe("demo-abcdef");
    expect(sent.get("x-vola-unlock")).toBe("t");
    expect(seen[1]?.init?.body).toBe("b");

    await f(new URL("http://localhost:3000/vola/uploads/u1"), { method: "HEAD" });
    expect(seen[2]?.url).toBe("/vola/examples/write/uploads/u1");
    await f("/vola/keyrings/me/unlock/close", { method: "POST" });
    expect(seen[3]?.url).toBe("/vola/keyrings/me/unlock/close");
    await f("https://elsewhere.test/x", { method: "POST" });
    expect(seen[4]?.url).toBe("https://elsewhere.test/x");
    await f(new Request("http://localhost:3000/vola/shares", { method: "POST" }));
    expect(seen[5]?.url).toBe("/vola/examples/write/shares");
    expect(seen[5]?.init?.method).toBe("POST");
  });

  it("does nothing when disabled (a key of the visitor's own)", async () => {
    const real = vi.fn(async (..._args: unknown[]) => new Response("{}"));
    const f = demoFetch({
      baseUrl: "/vola",
      writePath: "/vola/examples/write/",
      enabled: false,
      fetch: real as unknown as typeof fetch,
    });
    await f("/vola/files/demo/x", { method: "POST" });
    expect(real).toHaveBeenCalledWith("/vola/files/demo/x", { method: "POST" });
  });

  it("keeps an absolute base URL absolute", async () => {
    const real = vi.fn(async (..._args: unknown[]) => new Response("{}"));
    const f = demoFetch({
      baseUrl: "https://files.example.com/vola",
      writePath: "/vola/examples/write/",
      enabled: true,
      fetch: real as unknown as typeof fetch,
    });
    await f("https://files.example.com/vola/shares", { method: "POST" });
    expect(real.mock.calls[0]?.[0]).toBe("https://files.example.com/vola/examples/write/shares");
  });
});

describe("settings and the visitor", () => {
  it("round-trips the settings and tolerates junk", () => {
    expect(loadSettings(localStorage, settings)).toEqual(settings);
    saveSettings(localStorage, { ...settings, apiKey: "k", instanceType: "t" });
    expect(loadSettings(localStorage, settings)).toMatchObject({
      apiKey: "k",
      instanceType: "t",
      baseUrl: "/vola",
    });
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadSettings(localStorage, settings)).toEqual(settings);
    localStorage.setItem(STORAGE_KEY, '{"baseUrl": 3, "apiKey": null}');
    expect(loadSettings(localStorage, settings)).toEqual(settings);
    expect(
      defaultSettings({ VITE_VOLA_BASE_URL: "/x", VITE_VOLA_API_KEY: "y" } as ImportMetaEnv),
    ).toMatchObject({ baseUrl: "/x", apiKey: "y" });
  });

  it("makes a demo-… id once per session and a new one on request", () => {
    expect(newVisitorId()).toMatch(/^demo-[a-z0-9]{12}$/);
    expect(newVisitorId((b) => b.fill(0))).toBe("demo-aaaaaaaaaaaa");
    const first = visitorId(sessionStorage);
    expect(first).toMatch(/^demo-[a-z0-9]{12}$/);
    expect(visitorId(sessionStorage)).toBe(first);
    sessionStorage.setItem(VISITOR_KEY, "not valid");
    expect(visitorId(sessionStorage)).not.toBe("not valid");
    const next = resetVisitorId(sessionStorage);
    expect(next).not.toBe(first);
    expect(sessionStorage.getItem(VISITOR_KEY)).toBe(next);
  });

  it("formats sizes in binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MiB");
    expect(formatBytes(12.4 * 1024 * 1024)).toBe("12 MiB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3 GiB");
  });
});

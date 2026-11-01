import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { connect, type DatabaseHandle } from "../src/db/index.js";
import { codeForStatus, VolaError } from "../src/errors.js";
import { requestId } from "../src/plugin.js";
import type { RedisLike } from "../src/redis.js";

const config = loadConfig({ ...process.env, VOLA_PREFIX: "/vola" });

class FakeRedis implements RedisLike {
  constructor(private readonly healthy: boolean) {}
  async ping() {
    if (!this.healthy) throw new Error("ECONNREFUSED");
    return "PONG";
  }
  async quit() {}
}

describe("health routes (real database)", () => {
  let handle: DatabaseHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = connect(config.testDatabaseUrl, { max: 2 });
    app = await buildApp({ config, db: handle.db, logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  it('GET /vola/health/live answers {status:"ok"}', async () => {
    const response = await app.inject({ method: "GET", url: "/vola/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("GET /vola/health/ready reports the database (no redis configured)", async () => {
    const response = await app.inject({ method: "GET", url: "/vola/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", checks: { database: "ok" } });
  });

  it("echoes a sane X-Request-ID and generates one otherwise", async () => {
    const echoed = await app.inject({
      method: "GET",
      url: "/vola/health/live",
      headers: { "x-request-id": "req-abc.1:2" },
    });
    expect(echoed.headers["x-request-id"]).toBe("req-abc.1:2");

    const generated = await app.inject({ method: "GET", url: "/vola/health/live" });
    expect(generated.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const rejected = await app.inject({
      method: "GET",
      url: "/vola/health/live",
      headers: { "x-request-id": "bad id with spaces" },
    });
    expect(rejected.headers["x-request-id"]).not.toBe("bad id with spaces");
  });

  it('answers 404 {error:{code:"not_found"}} for an unknown route, inside and outside the prefix', async () => {
    for (const url of ["/vola/nope", "/nope"]) {
      const response = await app.inject({ method: "GET", url, headers: { "x-request-id": "x1" } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: "not_found", message: `route GET ${url} not found` },
      });
      expect(response.headers["x-request-id"]).toBe("x1");
    }
  });
});

describe("health/ready with failing dependencies", () => {
  it("answers 503 when the database is unreachable", async () => {
    const dead = connect("postgresql://vola:vola@127.0.0.1:1/vola", { max: 1 });
    const app = await buildApp({ config, db: dead.db, redis: new FakeRedis(true), logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/vola/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: "fail",
        checks: { database: "fail", redis: "ok" },
      });
    } finally {
      await app.close();
      await dead.close();
    }
  });

  it("answers 503 when redis is configured but down", async () => {
    const handle = connect(config.testDatabaseUrl, { max: 1 });
    const app = await buildApp({
      config,
      db: handle.db,
      redis: new FakeRedis(false),
      logger: false,
    });
    try {
      const response = await app.inject({ method: "GET", url: "/vola/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: "fail",
        checks: { database: "ok", redis: "fail" },
      });
    } finally {
      await app.close();
      await handle.close();
    }
  });
});

describe("error envelope", () => {
  let handle: DatabaseHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    handle = connect(config.testDatabaseUrl, { max: 1 });
    app = await buildApp({ config, db: handle.db, logger: false });
    app.get("/vola/boom", async () => {
      throw new VolaError("teapot", 418, "short and stout");
    });
    app.get("/vola/crash", async () => {
      throw new Error("secret details");
    });
    app.post("/vola/echo", async (request) => request.body);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  it("maps VolaError to its status and code", async () => {
    const response = await app.inject({ method: "GET", url: "/vola/boom" });
    expect(response.statusCode).toBe(418);
    expect(response.json()).toEqual({ error: { code: "teapot", message: "short and stout" } });
  });

  it("hides unexpected errors behind 500 internal_error", async () => {
    const response = await app.inject({ method: "GET", url: "/vola/crash" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "internal_error", message: "internal server error" },
    });
  });

  it("maps framework errors by status (malformed JSON → 400 bad_request)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/vola/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
  });
});

describe("helpers", () => {
  it("codeForStatus knows the listed statuses and falls back by class", () => {
    expect(codeForStatus(404)).toBe("not_found");
    expect(codeForStatus(423)).toBe("locked");
    expect(codeForStatus(418)).toBe("bad_request");
    expect(codeForStatus(599)).toBe("internal_error");
  });

  it("requestId takes the first header value", () => {
    expect(requestId(["first", "second"])).toBe("first");
    expect(requestId(undefined)).toMatch(/-/);
  });
});

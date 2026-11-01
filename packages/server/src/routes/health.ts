import type { CheckStatus, ReadyResponse } from "@vola/core";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { Database } from "../db/index.js";
import type { RedisLike } from "../redis.js";

export interface HealthDeps {
  db: Database;
  redis?: RedisLike | undefined;
  /** Per-check timeout; a dependency that does not answer in time is `fail`. Default 5000. */
  timeoutMs?: number;
}

async function probe(check: () => Promise<unknown>, timeoutMs: number): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    await Promise.race([check(), timeout]);
    return "ok";
  } catch {
    return "fail";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `GET /health/live` — the process answers. `GET /health/ready` — PostgreSQL (and Redis when
 * configured) answer; 503 with the failing checks otherwise. No API key needed.
 */
export const healthRoutes: FastifyPluginAsync<HealthDeps> = async (app, deps) => {
  const timeoutMs = deps.timeoutMs ?? 5000;

  app.get("/health/live", async () => ({ status: "ok" }) as const);

  app.get("/health/ready", async (_request, reply) => {
    const [database, redis] = await Promise.all([
      probe(() => deps.db.execute(sql`select 1`), timeoutMs),
      deps.redis ? probe(() => (deps.redis as RedisLike).ping(), timeoutMs) : undefined,
    ]);
    const checks: ReadyResponse["checks"] = { database, ...(redis ? { redis } : {}) };
    const ok = Object.values(checks).every((status) => status === "ok");
    const body: ReadyResponse = { status: ok ? "ok" : "fail", checks };
    return reply.status(ok ? 200 : 503).send(body);
  });
};

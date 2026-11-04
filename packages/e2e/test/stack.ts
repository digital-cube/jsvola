import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateApiKey, generateKeyLine, loadConfig } from "@vol-a/server";
import { Redis } from "ioredis";
import type { TestProject } from "vitest/node";
import { spawnProcess, startServer, stop, UI_DIR, WORKER_ENTRY } from "./spawn.js";

/**
 * Brings up the server the E2E suite talks to and hands it the base URL.
 *
 * - `VOLA_E2E_URL` set (e.g. `http://localhost:8300/vola`, the docker-compose stack):
 *   nothing is started, the suite talks to that server. With `VOLA_DEMO_API_KEY` and
 *   `VOLA_DEMO_WRITE_KEY` in the environment the examples suite uses those keys.
 * - otherwise the built server (`packages/server/dist/server.js`) is started on a free port
 *   against the test database (`VOLA_DATABASE_URL_TEST`) and `VOLA_REDIS_URL` — with the
 *   examples on (two fresh demo keys, the built site of `apps/examples/dist` at `/` when it
 *   exists) — and, with Redis, the built worker (`dist/worker.js`) next to it on a private
 *   queue prefix, so the thumbnail suite exercises the real two-process path.
 */

declare module "vitest" {
  export interface ProvidedContext {
    /** API base URL (`…/vola`). */
    server: string;
    /** `true` when the stack runs a worker process (Redis configured, own stack). */
    worker: boolean;
    /** The blob store of the suite's own server (`null` for an external `VOLA_E2E_URL`). */
    storagePath: string | null;
    /** The examples site's keys (`null`: the external server was not given any). */
    examples: { apiKey: string; writeKey: string } | null;
    /** `true` when the server serves the built site at `/`. */
    ui: boolean;
    /** The environment the suite's own server was started with (a second server for the gating test). */
    serverEnv: Record<string, string> | null;
  }
}

export default async function setup({ provide }: TestProject) {
  const external = process.env.VOLA_E2E_URL;
  if (external) {
    const base = external.replace(/\/+$/, "");
    const response = await fetch(`${base}/health/live`).catch((error: unknown) => {
      throw new Error(`VOLA_E2E_URL ${base} is not reachable: ${String(error)}`);
    });
    if (!response.ok) throw new Error(`${base}/health/live answered ${response.status}`);
    provide("server", base);
    provide("worker", false);
    provide("storagePath", null);
    const apiKey = process.env.VOLA_DEMO_API_KEY;
    const writeKey = process.env.VOLA_DEMO_WRITE_KEY;
    provide("examples", apiKey && writeKey ? { apiKey, writeKey } : null);
    provide("ui", process.env.VOLA_E2E_UI !== "false");
    provide("serverEnv", null);
    return;
  }

  const config = loadConfig();
  // The suite's own server (and worker) store blobs in a throw-away directory.
  const storagePath = await mkdtemp(join(tmpdir(), "vola-e2e-storage-"));
  const keyFile = join(storagePath, "vola.key");
  await writeFile(keyFile, `${generateKeyLine()}\n`, { mode: 0o600 });
  const pepperFile = join(storagePath, "vola.pepper");
  await writeFile(pepperFile, `${generateKeyLine()}\n`, { mode: 0o600 });
  const queuePrefix = `vola-e2e-${randomUUID().slice(0, 8)}`;
  const examples = { apiKey: generateApiKey("test").key, writeKey: generateApiKey("test").key };
  const ui = existsSync(join(UI_DIR, "index.html"));
  const env: Record<string, string> = {
    VOLA_DATABASE_URL: config.testDatabaseUrl,
    ...(config.redisUrl ? { VOLA_REDIS_URL: config.redisUrl } : {}),
    VOLA_STORAGE_PATH: storagePath,
    VOLA_QUEUE_PREFIX: queuePrefix,
    VOLA_KEY_FILE: keyFile,
    VOLA_PEPPER_FILE: pepperFile,
  };
  const serverEnv: Record<string, string> = {
    ...env,
    VOLA_EXAMPLES: "true",
    VOLA_DEMO_API_KEY: examples.apiKey,
    VOLA_DEMO_WRITE_KEY: examples.writeKey,
    VOLA_DEMO_TENANT: "demo-e2e",
    VOLA_DEMO_PURGE_INTERVAL_MIN: "0",
    ...(ui ? { VOLA_UI_DIR: UI_DIR } : {}),
  };
  const { base, child: server } = await startServer(serverEnv);
  const worker: ChildProcess | null = config.redisUrl
    ? spawnProcess(WORKER_ENTRY, env).child
    : null;
  provide("server", base);
  provide("worker", worker !== null);
  provide("storagePath", storagePath);
  provide("examples", examples);
  provide("ui", ui);
  provide("serverEnv", serverEnv);
  return async () => {
    await Promise.all([stop(server), stop(worker)]);
    if (config.redisUrl) {
      // The private queue keys of this run.
      const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
      try {
        const keys = await redis.keys(`${queuePrefix}:*`);
        if (keys.length > 0) await redis.del(...keys);
      } finally {
        await redis.quit().catch(() => undefined);
      }
    }
    await rm(storagePath, { recursive: true, force: true });
  };
}

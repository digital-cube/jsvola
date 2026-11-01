import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyLine, loadConfig } from "@vola/server";
import { Redis } from "ioredis";
import type { TestProject } from "vitest/node";

/**
 * Brings up the server the E2E suite talks to and hands it the base URL.
 *
 * - `VOLA_E2E_URL` set (e.g. `http://localhost:8300/vola`, the docker-compose stack):
 *   nothing is started, the suite talks to that server.
 * - otherwise the built server (`packages/server/dist/server.js`) is started on a free port
 *   against the test database (`VOLA_DATABASE_URL_TEST`) and `VOLA_REDIS_URL` — and, with
 *   Redis, the built worker (`dist/worker.js`) next to it on a private queue prefix, so the
 *   thumbnail suite exercises the real two-process path.
 */

const SERVER_ENTRY = fileURLToPath(new URL("../../server/dist/server.js", import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL("../../server/dist/worker.js", import.meta.url));

declare module "vitest" {
  export interface ProvidedContext {
    /** API base URL (`…/vola`). */
    server: string;
    /** `true` when the stack runs a worker process (Redis configured, own stack). */
    worker: boolean;
    /** The blob store of the suite's own server (`null` for an external `VOLA_E2E_URL`). */
    storagePath: string | null;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitLive(base: string, child: ChildProcess, output: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${child.exitCode}:\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${base}/health/live`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${base} not live after 30 s:\n${output.join("")}`);
}

interface StackEnv {
  databaseUrl: string;
  redisUrl: string | null;
  storagePath: string;
  /** Private BullMQ prefix of this run (server and worker share it). */
  queuePrefix: string;
  /** The tenant-encryption key file of this run (`VOLA_KEY_FILE`), one fresh line. */
  keyFile: string;
  /** The keyring pepper file of this run (`VOLA_PEPPER_FILE`), one fresh line. */
  pepperFile: string;
}

function spawnProcess(entry: string, env: StackEnv, extra: Record<string, string>) {
  const output: string[] = [];
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      VOLA_DATABASE_URL: env.databaseUrl,
      ...(env.redisUrl ? { VOLA_REDIS_URL: env.redisUrl } : {}),
      VOLA_STORAGE_PATH: env.storagePath,
      VOLA_QUEUE_PREFIX: env.queuePrefix,
      VOLA_KEY_FILE: env.keyFile,
      VOLA_PEPPER_FILE: env.pepperFile,
      VOLA_LOG_LEVEL: process.env.VOLA_E2E_LOG_LEVEL ?? "warn",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      output.push(String(chunk));
      if (process.env.VOLA_E2E_LOG_LEVEL) process.stderr.write(chunk);
    });
  }
  return { child, output };
}

async function startServer(env: StackEnv): Promise<[string, ChildProcess]> {
  const port = await freePort();
  const { child, output } = spawnProcess(SERVER_ENTRY, env, {
    VOLA_HOST: "127.0.0.1",
    VOLA_PORT: String(port),
  });
  const base = `http://127.0.0.1:${port}/vola`;
  await waitLive(base, child, output);
  return [base, child];
}

/** The worker (only with Redis): `node dist/worker.js`, the same build as the server. */
function startWorker(env: StackEnv): ChildProcess | null {
  if (!env.redisUrl) return null;
  const { child } = spawnProcess(WORKER_ENTRY, env, {});
  return child;
}

function stop(child: ChildProcess | null): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
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
    return;
  }

  const config = loadConfig();
  // The suite's own server (and worker) store blobs in a throw-away directory.
  const storagePath = await mkdtemp(join(tmpdir(), "vola-e2e-storage-"));
  const keyFile = join(storagePath, "vola.key");
  await writeFile(keyFile, `${generateKeyLine()}\n`, { mode: 0o600 });
  const pepperFile = join(storagePath, "vola.pepper");
  await writeFile(pepperFile, `${generateKeyLine()}\n`, { mode: 0o600 });
  const env: StackEnv = {
    databaseUrl: config.testDatabaseUrl,
    redisUrl: config.redisUrl,
    storagePath,
    queuePrefix: `vola-e2e-${randomUUID().slice(0, 8)}`,
    keyFile,
    pepperFile,
  };
  const [base, server] = await startServer(env);
  const worker = startWorker(env);
  provide("server", base);
  provide("worker", worker !== null);
  provide("storagePath", storagePath);
  return async () => {
    await Promise.all([stop(server), stop(worker)]);
    if (env.redisUrl) {
      // The private queue keys of this run.
      const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
      try {
        const keys = await redis.keys(`${env.queuePrefix}:*`);
        if (keys.length > 0) await redis.del(...keys);
      } finally {
        await redis.quit().catch(() => undefined);
      }
    }
    await rm(env.storagePath, { recursive: true, force: true });
  };
}

import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@vola/server";
import type { TestProject } from "vitest/node";

/**
 * Brings up the server the E2E suite talks to and hands it the base URL.
 *
 * - `VOLA_E2E_URL` set (e.g. `http://localhost:8300/vola`, the docker-compose stack):
 *   nothing is started, the suite talks to that server.
 * - otherwise the built server (`packages/server/dist/server.js`) is started on a free port
 *   against the test database (`VOLA_DATABASE_URL_TEST`) and `VOLA_REDIS_URL`.
 */

const SERVER_ENTRY = fileURLToPath(new URL("../../server/dist/server.js", import.meta.url));

declare module "vitest" {
  export interface ProvidedContext {
    /** API base URL (`…/vola`). */
    server: string;
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

async function startServer(
  databaseUrl: string,
  redisUrl: string | null,
): Promise<[string, ChildProcess]> {
  const port = await freePort();
  const output: string[] = [];
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      VOLA_DATABASE_URL: databaseUrl,
      ...(redisUrl ? { VOLA_REDIS_URL: redisUrl } : {}),
      VOLA_HOST: "127.0.0.1",
      VOLA_PORT: String(port),
      VOLA_LOG_LEVEL: process.env.VOLA_E2E_LOG_LEVEL ?? "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      output.push(String(chunk));
      if (process.env.VOLA_E2E_LOG_LEVEL) process.stderr.write(chunk);
    });
  }
  const base = `http://127.0.0.1:${port}/vola`;
  await waitLive(base, child, output);
  return [base, child];
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
    return;
  }

  const config = loadConfig();
  const [base, child] = await startServer(config.testDatabaseUrl, config.redisUrl);
  provide("server", base);
  return () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
}

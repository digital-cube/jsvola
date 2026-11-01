import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

/** The built server and worker the E2E suite runs (`packages/server/dist`). */
export const SERVER_ENTRY = fileURLToPath(new URL("../../server/dist/server.js", import.meta.url));
export const WORKER_ENTRY = fileURLToPath(new URL("../../server/dist/worker.js", import.meta.url));
/** The built examples site (`apps/examples/dist`), served by the suite's own server at `/`. */
export const UI_DIR = fileURLToPath(new URL("../../../apps/examples/dist", import.meta.url));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export async function waitLive(base: string, child: ChildProcess, output: string[]): Promise<void> {
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

export interface SpawnedProcess {
  child: ChildProcess;
  output: string[];
}

/** `node <entry>` with `env` over the current environment, its output collected (and echoed with `VOLA_E2E_LOG_LEVEL`). */
export function spawnProcess(entry: string, env: Record<string, string>): SpawnedProcess {
  const output: string[] = [];
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, VOLA_LOG_LEVEL: process.env.VOLA_E2E_LOG_LEVEL ?? "warn", ...env },
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

/** A built server on a free port; resolves with its API base (`http://127.0.0.1:<port>/vola`) once live. */
export async function startServer(
  env: Record<string, string>,
): Promise<{ base: string; child: ChildProcess; output: string[] }> {
  const port = await freePort();
  const { child, output } = spawnProcess(SERVER_ENTRY, {
    ...env,
    VOLA_HOST: "127.0.0.1",
    VOLA_PORT: String(port),
  });
  const base = `http://127.0.0.1:${port}/vola`;
  await waitLive(base, child, output);
  return { base, child, output };
}

export function stop(child: ChildProcess | null): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

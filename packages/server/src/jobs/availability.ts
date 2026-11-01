import type { FastifyBaseLogger } from "fastify";

/**
 * `VOLA_WORKER_ENABLED`: `auto` (the default) runs jobs through the worker when Redis is
 * configured; `true` insists on it; `false` never uses it even when Redis is there — the
 * right setting for a deployment with Redis but no worker process, where a queued thumbnail
 * would otherwise answer `202` forever.
 */
export type WorkerEnabled = "auto" | boolean;

/** How this process gets its background work done. */
export type JobsMode = "async" | "sync";

export interface ResolveJobsModeInput {
  enabled: WorkerEnabled;
  redisUrl: string | null;
  log?: Pick<FastifyBaseLogger, "info" | "error"> | undefined;
}

/**
 * Decides, once per process, whether background jobs go to the queue (`async`) or whether the
 * server does the work itself (`sync`: thumbnails are rendered inline on `/thumb`, OCR does
 * not run). A deployment without a worker is a supported configuration, so `sync` is logged
 * once at INFO, never as an error; the one misconfiguration — `VOLA_WORKER_ENABLED=1`
 * without `VOLA_REDIS_URL` — is one ERROR line, and the process degrades to `sync`.
 */
export function resolveJobsMode(input: ResolveJobsModeInput): JobsMode {
  const hasRedis = input.redisUrl !== null;
  if (input.enabled === true && !hasRedis) {
    input.log?.error(
      {
        reason: "VOLA_WORKER_ENABLED is on but VOLA_REDIS_URL is not set",
        hint: "set VOLA_REDIS_URL and run the worker, or unset VOLA_WORKER_ENABLED",
      },
      "background jobs misconfigured: running synchronously",
    );
    return "sync";
  }
  const enabled = input.enabled === "auto" ? hasRedis : input.enabled;
  if (!enabled) {
    input.log?.info(
      {
        reason: input.enabled === false ? "explicitly disabled" : "no VOLA_REDIS_URL",
        effect: "thumbnails are rendered inline on /thumb; OCR does not run",
      },
      "background jobs disabled",
    );
    return "sync";
  }
  return "async";
}

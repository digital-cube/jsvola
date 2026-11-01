/**
 * The worker process of `@vola/server`: `node dist/worker.js` (`pnpm start:worker`). The same
 * image and configuration as the server; it needs `VOLA_REDIS_URL` and the SAME storage
 * directory (thumbnails are written next to the blobs). Migrations are the server's job: the
 * worker only connects. SIGTERM / SIGINT let the active jobs finish, then exit.
 */
import { join } from "node:path";
import { pino } from "pino";
import { ConfigError, loadConfig } from "./config.js";
import { connect } from "./db/index.js";
import { createFileEventBus } from "./events/bus.js";
import { ProcessingWorker } from "./jobs/worker.js";
import { FilesystemBackend } from "./storage/index.js";
import { PartStore } from "./uploads/part-store.js";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`vola-worker: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const log = pino({ level: config.logLevel, name: "vola-worker" });

if (!config.redisUrl) {
  log.error("VOLA_REDIS_URL is not set: the worker has no queue to consume");
  process.exit(1);
}

const database = connect(config.databaseUrl);
const events = createFileEventBus(config.redisUrl, { log });
const worker = new ProcessingWorker({
  redisUrl: config.redisUrl,
  prefix: config.worker.queuePrefix,
  concurrency: config.worker.concurrency,
  db: database.db,
  storage: new FilesystemBackend(config.storagePath),
  events,
  logger: log,
  uploads: {
    parts: new PartStore(join(config.storagePath, "uploads")),
    ttlMs: config.uploadTtlHours * 3_600_000,
    maxUploadBytes: config.maxUploadBytes,
  },
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info({ signal }, "shutting down: finishing active jobs");
  await worker.close();
  await events.close().catch(() => undefined);
  await database.close().catch(() => undefined);
  log.info("worker stopped");
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}

await worker.ready();
log.info(
  {
    concurrency: config.worker.concurrency,
    queue: `${config.worker.queuePrefix}:vola-processing`,
    storage: config.storagePath,
  },
  "vola worker ready",
);

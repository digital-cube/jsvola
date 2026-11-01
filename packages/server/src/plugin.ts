import { randomUUID } from "node:crypto";
import { errorResponse, REQUEST_ID_HEADER } from "@vola/core";
import type { FastifyError, FastifyInstance, FastifyPluginAsync } from "fastify";
import { installAuth } from "./auth.js";
import type { Config } from "./config.js";
import type { Database } from "./db/index.js";
import { codeForStatus, VolaError } from "./errors.js";
import type { RedisLike } from "./redis.js";
import { fileRoutes } from "./routes/files.js";
import { healthRoutes } from "./routes/health.js";
import { keyRoutes } from "./routes/keys.js";
import type { LastUsedThrottle } from "./services/apikeys.js";
import { FilesystemBackend, type StorageBackend } from "./storage/index.js";

export interface VolaPluginOptions {
  config: Config;
  db: Database;
  /** A connected Redis client; without one nothing uses Redis and `/health/ready` skips it. */
  redis?: RedisLike | undefined;
  /** Shared `last_used_at` throttle (tests); default: one per plugin instance. */
  lastUsed?: LastUsedThrottle | undefined;
  /** Blob storage; default: `FilesystemBackend` on `config.storagePath`. */
  storage?: StorageBackend | undefined;
  /** Throttle of `last_accessed_at` writes (tests); default: one per plugin instance. */
  accessThrottle?: LastUsedThrottle | undefined;
  /**
   * Registers more routes INSIDE the plugin, after the built-in ones: they share its prefix,
   * error envelope and auth (`config.scope`, `config.auth`). For a host application's own
   * vola routes and for tests.
   */
  extend?: ((app: FastifyInstance) => Promise<void> | void) | undefined;
}

const REQUEST_ID_RE = /^[\w.:-]{1,128}$/;

/** Accepts a sane incoming `X-Request-ID`, otherwise generates a UUID. */
export function requestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && REQUEST_ID_RE.test(value) ? value : randomUUID();
}

/**
 * Error envelope and request-id echo for `app`: every `VolaError` becomes its status with
 * `{ error: { code, message } }`, framework errors map by status, anything else is a logged
 * `500 internal_error`; unknown routes answer `404 not_found`.
 */
export function installErrorHandling(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.setErrorHandler((error: FastifyError | VolaError, request, reply) => {
    if (error instanceof VolaError) {
      if (error.status >= 500) request.log.error({ err: error }, error.message);
      else request.log.info({ code: error.code }, error.message);
      return reply
        .status(error.status)
        .send(errorResponse(error.code, error.message, error.details));
    }
    const status = error.statusCode ?? 500;
    if (status < 500) {
      request.log.info({ err: error }, error.message);
      return reply.status(status).send(errorResponse(codeForStatus(status), error.message));
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send(errorResponse("internal_error", "internal server error"));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send(errorResponse("not_found", `route ${request.method} ${request.url} not found`)),
  );
}

/**
 * The vola API as an encapsulated Fastify plugin. Register it with a `prefix` (the
 * `config.prefix`, e.g. `/vola`) — `buildApp` does that for the standalone server, a host
 * application does it to embed vola. The host's `genReqId` decides the request id; the
 * plugin echoes it as `X-Request-ID` (see `requestId` for the standalone behaviour).
 *
 * Every route needs an API key unless it declares `config.auth = "none"` (health does); a
 * route declares the scope it needs with `config.scope` (see `installAuth`).
 */
export const volaPlugin: FastifyPluginAsync<VolaPluginOptions> = async (app, options) => {
  installErrorHandling(app);
  installAuth(app, options.db, { lastUsed: options.lastUsed });
  const storage = options.storage ?? new FilesystemBackend(options.config.storagePath);
  await app.register(healthRoutes, { db: options.db, redis: options.redis });
  await app.register(keyRoutes, { db: options.db });
  await app.register(fileRoutes, {
    db: options.db,
    storage,
    maxUploadBytes: options.config.maxUploadBytes,
    accessThrottle: options.accessThrottle,
  });
  if (options.extend) await options.extend(app);
};

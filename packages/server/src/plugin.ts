import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyWebsocket from "@fastify/websocket";
import type { CollectionRegistry } from "@jsudc/server";
import { errorResponse, REQUEST_ID_HEADER } from "@vola/core";
import type { FastifyError, FastifyInstance, FastifyPluginAsync } from "fastify";
import { installAuth } from "./auth.js";
import type { Config } from "./config.js";
import type { Database } from "./db/index.js";
import { codeForStatus, VolaError } from "./errors.js";
import { createFileEventBus, type FileEventBus } from "./events/bus.js";
import { emptyLookups, initLookups, type Lookups } from "./lookups.js";
import type { RedisLike } from "./redis.js";
import { fileRoutes } from "./routes/files.js";
import { folderRoutes } from "./routes/folders.js";
import { healthRoutes } from "./routes/health.js";
import { keyRoutes } from "./routes/keys.js";
import { lookupRoutes } from "./routes/lookups.js";
import { publicRoutes } from "./routes/public.js";
import { uploadRoutes } from "./routes/uploads.js";
import type { LastUsedThrottle } from "./services/apikeys.js";
import { FilesystemBackend, type StorageBackend } from "./storage/index.js";
import { filesCollections } from "./udc/collections.js";
import type { DecorateRow } from "./udc/files-source.js";
import { SubscriptionHub } from "./udc/hub.js";
import { menuCollection } from "./udc/menu.js";
import { udcRoutes } from "./udc/plugin.js";
import { selectSubprotocol, subscribeRoutes } from "./udc/subscribe-route.js";

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
  /** Directory of resumable-upload part files; default `<config.storagePath>/uploads`. */
  uploadsPath?: string | undefined;
  /** Period of the expired-upload sweep in ms; `0` disables it (tests). Default 15 minutes. */
  uploadSweepIntervalMs?: number | undefined;
  /**
   * The controlled vocabulary (`GET /lookups`, candidate recording). Default: loaded from
   * `config.lookups` — an absent `lookups.yaml` gives an empty vocabulary, with a warning.
   */
  lookups?: Lookups | undefined;
  /**
   * The UDC collections served under `/udc/<action>` (`@jsudc/server`). Default: the `files`
   * collection (`filesCollections`), plus the `menu` when its YAML exists; `false`: none.
   */
  udc?: CollectionRegistry | false | undefined;
  /**
   * The menu YAML served as the `menu` UDC collection. Default: `config.menuPath` when the
   * file exists; `false`: no `menu` collection. A path given here must exist.
   */
  menu?: string | false | undefined;
  /** Phase-6 hook of the `files` collection: decorates every row after the built-in masking. */
  decorateRow?: DecorateRow | undefined;
  /**
   * The bus every file change is announced on and the `files` collection's `subscribe`
   * listens to. Default: Redis pub/sub on `config.redisUrl` when set, in-process otherwise
   * (`createFileEventBus`); a bus made here is closed with the app. `false`: no events and
   * no `/udc/subscribe` route.
   */
  events?: FileEventBus | false | undefined;
  /**
   * The real-time WebSocket (`/udc/subscribe`): heartbeat and slow-consumer limits. Default:
   * `config.subscribe`. `false`: no route (events are still published).
   */
  subscribe?: Partial<SubscribeOptions> | false | undefined;
  /**
   * Registers more routes INSIDE the plugin, after the built-in ones: they share its prefix,
   * error envelope and auth (`config.scope`, `config.auth`). For a host application's own
   * vola routes and for tests.
   */
  extend?: ((app: FastifyInstance) => Promise<void> | void) | undefined;
}

/**
 * The vocabulary of `config.lookups`: loaded when `lookups.yaml` exists (candidate recording
 * failures are logged, never raised), empty with a warning otherwise.
 */
async function loadLookups(app: FastifyInstance, config: Config): Promise<Lookups> {
  const { path, translationsPath, candidatesDir } = config.lookups;
  if (!existsSync(path)) {
    app.log.warn({ path }, "lookups.yaml not found: the vocabulary is empty");
    return emptyLookups();
  }
  const lookups = await initLookups({
    path,
    translationsPath,
    candidatesDir,
    onError: (error) => app.log.warn({ err: error }, "lookup candidate not recorded"),
  });
  for (const warning of lookups.warnings) {
    app.log.warn(
      { line: warning.line, column: warning.column },
      `translations: ${warning.message}`,
    );
  }
  app.log.info(
    {
      path,
      sections: lookups.registry.sectionNames(),
      locales: lookups.locales,
      candidates: lookups.recorder?.dir ?? null,
    },
    "lookups loaded",
  );
  return lookups;
}

export interface SubscribeOptions {
  /** A WebSocket ping this often; a client that missed the last one is terminated. */
  heartbeatIntervalMs: number;
  /** Unwritten messages a connection may pile up before it is closed with 4008. */
  maxBufferedMessages: number;
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
  let events: FileEventBus | undefined;
  if (options.events === undefined) {
    events = createFileEventBus(options.config.redisUrl, { log: app.log });
    const owned = events;
    app.addHook("onClose", async () => owned.close());
  } else if (options.events) {
    events = options.events;
  }
  const subscribe =
    events && options.udc !== false && options.subscribe !== false
      ? (options.subscribe ?? {})
      : null;
  let hub: SubscriptionHub | null = null;
  if (subscribe) {
    // Before @fastify/websocket's preClose, which closes sockets without a code: ours says 1001.
    app.addHook("preClose", async () => hub?.close());
    // Before the auth hooks: a refused upgrade is answered (401/403) and its socket destroyed
    // only when @fastify/websocket saw the request first. A host that registered it is reused.
    if (!app.hasDecorator("websocketServer")) {
      await app.register(fastifyWebsocket, {
        options: { maxPayload: 64 * 1024, handleProtocols: selectSubprotocol },
      });
    }
  }
  installAuth(app, options.db, { lastUsed: options.lastUsed });
  const storage = options.storage ?? new FilesystemBackend(options.config.storagePath);
  const lookups = options.lookups ?? (await loadLookups(app, options.config));
  await app.register(healthRoutes, { db: options.db, redis: options.redis });
  await app.register(keyRoutes, { db: options.db });
  await app.register(lookupRoutes, { db: options.db, lookups });
  await app.register(fileRoutes, {
    db: options.db,
    storage,
    maxUploadBytes: options.config.maxUploadBytes,
    accessThrottle: options.accessThrottle,
    lookups,
    events,
  });
  await app.register(uploadRoutes, {
    db: options.db,
    storage,
    uploadsPath: options.uploadsPath ?? join(options.config.storagePath, "uploads"),
    maxUploadBytes: options.config.maxUploadBytes,
    uploadTtlHours: options.config.uploadTtlHours,
    sweepIntervalMs: options.uploadSweepIntervalMs,
    lookups,
    events,
  });
  await app.register(folderRoutes, { db: options.db, events });
  await app.register(publicRoutes, {
    db: options.db,
    storage,
    accessThrottle: options.accessThrottle,
  });
  if (options.udc !== false) {
    const registry =
      options.udc ??
      filesCollections({
        db: options.db,
        prefix: app.prefix,
        decorateRow: options.decorateRow,
        events,
        logger: app.log,
      });
    const menu =
      options.menu === undefined
        ? existsSync(options.config.menuPath)
          ? options.config.menuPath
          : null
        : options.menu || null;
    if (menu) registry.register(menuCollection({ file: menu, registry }));
    else if (options.menu === undefined) {
      app.log.warn({ path: options.config.menuPath }, "menu.yaml not found: no menu collection");
    }
    await app.register(udcRoutes, { db: options.db, registry, lastUsed: options.lastUsed });
    if (subscribe) {
      hub = new SubscriptionHub({
        registry,
        log: app.log,
        heartbeatIntervalMs:
          subscribe.heartbeatIntervalMs ?? options.config.subscribe.heartbeatIntervalMs,
        maxBufferedMessages:
          subscribe.maxBufferedMessages ?? options.config.subscribe.maxBufferedMessages,
      });
      await app.register(subscribeRoutes, { hub });
    }
  }
  if (options.extend) await options.extend(app);
};

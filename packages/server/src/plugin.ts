import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyWebsocket from "@fastify/websocket";
import type { CollectionRegistry } from "@jsudc/server";
import { errorResponse, REQUEST_ID_HEADER } from "@vola/core";
import type { FastifyError, FastifyInstance, FastifyPluginAsync } from "fastify";
import { AuditLog, createAuditSink, disabledAuditLog } from "./audit/log.js";
import { installAuth } from "./auth.js";
import type { Config, ExamplesConfig } from "./config.js";
import {
  EncryptionUnavailableError,
  IntegrityError,
  KeyFile,
  LockedError,
} from "./crypto/index.js";
import type { Database } from "./db/index.js";
import { codeForStatus, VolaError } from "./errors.js";
import { createFileEventBus, type FileEventBus } from "./events/bus.js";
import { type ExamplesRoutesDeps, examplesRoutes } from "./examples/routes.js";
import { type JobsMode, resolveJobsMode } from "./jobs/availability.js";
import { type JobDispatcher, QueuedJobDispatcher } from "./jobs/dispatcher.js";
import { ProcessingQueue } from "./jobs/queue.js";
import { emptyLookups, initLookups, type Lookups } from "./lookups.js";
import type { RedisLike } from "./redis.js";
import { adminRoutes } from "./routes/admin.js";
import { fileRoutes } from "./routes/files.js";
import { folderRoutes } from "./routes/folders.js";
import { healthRoutes } from "./routes/health.js";
import { keyringRoutes } from "./routes/keyrings.js";
import { keyRoutes } from "./routes/keys.js";
import { lookupRoutes } from "./routes/lookups.js";
import { publicRoutes } from "./routes/public.js";
import { sharePublicRoutes } from "./routes/share-public.js";
import { shareRoutes } from "./routes/shares.js";
import { statsRoutes } from "./routes/stats.js";
import { thumbnailRoutes } from "./routes/thumbnails.js";
import { uploadRoutes } from "./routes/uploads.js";
import type { LastUsedThrottle } from "./services/apikeys.js";
import {
  createEncryptionService,
  type EncryptionService,
  encryptionUnavailable,
  integrityFailure,
  keyringLocked,
} from "./services/encryption.js";
import type { KeyringsDeps } from "./services/keyrings.js";
import {
  isLimiterRedis,
  MemorySharePasswordLimiter,
  RedisSharePasswordLimiter,
  type SharePasswordLimiter,
} from "./services/share-password.js";
import { isUnlockRedis, UnlockStore } from "./services/unlock.js";
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
  /**
   * Period of the expired-upload sweep in ms; `0` disables it (tests). Default 15 minutes.
   * In `async` mode the sweep is a repeatable job the worker runs, scheduled by this plugin.
   */
  uploadSweepIntervalMs?: number | undefined;
  /**
   * Background jobs. Default: decided by `config.worker.enabled` and `config.redisUrl`
   * (`resolveJobsMode`) — in `async` mode a `ProcessingQueue` on `config.redisUrl` is opened
   * (and closed with the app) and thumbnails are queued for the worker; in `sync` mode `/thumb`
   * renders inline. A `ProcessingQueue` given here is used as is (tests: a private prefix);
   * `false` forces `sync` mode.
   */
  jobs?: ProcessingQueue | false | undefined;
  /** Wall-clock limit of an inline thumbnail rendition in ms (tests). Default 30 s. */
  thumbnailTimeoutMs?: number | undefined;
  /**
   * The wrong-password counter of share links. Default: on `redis` when that client can
   * count (an ioredis client — shared by every server), in memory otherwise (per process).
   */
  sharePasswordLimiter?: SharePasswordLimiter | undefined;
  /**
   * Period of the worker's statistics refresh in ms; `0` disables scheduling it (tests).
   * Default: half of `VOLA_STATS_TTL_MIN`, at least 30 s. Only in `async` mode; in `sync`
   * mode a read recomputes a snapshot older than the TTL instead.
   */
  statsRefreshIntervalMs?: number | undefined;
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
  /** Hook of the `files` collection: decorates every row after the built-in masking and decryption. */
  decorateRow?: DecorateRow | undefined;
  /**
   * Encryption (plans 6.1 / 6.2, `docs/CRYPTO.md`). Default: the `tenant` provider on
   * `config.keyFile` (`VOLA_KEY_FILE`) and the `keyring` provider over `unlocks`; a missing
   * file is `503 encryption_unavailable` on encrypted uploads and downloads, nothing else. An
   * `EncryptionService` given here is used as is (tests: in-memory keys, a small segment
   * size); `false`: no encryption at all.
   */
  encryption?: EncryptionService | false | undefined;
  /**
   * The unlock-token store of the `keyring` provider (plan 6.2). Default: on `redis` when
   * that client is an ioredis one, with `config.unlockTtlS`; without Redis there is no
   * keyring provider (every keyring route and `keyring` file is `503`). `false`: none.
   */
  unlocks?: UnlockStore | false | undefined;
  /**
   * The keyring routes' dependencies (plan 6.2). Default: built here from `unlocks`, the
   * pepper file (`config.pepperFile`) and the storage. Tests give their own (an in-memory
   * pepper source, a lower Argon2 cost, a clock); `false`: no keyring routes.
   */
  keyrings?: Partial<KeyringsDeps> | false | undefined;
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
   * The audit trail (plan 5.2). Default: memento when `config.memento` is set — events are
   * `audit` jobs of the queue in `async` mode, one direct push otherwise — and a silent
   * no-op without it; an `AuditLog` given here is used as is and closed with the app;
   * `false`: no audit.
   */
  audit?: AuditLog | false | undefined;
  /**
   * Registers more routes INSIDE the plugin, after the built-in ones: they share its prefix,
   * error envelope and auth (`config.scope`, `config.auth`). For a host application's own
   * vola routes and for tests.
   */
  extend?: ((app: FastifyInstance) => Promise<void> | void) | undefined;
  /**
   * The examples site's demo routes (plan 8.1, `/examples/*`). Default: `config.examples`
   * (`VOLA_EXAMPLES=true` with the two demo keys); `false`: none, whatever the config.
   */
  examples?: ExamplesConfig | false | undefined;
  /** Overrides of the demo routes' dependencies (tests: a limiter, a clock, a known tenant). */
  examplesDeps?:
    | Partial<Pick<ExamplesRoutesDeps, "limiter" | "now" | "tenant" | "jobsMode">>
    | undefined;
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

/** Default period of the expired-upload sweep (the same the upload routes use). */
const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60_000;
/** The statistics refresh never runs more often than this, whatever the TTL. */
export const MIN_STATS_REFRESH_INTERVAL_MS = 30_000;

interface Jobs {
  queue: ProcessingQueue;
  dispatcher: JobDispatcher;
}

/**
 * The background-jobs side of the plugin: `sync` → nothing; `async` → the queue (opened here
 * unless given, closed with the app) and the dispatcher the upload and thumbnail routes use.
 */
async function setupJobs(
  app: FastifyInstance,
  options: VolaPluginOptions,
): Promise<{ jobs: Jobs | null; jobsMode: JobsMode }> {
  if (options.jobs === false) return { jobs: null, jobsMode: "sync" };
  let queue = options.jobs;
  if (!queue) {
    const mode = resolveJobsMode({
      enabled: options.config.worker.enabled,
      redisUrl: options.config.redisUrl,
      log: app.log,
    });
    if (mode === "sync" || !options.config.redisUrl) return { jobs: null, jobsMode: "sync" };
    const owned = new ProcessingQueue({
      redisUrl: options.config.redisUrl,
      prefix: options.config.worker.queuePrefix,
      log: app.log,
    });
    app.addHook("onClose", async () => owned.close());
    queue = owned;
  }
  const dispatcher = new QueuedJobDispatcher({
    db: options.db,
    queue,
    logger: app.log,
    ocr: options.config.ocr.enabled !== false,
  });
  app.log.info(
    { queue: queue.queue.name, prefix: queue.prefix, ocr: dispatcher.ocr },
    "background jobs: async (worker)",
  );
  return { jobs: { queue, dispatcher }, jobsMode: "async" };
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
export function installErrorHandling(
  app: FastifyInstance,
  options: { notFound?: boolean } = {},
): void {
  app.addHook("onSend", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  app.setErrorHandler((error: FastifyError | VolaError, request, reply) => {
    // The crypto layer's errors, should one escape a service (a stream that failed late).
    if (error instanceof IntegrityError) {
      request.log.warn({ reason: error.reason }, "integrity failure");
      error = integrityFailure();
    } else if (error instanceof EncryptionUnavailableError) {
      request.log.warn({ reason: error.message }, "encryption unavailable");
      error = encryptionUnavailable("tenant");
    } else if (error instanceof LockedError) {
      request.log.info({ reason: error.reason }, "keyring locked");
      error = keyringLocked();
    }
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

  if (options.notFound === false) return; // the host sets its own (the UI's page fallback)
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
  const { jobs, jobsMode } = await setupJobs(app, options);
  const sweepIntervalMs = jobsMode === "async" ? 0 : options.uploadSweepIntervalMs; // the worker sweeps in async mode
  if (jobs && (options.uploadSweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS) > 0) {
    const every = options.uploadSweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    const queue = jobs.queue;
    app.addHook("onReady", async () => {
      await queue
        .scheduleUploadSweep(every)
        .catch((error: unknown) => app.log.warn({ err: error }, "upload sweep not scheduled"));
    });
  }
  const statsTtlMs = options.config.stats.ttlMin * 60_000;
  const statsRefreshMs =
    options.statsRefreshIntervalMs ?? Math.max(MIN_STATS_REFRESH_INTERVAL_MS, statsTtlMs / 2);
  if (jobs && statsRefreshMs > 0) {
    const queue = jobs.queue;
    app.addHook("onReady", async () => {
      await queue
        .scheduleStatsRefresh(statsRefreshMs)
        .catch((error: unknown) => app.log.warn({ err: error }, "stats refresh not scheduled"));
    });
  }
  const uploadsPath = options.uploadsPath ?? join(options.config.storagePath, "uploads");
  const keyFile = new KeyFile(options.config.keyFile, app.log);
  let unlocks: UnlockStore | null = null;
  if (options.unlocks !== false) {
    if (options.unlocks) unlocks = options.unlocks;
    else if (isUnlockRedis(options.redis)) {
      unlocks = new UnlockStore({
        redis: options.redis,
        keys: keyFile,
        ttlS: options.config.unlockTtlS,
        logger: app.log,
      });
    }
  }
  const crypto =
    options.encryption === false
      ? undefined
      : (options.encryption ??
        createEncryptionService({
          db: options.db,
          keyFile: options.config.keyFile,
          keys: keyFile,
          unlocks,
          logger: app.log,
        }));
  if (crypto && options.encryption === undefined) {
    app.log.info(
      {
        key_file: options.config.keyFile,
        keyring: unlocks
          ? { pepper_file: options.config.pepperFile, unlock_ttl_s: unlocks.ttlS }
          : null,
      },
      unlocks
        ? "encryption: tenant, keyring and caller providers"
        : "encryption: tenant and caller providers (no Redis: no keyring provider)",
    );
  }
  const audit =
    options.audit === false
      ? disabledAuditLog()
      : (options.audit ??
        new AuditLog({
          sink: createAuditSink(options.config.memento, app.log),
          queue: jobs?.queue ?? null,
          logger: app.log,
        }));
  app.addHook("onClose", async () => audit.close());
  const sharePasswordLimiter =
    options.sharePasswordLimiter ??
    (isLimiterRedis(options.redis)
      ? new RedisSharePasswordLimiter(options.redis, { log: app.log })
      : new MemorySharePasswordLimiter());
  await app.register(healthRoutes, { db: options.db, redis: options.redis });
  await app.register(keyRoutes, { db: options.db, audit });
  let keyringsDeps: KeyringsDeps | null = null;
  if (options.keyrings !== false && crypto) {
    keyringsDeps = {
      db: options.db,
      unlocks,
      peppers: new KeyFile(options.config.pepperFile, app.log),
      storage,
      events,
      audit,
      logger: app.log,
      ...(options.keyrings ?? {}),
    };
    await app.register(keyringRoutes, { keyrings: keyringsDeps });
  }
  await app.register(adminRoutes, { db: options.db, events, audit, crypto });
  await app.register(lookupRoutes, { db: options.db, lookups });
  await app.register(fileRoutes, {
    db: options.db,
    storage,
    maxUploadBytes: options.config.maxUploadBytes,
    accessThrottle: options.accessThrottle,
    lookups,
    events,
    jobs: jobs?.dispatcher,
    audit,
    crypto,
  });
  await app.register(thumbnailRoutes, {
    db: options.db,
    storage,
    jobs: jobs?.dispatcher ?? null,
    renderTimeoutMs: options.thumbnailTimeoutMs,
    crypto,
    encDeriveMaxBytes: options.config.encDeriveMaxBytes,
  });
  await app.register(uploadRoutes, {
    db: options.db,
    storage,
    uploadsPath,
    maxUploadBytes: options.config.maxUploadBytes,
    uploadTtlHours: options.config.uploadTtlHours,
    sweepIntervalMs,
    lookups,
    events,
    jobs: jobs?.dispatcher,
    crypto,
  });
  await app.register(folderRoutes, { db: options.db, events, audit });
  await app.register(publicRoutes, {
    db: options.db,
    storage,
    accessThrottle: options.accessThrottle,
  });
  await app.register(shareRoutes, {
    db: options.db,
    publicUrl: options.config.publicUrl,
    audit,
    crypto,
  });
  await app.register(sharePublicRoutes, {
    db: options.db,
    storage,
    limiter: sharePasswordLimiter,
    accessThrottle: options.accessThrottle,
    crypto,
  });
  await app.register(statsRoutes, {
    db: options.db,
    storage,
    uploadsPath,
    // Without a worker nobody refreshes a snapshot: a read past the TTL does it instead.
    staleAfterMs: jobsMode === "sync" ? statsTtlMs : undefined,
  });
  if (options.udc !== false) {
    const registry =
      options.udc ??
      filesCollections({
        db: options.db,
        prefix: app.prefix,
        decorateRow: options.decorateRow,
        crypto,
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
  // The examples site's demo routes (plan 8.1): only with VOLA_EXAMPLES=true.
  const examples =
    options.examples === undefined ? options.config.examples : options.examples || null;
  if (examples) {
    await app.register(examplesRoutes, {
      config: examples,
      db: options.db,
      storage,
      events,
      keyrings: keyringsDeps,
      keys: keyFile,
      jobsMode,
      ...(options.examplesDeps ?? {}),
    });
  }
  if (options.extend) await options.extend(app);
};

import type { IncomingHttpHeaders } from "node:http";
import { Readable } from "node:stream";
import {
  decodeTusMetadata,
  type FileInfo,
  UPLOAD_LENGTH_HEADER,
  UPLOAD_META_KEYS,
  UPLOAD_METADATA_HEADER,
  USER_ID_HEADER,
  VOLA_FILE_ID_HEADER,
} from "@vola/core";
import type {
  FastifyBaseLogger,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  InjectOptions,
  LightMyRequestResponse,
} from "fastify";
import { requestUserId } from "../auth.js";
import type { ExamplesConfig } from "../config.js";
import type { KeyFile } from "../crypto/index.js";
import type { Database } from "../db/index.js";
import { VolaError } from "../errors.js";
import type { FileEventBus } from "../events/bus.js";
import type { JobsMode } from "../jobs/availability.js";
import { type FilesDeps, findFile, parseInstance } from "../services/files.js";
import { type FoldersDeps, findFolder } from "../services/folders.js";
import type { KeyringsDeps } from "../services/keyrings.js";
import type { StorageBackend } from "../storage/index.js";
import { type DemoTenant, ensureDemoTenant, SEEDER_USER } from "./demo.js";
import { RateLimiter } from "./limiter.js";
import {
  bareMime,
  DEMO_MIME_TYPES,
  DEMO_USER_RE,
  type DemoAction,
  demoAction,
  isCountedWrite,
  mimeAllowed,
} from "./policy.js";
import { type DemoPurgeResult, purgeDemo } from "./purge.js";

export interface ExamplesRoutesDeps {
  config: ExamplesConfig;
  db: Database;
  storage: StorageBackend;
  events?: FileEventBus | undefined;
  /** The keyring services' dependencies (the purge resets visitor keyrings); `null` without a keyring provider. */
  keyrings?: KeyringsDeps | null | undefined;
  /** The tenant encryption key file: `features.tenant_encryption` of the config answer. */
  keys?: KeyFile | undefined;
  /** `async`: a worker renders thumbnails, so `/thumb` answers `202` first (what the Thumbnails page shows). */
  jobsMode: JobsMode;
  logger?: FastifyBaseLogger | undefined;
  /** The per-IP brake; default: `config.rateLimit` per ten minutes. */
  limiter?: RateLimiter | undefined;
  /** Clock, for tests. */
  now?: (() => Date) | undefined;
  /** Skips the startup check of the keys (tests that build the app before the tenant exists). */
  tenant?: DemoTenant | undefined;
}

/** The window of the per-IP rate limit: ten minutes. */
export const DEMO_RATE_WINDOW_MS = 10 * 60_000;
/** Slack over `maxUploadBytes` a multipart body may carry (the boundaries and text fields). */
export const MULTIPART_SLACK_BYTES = 64 * 1024;
/** The path under the API prefix the proxy answers at. */
export const WRITE_PATH = "/examples/write/";

/** What `GET /examples/config` answers: everything the site needs to talk to the demo instance. */
export interface ExamplesConfigResponse {
  api_key: string;
  tenant: string;
  instance_type: string;
  instance_id: string;
  /** Visitor principals (`X-User-Id`) start with this; the proxy refuses any other. */
  user_prefix: string;
  /** Where a write goes: `<prefix>/examples/write/<route>` with the same body and headers, no key. */
  write_path: string;
  limits: {
    max_upload_bytes: number;
    ttl_hours: number;
    rate_limit: number;
    rate_window_s: number;
    mime_types: readonly string[];
  };
  features: {
    /** Redis and a pepper file: the keyring (PIN) examples work. */
    keyring: boolean;
    /** A key file: `tenant`-encrypted uploads work. */
    tenant_encryption: boolean;
    /** A worker renders thumbnails: `/thumb` answers `202` before `200`. */
    worker: boolean;
  };
}

/** Request headers the proxy forwards to the real route (lowercase); everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = new Set([
  // The visitor's Host (and the proxy's forwarded headers): a share's `url` is built on it.
  "host",
  "x-forwarded-host",
  "x-forwarded-proto",
  "content-type",
  "content-length",
  "accept",
  USER_ID_HEADER,
  "x-vola-unlock",
  "x-vola-encryption",
  "tus-resumable",
  "upload-length",
  "upload-offset",
  "upload-metadata",
  "upload-defer-length",
  "if-none-match",
  "x-request-id",
]);

/** Response headers the proxy does NOT relay (the outer response has its own). */
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "x-request-id",
  "date",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function forbidden(message: string, details?: Record<string, unknown>): VolaError {
  return new VolaError("demo_forbidden", 403, message, details);
}

/** The first value of a header, or `undefined`. */
function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The examples site's demo routes (plan 8.1), under the API prefix, no API key needed:
 *
 * - `GET /examples/config` — the read-only visitor key and everything else the site needs;
 * - `ANY /examples/write/<route>` — the write proxy: the request is replayed against
 *   `<prefix>/<route>` under the server's write key, after the policy (`demoAction`) said
 *   the visitor may make it, the per-IP rate limit let it through, the body is small
 *   enough, and — for an upload — its type is on the list (an upload of another type is
 *   purged again at once and answered `415`). A seeded file or folder is never written to.
 * - `POST /examples/regenerate/:fileId` — drops a file's thumbnails so the next `/thumb`
 *   renders them again (`202` → `200` with a worker: the Thumbnails page's button);
 * - the purge: every `config.purgeIntervalMin` minutes (and once at start) everything a
 *   visitor made more than `config.ttlHours` ago goes (`purgeDemo`); `POST /examples/purge`
 *   runs it now for an admin key.
 *
 * Every visitor request carries an `X-User-Id` of the form `demo-<random>` (the site keeps
 * one per browser session): it is the `created_by` the purge selects on and the principal
 * of the visitor's keyring.
 */
export const examplesRoutes: FastifyPluginAsync<ExamplesRoutesDeps> = async (app, deps) => {
  const { config } = deps;
  const log = deps.logger ?? app.log;
  const tenant = deps.tenant ?? (await ensureDemoTenant(deps.db, config, log));
  const scope = parseInstance(tenant.tenantId, config.instanceType, config.instanceId);
  const limiter = deps.limiter ?? new RateLimiter(config.rateLimit, DEMO_RATE_WINDOW_MS);
  const filesDeps: FilesDeps = { db: deps.db, storage: deps.storage, logger: log };
  const folderDeps: FoldersDeps = { db: deps.db, logger: log };
  const PUBLIC = { auth: "none" } as const;
  const writeKey = { authorization: `Bearer ${config.writeKey}` };

  // The proxied bodies go through untouched: the real route parses them.
  for (const type of ["multipart/form-data", "application/offset+octet-stream"]) {
    app.addContentTypeParser(type, (_request, payload, done) => done(null, payload));
  }

  log.info(
    {
      tenant: tenant.tenantSlug,
      instance: `${config.instanceType}/${config.instanceId}`,
      max_upload_bytes: config.maxUploadBytes,
      ttl_hours: config.ttlHours,
      rate_limit: `${config.rateLimit}/10min`,
    },
    "examples: demo routes on",
  );

  async function tenantEncryption(): Promise<boolean> {
    if (!deps.keys) return false;
    try {
      await deps.keys.lines();
      return true;
    } catch {
      return false;
    }
  }

  app.get("/examples/config", { config: PUBLIC }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const answer: ExamplesConfigResponse = {
      api_key: config.apiKey,
      tenant: tenant.tenantSlug,
      instance_type: config.instanceType,
      instance_id: config.instanceId,
      user_prefix: "demo-",
      write_path: `${app.prefix}${WRITE_PATH}`,
      limits: {
        max_upload_bytes: config.maxUploadBytes,
        ttl_hours: config.ttlHours,
        rate_limit: config.rateLimit,
        rate_window_s: DEMO_RATE_WINDOW_MS / 1000,
        mime_types: DEMO_MIME_TYPES,
      },
      features: {
        keyring: Boolean(deps.keyrings?.unlocks),
        tenant_encryption: await tenantEncryption(),
        worker: deps.jobsMode === "async",
      },
    };
    return answer;
  });

  /** `X-User-Id` of a visitor, or `400 demo_user_required`. */
  function visitorOf(request: FastifyRequest): string {
    const user = requestUserId(request);
    if (!user || !DEMO_USER_RE.test(user)) {
      throw new VolaError(
        "demo_user_required",
        400,
        "X-User-Id: a visitor id of the form demo-<6–32 lowercase letters or digits> is required",
      );
    }
    return user;
  }

  /** The per-IP brake: `429 demo_rate_limited` with `Retry-After` when the window is full. */
  function brake(request: FastifyRequest, reply: FastifyReply): void {
    const verdict = limiter.hit(request.ip);
    if (!verdict.allowed) {
      reply.header("retry-after", String(verdict.retryAfterS));
      throw new VolaError(
        "demo_rate_limited",
        429,
        `the demo allows ${config.rateLimit} writes per ${DEMO_RATE_WINDOW_MS / 60_000} minutes per address; try again in ${verdict.retryAfterS} s`,
        { retry_after: verdict.retryAfterS },
      );
    }
  }

  /** `403` when `fileId` is a seeded file (the pack every visitor sees); a missing file is the real route's 404. */
  async function refuseSeededFile(fileId: string): Promise<void> {
    try {
      const row = await findFile(filesDeps, scope, fileId, { includeDeleted: true });
      if (row.createdBy === SEEDER_USER) {
        throw forbidden(
          "this is one of the demo's seeded files: it stays as it is for every visitor",
          {
            file_id: row.id,
          },
        );
      }
    } catch (error) {
      if (error instanceof VolaError && error.status === 404) return;
      throw error;
    }
  }

  async function refuseSeededFolder(path: string): Promise<void> {
    try {
      const row = await findFolder(folderDeps, scope, decodeURIComponent(path));
      if (row.createdBy === SEEDER_USER) {
        throw forbidden(
          "this is one of the demo's seeded folders: it stays as it is for every visitor",
          {
            path: row.path,
          },
        );
      }
    } catch (error) {
      if (error instanceof VolaError && error.status === 404) return;
      if (error instanceof URIError) return;
      throw error;
    }
  }

  /** Before the request is replayed: the checks that need no answer from the real route. */
  async function preCheck(request: FastifyRequest, action: DemoAction): Promise<unknown> {
    const headers = request.headers;
    switch (action.kind) {
      case "upload": {
        const length = Number(headerOf(headers, "content-length") ?? Number.NaN);
        if (!Number.isFinite(length)) {
          throw new VolaError(
            "length_required",
            411,
            "Content-Length is required for a demo upload",
          );
        }
        if (length > config.maxUploadBytes + MULTIPART_SLACK_BYTES) throw tooLarge();
        return request.body;
      }
      case "upload-create": {
        const length = Number(headerOf(headers, UPLOAD_LENGTH_HEADER) ?? Number.NaN);
        if (Number.isFinite(length) && length > config.maxUploadBytes) throw tooLarge();
        const meta = decodeTusMetadata(headerOf(headers, UPLOAD_METADATA_HEADER)) ?? {};
        if (
          meta[UPLOAD_META_KEYS.instanceType] !== config.instanceType ||
          meta[UPLOAD_META_KEYS.instanceId]?.toLowerCase() !== config.instanceId
        ) {
          throw forbidden(
            `a demo upload goes to the instance ${config.instanceType}/${config.instanceId}`,
          );
        }
        return request.body;
      }
      case "file-write":
        await refuseSeededFile(action.fileId);
        return request.body;
      case "folder-write":
        await refuseSeededFolder(action.path);
        return request.body;
      case "share": {
        if (!action.create) return request.body;
        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) return body;
        const share = body as Record<string, unknown>;
        if (typeof share.file_id === "string") await refuseWrongInstance(share.file_id);
        // A visitor's link lives at most as long as the visitor's files.
        const latest = new Date(now().getTime() + config.ttlHours * 3_600_000);
        const asked = typeof share.expires_at === "string" ? new Date(share.expires_at) : null;
        if (!asked || Number.isNaN(asked.getTime()) || asked > latest) {
          share.expires_at = latest.toISOString();
        }
        return share;
      }
      default:
        return request.body;
    }
  }

  /** A share of a file outside the demo instance is refused (the write key could read it). */
  async function refuseWrongInstance(fileId: string): Promise<void> {
    if (!UUID_RE.test(fileId)) return;
    try {
      await findFile(filesDeps, scope, fileId);
    } catch (error) {
      if (error instanceof VolaError && error.status === 404) {
        throw forbidden("a demo share names a file of the demo instance");
      }
      throw error;
    }
  }

  function tooLarge(): VolaError {
    return new VolaError(
      "demo_too_large",
      413,
      `the demo accepts uploads up to ${config.maxUploadBytes} bytes`,
      { max_bytes: config.maxUploadBytes },
    );
  }

  const now = deps.now ?? (() => new Date());

  /** The headers of the replayed request: the allowlist, then the write key. */
  function forwardedHeaders(request: FastifyRequest, body: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!FORWARDED_REQUEST_HEADERS.has(name)) continue;
      const first = Array.isArray(value) ? value[0] : value;
      if (first !== undefined) out[name] = first;
    }
    // A parsed JSON body is serialised again by the replay: its length is the replay's.
    if (body !== undefined && body !== null && !(body instanceof Readable)) {
      delete out["content-length"];
    }
    return { ...out, ...writeKey };
  }

  async function replay(
    request: FastifyRequest,
    tail: string,
    body: unknown,
  ): Promise<LightMyRequestResponse> {
    const options: InjectOptions = {
      method: request.method as InjectOptions["method"],
      url: `${app.prefix}/${tail}`,
      headers: forwardedHeaders(request, body),
    };
    if (
      body !== undefined &&
      body !== null &&
      request.method !== "GET" &&
      request.method !== "HEAD"
    ) {
      options.payload = body as InjectOptions["payload"];
    }
    return app.inject(options);
  }

  /** Sends the real route's answer back, its headers but the hop-by-hop ones, `Location` pointed at the proxy. */
  function relay(reply: FastifyReply, response: LightMyRequestResponse): FastifyReply {
    reply.status(response.statusCode);
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) continue;
      const text = Array.isArray(value) ? value.join(", ") : String(value);
      if (name === "location" && text.startsWith(`${app.prefix}/`)) {
        reply.header(name, `${app.prefix}${WRITE_PATH}${text.slice(app.prefix.length + 1)}`);
      } else {
        reply.header(name, text);
      }
    }
    return reply.send(response.rawPayload.length > 0 ? response.rawPayload : undefined);
  }

  /** `info` of a file through the write key (after a resumable upload completed). */
  async function infoOf(fileId: string): Promise<FileInfo | null> {
    const response = await app.inject({
      method: "GET",
      url: `${app.prefix}/files/${config.instanceType}/${config.instanceId}/${fileId}/info`,
      headers: writeKey,
    });
    return response.statusCode === 200 ? (response.json() as FileInfo) : null;
  }

  /** A file of a type the demo does not keep is purged again at once; `true` when it was. */
  async function purgeIfNotAllowed(info: FileInfo | null): Promise<boolean> {
    if (info?.encryption !== "none" || mimeAllowed(info.mime_type)) return false;
    await app.inject({
      method: "DELETE",
      url: `${app.prefix}/files/${config.instanceType}/${config.instanceId}/${info.id}/purge`,
      headers: writeKey,
    });
    log.info(
      { file: info.id, mime: info.mime_type },
      "examples: upload of a type not allowed purged",
    );
    return true;
  }

  function notAllowed(mime: string): VolaError {
    return new VolaError(
      "demo_mime_not_allowed",
      415,
      `the demo keeps images, PDF, short video and audio and plain text; not ${bareMime(mime) || "this type"}`,
      { mime_type: bareMime(mime), allowed: DEMO_MIME_TYPES },
    );
  }

  app.all<{ Params: { "*": string } }>(
    `${WRITE_PATH}*`,
    { config: PUBLIC },
    async (request, reply) => {
      // The raw URL keeps the route's own encoding (a folder path, a query string).
      const raw = request.raw.url ?? request.url;
      const at = raw.indexOf(WRITE_PATH);
      const tail = at >= 0 ? raw.slice(at + WRITE_PATH.length) : request.params["*"];
      const path = tail.split("?")[0] ?? "";
      const action = demoAction(request.method, path, config);
      if (!action) {
        throw forbidden(
          `the demo does not allow ${request.method} /${path}: uploads, folders, shares and the visitor's own keyring, on the demo instance only`,
        );
      }
      visitorOf(request);
      if (isCountedWrite(request.method, action)) brake(request, reply);
      const body = await preCheck(request, action);
      const response = await replay(request, tail, body);

      if (action.kind === "upload" && response.statusCode === 201) {
        const info = response.json() as FileInfo;
        if (await purgeIfNotAllowed(info)) throw notAllowed(info.mime_type);
      }
      if (
        action.kind === "upload-continue" &&
        request.method === "PATCH" &&
        response.statusCode === 204
      ) {
        const fileId = headerOf(response.headers as IncomingHttpHeaders, VOLA_FILE_ID_HEADER);
        if (fileId) {
          const info = await infoOf(fileId);
          if (await purgeIfNotAllowed(info)) throw notAllowed(info?.mime_type ?? "");
        }
      }
      return relay(reply, response);
    },
  );

  app.post<{ Params: { fileId: string } }>(
    "/examples/regenerate/:fileId",
    { config: PUBLIC },
    async (request, reply) => {
      brake(request, reply);
      const row = await findFile(filesDeps, scope, request.params.fileId);
      const removed = await deps.storage.removeDerived(row.hash);
      log.info({ file: row.id, removed }, "examples: thumbnails dropped for regeneration");
      return { file_id: row.id, removed };
    },
  );

  // --- the purge -----------------------------------------------------------------------------

  const purge = (): Promise<DemoPurgeResult> =>
    purgeDemo({
      db: deps.db,
      storage: deps.storage,
      tenantId: tenant.tenantId,
      instanceType: config.instanceType,
      instanceId: config.instanceId,
      ttlMs: config.ttlHours * 3_600_000,
      events: deps.events,
      keyrings: deps.keyrings,
      logger: log,
      now,
    });
  if (config.purgeIntervalMin > 0) {
    const run = () =>
      purge().catch((error: unknown) => log.error({ err: error }, "demo purge failed"));
    const timer = setInterval(run, config.purgeIntervalMin * 60_000);
    timer.unref();
    app.addHook("onReady", async () => {
      void run();
    });
    app.addHook("onClose", async () => clearInterval(timer));
  }
  /** `POST /examples/purge` — an admin key runs the purge now (an operator, the tests). */
  app.post("/examples/purge", { config: { scope: "admin", tenant: "optional" } }, async () =>
    purge(),
  );
};

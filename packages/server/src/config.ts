import { resolve } from "node:path";
import {
  DEFAULT_ENC_INLINE_DERIVE_MAX_BYTES,
  DEFAULT_OCR_LANGS,
  DEFAULT_OCR_MAX_PAGES,
  DEFAULT_OCR_TIMEOUT_S,
  DEFAULT_STATS_TTL_MIN,
  DEFAULT_UNLOCK_TTL_S,
  type OcrLanguage,
  parseApiKey,
  parseOcrLangs,
} from "@vol-a/core";
import { z } from "zod";
import { DEFAULT_PEPPER_FILE } from "./crypto/keyring.js";
import { DEFAULT_KEY_FILE } from "./crypto/tenant.js";
import { DEFAULT_LOOKUPS_PATH } from "./lookups.js";
import { DEFAULT_MENU_PATH } from "./udc/menu.js";

/** The demo tenant of the examples site, unless `VOLA_DEMO_TENANT` says otherwise. */
export const DEFAULT_DEMO_TENANT = "demo";
/** `instance_type` of the demo instance every example page shows. */
export const DEFAULT_DEMO_INSTANCE_TYPE = "demo";
/** `instance_id` of the demo instance (a fixed, well-formed UUID the seeder and the site agree on). */
export const DEFAULT_DEMO_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";
/** The largest file a visitor may upload through the demo routes: 5 MiB. */
export const DEFAULT_DEMO_MAX_BYTES = 5 * 1024 * 1024;
/** Writes one visitor IP may make through the demo routes per ten minutes. */
export const DEFAULT_DEMO_RATE_LIMIT = 60;

const POSTGRES_URL = /^postgres(ql)?:\/\/.+/;

const postgresUrl = (fallback: string) =>
  z.string().regex(POSTGRES_URL, "must be a postgresql:// URL").default(fallback);

/** `true|false|1|0|yes|no|on|off`, case-insensitive. */
const boolean = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return fallback;
      const v = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(v)) return true;
      if (["false", "0", "no", "off"].includes(v)) return false;
      ctx.addIssue({ code: "custom", message: "must be true or false" });
      return z.NEVER;
    });

/** `auto|true|false|1|0|yes|no|on|off`, case-insensitive; unset → `auto`. */
const autoBoolean = () =>
  z
    .string()
    .optional()
    .transform((value, ctx): "auto" | boolean => {
      if (value === undefined) return "auto";
      const v = value.trim().toLowerCase();
      if (v === "auto") return "auto";
      if (["true", "1", "yes", "on"].includes(v)) return true;
      if (["false", "0", "no", "off"].includes(v)) return false;
      ctx.addIssue({ code: "custom", message: "must be auto, true or false" });
      return z.NEVER;
    });

const ConfigSchema = z
  .object({
    VOLA_DATABASE_URL: postgresUrl("postgresql://vola:vola@localhost:5432/vola"),
    VOLA_DATABASE_URL_TEST: postgresUrl("postgresql://vola:vola@localhost:5432/vola_test"),
    VOLA_REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\/.+/, "must be a redis:// URL")
      .optional(),
    VOLA_HOST: z.string().min(1).default("0.0.0.0"),
    VOLA_PORT: z.coerce.number().int().min(0).max(65535).default(8300),
    VOLA_PREFIX: z
      .string()
      .regex(/^\/[\w/-]*$/, "must start with / and contain only letters, digits, _ - /")
      .default("/vola"),
    VOLA_STORAGE_PATH: z.string().min(1).default("var/storage"),
    VOLA_MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .default(512 * 1024 * 1024),
    VOLA_UPLOAD_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .default(24),
    VOLA_LOOKUPS_PATH: z.string().min(1).optional(),
    VOLA_TRANSLATIONS_PATH: z.string().min(1).optional(),
    VOLA_RECORD_CANDIDATES: boolean(true),
    VOLA_CANDIDATES_DIR: z.string().min(1).optional(),
    VOLA_MENU_PATH: z.string().min(1).optional(),
    VOLA_WORKER_ENABLED: autoBoolean(),
    VOLA_OCR_ENABLED: autoBoolean(),
    VOLA_OCR_LANGS: z
      .string()
      .optional()
      .transform((value, ctx): OcrLanguage[] => {
        try {
          return parseOcrLangs(value ?? DEFAULT_OCR_LANGS);
        } catch (error) {
          ctx.addIssue({ code: "custom", message: (error as Error).message });
          return z.NEVER;
        }
      }),
    VOLA_OCR_MAX_PAGES: z.coerce.number().int().min(1).max(1000).default(DEFAULT_OCR_MAX_PAGES),
    VOLA_OCR_TIMEOUT_S: z.coerce.number().int().min(1).max(3600).default(DEFAULT_OCR_TIMEOUT_S),
    VOLA_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
    VOLA_QUEUE_PREFIX: z
      .string()
      .regex(/^[\w:-]{1,64}$/, "letters, digits, _ - : only")
      .default("vola"),
    VOLA_STATS_TTL_MIN: z.coerce
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60)
      .default(DEFAULT_STATS_TTL_MIN),
    VOLA_PUBLIC_URL: z
      .string()
      .regex(/^https?:\/\/[^\s/]+(\/[^\s]*)?$/, "must be an http(s) URL")
      .optional(),
    VOLA_WS_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(30_000),
    VOLA_WS_MAX_BUFFERED: z.coerce.number().int().min(1).default(1000),
    VOLA_MEMENTO_URL: z
      .string()
      .regex(/^https?:\/\/[^\s/]+(\/[^\s]*)?$/, "must be an http(s) URL")
      .optional(),
    VOLA_MEMENTO_API_KEY: z.string().min(1).optional(),
    VOLA_KEY_FILE: z.string().min(1).default(DEFAULT_KEY_FILE),
    VOLA_PEPPER_FILE: z.string().min(1).default(DEFAULT_PEPPER_FILE),
    VOLA_UNLOCK_TTL_S: z.coerce
      .number()
      .int()
      .min(5)
      .max(24 * 3600)
      .default(DEFAULT_UNLOCK_TTL_S),
    VOLA_ENC_INLINE_DERIVE_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(0)
      .default(DEFAULT_ENC_INLINE_DERIVE_MAX_BYTES),
    VOLA_LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    VOLA_UI_DIR: z.string().min(1).optional(),
    VOLA_TRUST_PROXY: boolean(false),
    VOLA_EXAMPLES: boolean(false),
    VOLA_DEMO_API_KEY: z.string().min(1).optional(),
    VOLA_DEMO_WRITE_KEY: z.string().min(1).optional(),
    VOLA_DEMO_TENANT: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "a tenant slug")
      .default(DEFAULT_DEMO_TENANT),
    VOLA_DEMO_INSTANCE_TYPE: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and _ starting with a letter")
      .default(DEFAULT_DEMO_INSTANCE_TYPE),
    VOLA_DEMO_INSTANCE_ID: z.uuid().default(DEFAULT_DEMO_INSTANCE_ID),
    VOLA_DEMO_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).default(DEFAULT_DEMO_MAX_BYTES),
    VOLA_DEMO_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(24),
    VOLA_DEMO_RATE_LIMIT: z.coerce.number().int().min(1).default(DEFAULT_DEMO_RATE_LIMIT),
    VOLA_DEMO_PURGE_INTERVAL_MIN: z.coerce.number().int().min(0).default(15),
  })
  .refine((c) => (c.VOLA_MEMENTO_URL === undefined) === (c.VOLA_MEMENTO_API_KEY === undefined), {
    message: "VOLA_MEMENTO_URL and VOLA_MEMENTO_API_KEY go together: set both or neither",
    path: ["VOLA_MEMENTO_API_KEY"],
  })
  .refine((c) => !c.VOLA_EXAMPLES || (c.VOLA_DEMO_API_KEY && c.VOLA_DEMO_WRITE_KEY), {
    message: "VOLA_EXAMPLES=true needs VOLA_DEMO_API_KEY and VOLA_DEMO_WRITE_KEY",
    path: ["VOLA_EXAMPLES"],
  })
  .refine(
    (c) =>
      !c.VOLA_EXAMPLES ||
      (parseApiKey(c.VOLA_DEMO_API_KEY ?? "") !== null &&
        parseApiKey(c.VOLA_DEMO_WRITE_KEY ?? "") !== null),
    {
      message:
        "VOLA_DEMO_API_KEY and VOLA_DEMO_WRITE_KEY must be well-formed keys (vola_live_… or vola_test_…; `vola demo-keys` prints a pair)",
      path: ["VOLA_DEMO_API_KEY"],
    },
  )
  .refine((c) => !c.VOLA_EXAMPLES || c.VOLA_DEMO_API_KEY !== c.VOLA_DEMO_WRITE_KEY, {
    message: "VOLA_DEMO_API_KEY and VOLA_DEMO_WRITE_KEY must be two different keys",
    path: ["VOLA_DEMO_WRITE_KEY"],
  });

export type LogLevel = z.infer<typeof ConfigSchema>["VOLA_LOG_LEVEL"];

export interface LookupsConfig {
  /** `lookups.yaml` (`VOLA_LOOKUPS_PATH`); default: the one at the repository root. */
  path: string;
  /** `VOLA_TRANSLATIONS_PATH`; `undefined` → `i18n/translations.csv` next to `path`. */
  translationsPath: string | undefined;
  /**
   * Where unknown values are recorded (`VOLA_CANDIDATES_DIR`); `undefined` →
   * `var/candidates` next to `path`; `null` → recording off (`VOLA_RECORD_CANDIDATES=false`).
   */
  candidatesDir: string | null | undefined;
}

export interface Config {
  databaseUrl: string;
  testDatabaseUrl: string;
  /** `null` → no Redis: no background jobs, no `redis` readiness check. */
  redisUrl: string | null;
  host: string;
  port: number;
  /** Mount point of every vola route, without a trailing slash (`/vola`). */
  prefix: string;
  /** Absolute directory the content-addressable blobs live in. */
  storagePath: string;
  /** Largest file one upload may carry; bigger → `413 file_too_large`. Default 512 MiB. */
  maxUploadBytes: number;
  /** Hours a resumable upload may sit unfinished before it is swept. Default 24. */
  uploadTtlHours: number;
  /** The controlled vocabulary (`@vol-a/lookups`). */
  lookups: LookupsConfig;
  /** The menu YAML served as the `menu` UDC collection (`VOLA_MENU_PATH`). */
  menuPath: string;
  /** The real-time `subscribe` WebSocket (`/udc/subscribe`). */
  subscribe: SubscribeConfig;
  /** Background jobs: the BullMQ queue and the worker process. */
  worker: WorkerConfig;
  /** OCR (plan 4.2): whether, in which languages, how many pages, how long. */
  ocr: OcrConfig;
  /** Statistics snapshots (plan 5.1). */
  stats: StatsConfig;
  /**
   * `VOLA_PUBLIC_URL`: the origin clients reach this server on (`https://files.example.com`),
   * without the prefix and without a trailing slash; the `url` of a share link is built on it.
   * `null`: the `Host` and protocol of the creating request are used.
   */
  publicUrl: string | null;
  /**
   * The optional memento audit (plan 5.2): `VOLA_MEMENTO_URL` (the memento API base, e.g.
   * `https://memento.example.com/memento`) and `VOLA_MEMENTO_API_KEY` (a key with the `write`
   * scope). `null`: no audit events are written — a supported configuration, logged once at INFO.
   */
  memento: MementoConfig | null;
  /**
   * `VOLA_KEY_FILE` (default `/run/secrets/vola.key`): the key file of the `tenant`
   * encryption provider — one base64 32-byte key per line, the first one active
   * (`docs/CRYPTO.md`). A missing file does not stop the server: encrypted uploads and
   * downloads answer `503 encryption_unavailable` until it is there.
   */
  keyFile: string;
  /**
   * `VOLA_PEPPER_FILE` (default `/run/secrets/vola.pepper`): the pepper lines of the
   * `keyring` provider (the Argon2 `secret`; same format as the key file, the first line
   * active, rotate by prepending). Create it with `vola pepper-generate`. Without it every
   * keyring route and `keyring` file answers `503 encryption_unavailable`.
   */
  pepperFile: string;
  /**
   * `VOLA_UNLOCK_TTL_S` (default 150): seconds an unlock token lives without a request;
   * every request that carries it starts the count again (`GET /keyrings/me/status` does not).
   */
  unlockTtlS: number;
  /**
   * `VOLA_ENC_INLINE_DERIVE_MAX_BYTES` (default 25 MiB): the largest encrypted file a
   * thumbnail or an OCR pass is made of — in the request that holds the key for a `keyring`
   * or `caller` file, and in the worker for a `tenant` file (the plaintext is decrypted into
   * memory, never onto disk; `docs/CRYPTO.md` § 11). `0` turns derivatives of encrypted
   * files off.
   */
  encDeriveMaxBytes: number;
  logLevel: LogLevel;
  /**
   * `VOLA_UI_DIR`: a built single-page app (`apps/examples/dist`, the examples site) the
   * standalone server serves at `/` and `/en/` with an `index.html` fallback for client
   * routes. `null`: the API only (the Docker image sets `/app/ui`).
   */
  uiDir: string | null;
  /**
   * `VOLA_TRUST_PROXY` (default false): behind a reverse proxy, read the client address from
   * `X-Forwarded-For` (the demo routes' per-IP rate limit, the logs).
   */
  trustProxy: boolean;
  /**
   * `VOLA_EXAMPLES=true`: the examples site's demo routes under `/examples` (plan 8.1) —
   * the read-only visitor key, the server-side write proxy, the 24-hour purge. `null`: none
   * of them exist (the routes answer 404).
   */
  examples: ExamplesConfig | null;
}

export interface ExamplesConfig {
  /** `VOLA_DEMO_API_KEY`: the READ-ONLY key `GET /examples/config` hands every visitor. */
  apiKey: string;
  /** `VOLA_DEMO_WRITE_KEY`: the key the server writes with on a visitor's behalf; never leaves it. */
  writeKey: string;
  /** `VOLA_DEMO_TENANT` (`demo`): the tenant both keys belong to (created at startup when missing). */
  tenant: string;
  /** `VOLA_DEMO_INSTANCE_TYPE` (`demo`) and `VOLA_DEMO_INSTANCE_ID`: the one instance the site shows. */
  instanceType: string;
  instanceId: string;
  /** `VOLA_DEMO_MAX_UPLOAD_BYTES` (5 MiB): the largest upload through the demo routes. */
  maxUploadBytes: number;
  /** `VOLA_DEMO_TTL_HOURS` (24): a visitor's uploads, keyrings and folders are purged after this. */
  ttlHours: number;
  /** `VOLA_DEMO_RATE_LIMIT` (60): writes one IP may make through the demo routes per ten minutes. */
  rateLimit: number;
  /** `VOLA_DEMO_PURGE_INTERVAL_MIN` (15): how often the purge runs; `0` never (tests). */
  purgeIntervalMin: number;
}

export interface MementoConfig {
  url: string;
  apiKey: string;
}

export interface StatsConfig {
  /**
   * `VOLA_STATS_TTL_MIN`: minutes a `vola_tenant_stats` snapshot may age. The worker's
   * `refresh-stats` job recomputes older ones for tenants with activity since; without a
   * worker a read recomputes a snapshot past this age. Default 60.
   */
  ttlMin: number;
}

export interface OcrConfig {
  /**
   * `VOLA_OCR_ENABLED`: `auto` (default) — the server queues an `OCR` job for every eligible
   * upload and the worker runs it when `tesseract` is installed (checked once at its start;
   * without it the jobs are `SKIPPED`); `true` — the worker refuses to start without
   * `tesseract`; `false` — no `OCR` job is ever created.
   */
  enabled: "auto" | boolean;
  /** `VOLA_OCR_LANGS` (`eng+srp+deu`): tesseract's `-l`, every code from the `OcrLanguages` vocabulary. */
  langs: OcrLanguage[];
  /** `VOLA_OCR_MAX_PAGES`: pages of a PDF the OCR reads, from the first. Default 20. */
  maxPages: number;
  /** `VOLA_OCR_TIMEOUT_S`: seconds one page (or one image) may take. Default 120. */
  timeoutS: number;
}

export interface WorkerConfig {
  /**
   * `VOLA_WORKER_ENABLED`: `auto` (default) — jobs go to the worker when `VOLA_REDIS_URL` is
   * set; `true` — always (one ERROR line and synchronous work when Redis is missing);
   * `false` — never: thumbnails are rendered inline on `/thumb`, OCR does not run.
   */
  enabled: "auto" | boolean;
  /** `VOLA_WORKER_CONCURRENCY`: jobs one worker process runs at once. Default 2. */
  concurrency: number;
  /**
   * `VOLA_QUEUE_PREFIX`: the Redis key prefix of the job queue (`<prefix>:vola-processing:*`);
   * server and worker must agree. Default `vola`. Lets several deployments share one Redis.
   */
  queuePrefix: string;
}

export interface SubscribeConfig {
  /** `VOLA_WS_HEARTBEAT_MS`: a ping this often; a client that missed the last one is cut off. */
  heartbeatIntervalMs: number;
  /** `VOLA_WS_MAX_BUFFERED`: unwritten messages a connection may pile up before it is closed (4008). */
  maxBufferedMessages: number;
}

/** Thrown by `loadConfig` — one message listing every invalid `VOLA_*` variable. */
export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

/** Reads the configuration from the environment (see `.env.example`). Empty values count as unset. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== "")),
  );
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`),
    );
  }
  const c = parsed.data;
  return {
    databaseUrl: c.VOLA_DATABASE_URL,
    testDatabaseUrl: c.VOLA_DATABASE_URL_TEST,
    redisUrl: c.VOLA_REDIS_URL ?? null,
    host: c.VOLA_HOST,
    port: c.VOLA_PORT,
    prefix: c.VOLA_PREFIX.replace(/\/+$/, ""),
    storagePath: resolve(c.VOLA_STORAGE_PATH),
    maxUploadBytes: c.VOLA_MAX_UPLOAD_BYTES,
    uploadTtlHours: c.VOLA_UPLOAD_TTL_HOURS,
    lookups: {
      path: c.VOLA_LOOKUPS_PATH ? resolve(c.VOLA_LOOKUPS_PATH) : DEFAULT_LOOKUPS_PATH,
      translationsPath: c.VOLA_TRANSLATIONS_PATH ? resolve(c.VOLA_TRANSLATIONS_PATH) : undefined,
      candidatesDir: c.VOLA_RECORD_CANDIDATES
        ? c.VOLA_CANDIDATES_DIR
          ? resolve(c.VOLA_CANDIDATES_DIR)
          : undefined
        : null,
    },
    menuPath: c.VOLA_MENU_PATH ? resolve(c.VOLA_MENU_PATH) : DEFAULT_MENU_PATH,
    subscribe: {
      heartbeatIntervalMs: c.VOLA_WS_HEARTBEAT_MS,
      maxBufferedMessages: c.VOLA_WS_MAX_BUFFERED,
    },
    worker: {
      enabled: c.VOLA_WORKER_ENABLED,
      concurrency: c.VOLA_WORKER_CONCURRENCY,
      queuePrefix: c.VOLA_QUEUE_PREFIX,
    },
    ocr: {
      enabled: c.VOLA_OCR_ENABLED,
      langs: c.VOLA_OCR_LANGS,
      maxPages: c.VOLA_OCR_MAX_PAGES,
      timeoutS: c.VOLA_OCR_TIMEOUT_S,
    },
    stats: { ttlMin: c.VOLA_STATS_TTL_MIN },
    publicUrl: c.VOLA_PUBLIC_URL ? c.VOLA_PUBLIC_URL.replace(/\/+$/, "") : null,
    memento:
      c.VOLA_MEMENTO_URL && c.VOLA_MEMENTO_API_KEY
        ? { url: c.VOLA_MEMENTO_URL.replace(/\/+$/, ""), apiKey: c.VOLA_MEMENTO_API_KEY }
        : null,
    keyFile: resolve(c.VOLA_KEY_FILE),
    pepperFile: resolve(c.VOLA_PEPPER_FILE),
    unlockTtlS: c.VOLA_UNLOCK_TTL_S,
    encDeriveMaxBytes: c.VOLA_ENC_INLINE_DERIVE_MAX_BYTES,
    logLevel: c.VOLA_LOG_LEVEL,
    uiDir: c.VOLA_UI_DIR ? resolve(c.VOLA_UI_DIR) : null,
    trustProxy: c.VOLA_TRUST_PROXY,
    examples:
      c.VOLA_EXAMPLES && c.VOLA_DEMO_API_KEY && c.VOLA_DEMO_WRITE_KEY
        ? {
            apiKey: c.VOLA_DEMO_API_KEY,
            writeKey: c.VOLA_DEMO_WRITE_KEY,
            tenant: c.VOLA_DEMO_TENANT,
            instanceType: c.VOLA_DEMO_INSTANCE_TYPE,
            instanceId: c.VOLA_DEMO_INSTANCE_ID.toLowerCase(),
            maxUploadBytes: c.VOLA_DEMO_MAX_UPLOAD_BYTES,
            ttlHours: c.VOLA_DEMO_TTL_HOURS,
            rateLimit: c.VOLA_DEMO_RATE_LIMIT,
            purgeIntervalMin: c.VOLA_DEMO_PURGE_INTERVAL_MIN,
          }
        : null,
  };
}

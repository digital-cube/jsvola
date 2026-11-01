import { resolve } from "node:path";
import {
  DEFAULT_OCR_LANGS,
  DEFAULT_OCR_MAX_PAGES,
  DEFAULT_OCR_TIMEOUT_S,
  DEFAULT_STATS_TTL_MIN,
  type OcrLanguage,
  parseOcrLangs,
} from "@vola/core";
import { z } from "zod";
import { DEFAULT_LOOKUPS_PATH } from "./lookups.js";
import { DEFAULT_MENU_PATH } from "./udc/menu.js";

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

const ConfigSchema = z.object({
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
  VOLA_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
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
  /** The controlled vocabulary (`@vola/lookups`). */
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
  logLevel: LogLevel;
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
    logLevel: c.VOLA_LOG_LEVEL,
  };
}

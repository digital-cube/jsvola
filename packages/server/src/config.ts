import { resolve } from "node:path";
import { z } from "zod";

const POSTGRES_URL = /^postgres(ql)?:\/\/.+/;

const postgresUrl = (fallback: string) =>
  z.string().regex(POSTGRES_URL, "must be a postgresql:// URL").default(fallback);

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
  VOLA_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type LogLevel = z.infer<typeof ConfigSchema>["VOLA_LOG_LEVEL"];

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
  logLevel: LogLevel;
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
    logLevel: c.VOLA_LOG_LEVEL,
  };
}

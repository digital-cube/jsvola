import { type ApiKey, displayApiKey, SCOPES, SlugSchema, type Tenant } from "@vola/core";
import {
  ConfigError,
  connect,
  createApiKey,
  createTenant,
  type DatabaseHandle,
  findApiKey,
  getTenantBySlug,
  listApiKeys,
  loadConfig,
  revokeApiKey,
  runMigrations,
  schema,
  VolaError,
} from "@vola/server";
import { Command, InvalidArgumentError, Option } from "commander";
import { eq } from "drizzle-orm";

export const CLI_VERSION = "1.0.0";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliOptions {
  /**
   * PostgreSQL the commands talk to. Default: `VOLA_DATABASE_URL` from `env`. Opened lazily,
   * so `--help`, `--version` and usage errors never connect.
   */
  databaseUrl?: string | undefined;
  /** Environment `databaseUrl` is read from. Default `process.env`. */
  env?: Record<string, string | undefined> | undefined;
}

const DEFAULT_TENANT_SCOPES = "files:read,files:write,folders:read,folders:write";

function slugArgument(value: string): string {
  const parsed = SlugSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? "invalid slug");
  }
  return parsed.data;
}

function envArgument(value: string): "live" | "test" {
  if (value !== "live" && value !== "test") throw new InvalidArgumentError("must be live or test");
  return value;
}

function dateArgument(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidArgumentError("must be an ISO 8601 date-time, e.g. 2027-01-01T00:00:00Z");
  }
  return date;
}

/** `vola_live…k3Qz  name  tenant  scopes  created  [REVOKED]` */
export function formatKeyLine(key: ApiKey, tenantSlug: string | null): string {
  const flags = [
    key.is_admin ? "ADMIN" : null,
    key.revoked_at ? "REVOKED" : null,
    key.expires_at && Date.parse(key.expires_at) <= Date.now() ? "EXPIRED" : null,
  ].filter(Boolean);
  return [
    key.id,
    displayApiKey(key.prefix, key.last4).padEnd(16),
    key.name.padEnd(24),
    `tenant=${tenantSlug ?? "-"}`,
    `scopes=${key.scopes.join(",")}`,
    `created=${key.created_at.slice(0, 10)}`,
    key.last_used_at ? `last_used=${key.last_used_at.slice(0, 10)}` : "never_used",
    ...(flags.length ? [`[${flags.join(",")}]`] : []),
  ].join("  ");
}

/** The lines printed after a key was minted: the plaintext, once, with the warning. */
export function plaintextLines(key: string): string[] {
  return [
    "",
    "  Plaintext key (shown ONCE — store it now, it cannot be recovered):",
    "",
    `  ${key}`,
    "",
  ];
}

/**
 * The `vola` command tree: `migrate`, `create-tenant`, `create-key`, `create-admin-key`,
 * `list-keys`, `revoke-key`. Every command reads `VOLA_DATABASE_URL` and connects only when
 * it runs.
 */
export function buildProgram(io: CliIo, options: CliOptions = {}): Command {
  const program = new Command("vola")
    .description("JSVola — self-hosted, multi-tenant content-addressable file storage")
    .version(CLI_VERSION, "-V, --version", "print the version")
    .option("--json", "print machine-readable JSON")
    .configureOutput({
      writeOut: (text) => io.out(text.replace(/\n$/, "")),
      writeErr: (text) => io.err(text.replace(/\n$/, "")),
    })
    .exitOverride()
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Examples:
  $ vola migrate
  $ vola create-tenant --slug acme --name "Acme Inc"
  $ vola create-key --tenant acme --name backend --env live --scopes files:read,files:write
  $ vola create-admin-key --name ops
  $ vola list-keys --tenant acme
  $ vola revoke-key vola_live…k3Qz

Environment:
  VOLA_DATABASE_URL  PostgreSQL the commands use (default postgresql://vola:vola@localhost:5432/vola)

Scopes: ${SCOPES.join(", ")}`,
    );

  const json = () => Boolean(program.opts().json);
  const print = (data: unknown, lines: string | string[]) => {
    if (json()) io.out(JSON.stringify(data));
    else for (const line of Array.isArray(lines) ? lines : [lines]) io.out(line);
  };

  /** Runs `fn` with a database handle and closes it afterwards. */
  const withDb = async <T>(fn: (handle: DatabaseHandle) => Promise<T>): Promise<T> => {
    const url = options.databaseUrl ?? loadConfig(options.env ?? process.env).databaseUrl;
    const handle = connect(url, { max: 1 });
    try {
      return await fn(handle);
    } finally {
      await handle.close();
    }
  };

  program
    .command("migrate")
    .description("apply pending database migrations")
    .action(async () => {
      await withDb(async ({ db }) => {
        await runMigrations(db);
        print({ migrated: true }, "migrations applied");
      });
    });

  program
    .command("create-tenant")
    .description("create a tenant")
    .requiredOption(
      "--slug <slug>",
      "tenant slug (lowercase letters, digits, dashes)",
      slugArgument,
    )
    .option("--name <name>", "display name (default: the slug in title case)")
    .action(async (opts: { slug: string; name?: string }) => {
      await withDb(async ({ db }) => {
        const tenant: Tenant = await createTenant(db, { slug: opts.slug, name: opts.name });
        print(tenant, `created tenant ${tenant.slug} (${tenant.name}) id=${tenant.id}`);
      });
    });

  program
    .command("create-key")
    .description("create a tenant API key; the plaintext is printed once")
    .requiredOption("--tenant <slug>", "tenant the key belongs to", slugArgument)
    .requiredOption("--name <name>", "label of the key")
    .addOption(new Option("--env <env>", "live or test").default("live").argParser(envArgument))
    .option("--scopes <a,b>", `comma-separated scopes (default ${DEFAULT_TENANT_SCOPES})`)
    .option("--expires <iso>", "expiry date-time (ISO 8601)", dateArgument)
    .option("--created-by <who>", "recorded as created_by")
    .action(
      async (opts: {
        tenant: string;
        name: string;
        env: "live" | "test";
        scopes?: string;
        expires?: Date;
        createdBy?: string;
      }) => {
        await withDb(async ({ db }) => {
          const tenant = await getTenantBySlug(db, opts.tenant);
          const { apiKey, key } = await createApiKey(db, {
            tenantId: tenant.id,
            name: opts.name,
            env: opts.env,
            scopes: opts.scopes ?? DEFAULT_TENANT_SCOPES,
            expiresAt: opts.expires ?? null,
            createdBy: opts.createdBy ?? null,
          });
          print({ ...apiKey, key, tenant: tenant.slug }, [
            `created key ${displayApiKey(apiKey.prefix, apiKey.last4)} "${apiKey.name}" for tenant ${tenant.slug}`,
            `  id      ${apiKey.id}`,
            `  scopes  ${apiKey.scopes.join(", ")}`,
            ...(apiKey.expires_at ? [`  expires ${apiKey.expires_at}`] : []),
            ...plaintextLines(key),
          ]);
        });
      },
    );

  program
    .command("create-admin-key")
    .description(
      "create a cross-tenant admin key (selects a tenant with X-Tenant-Slug); printed once",
    )
    .requiredOption("--name <name>", "label of the key")
    .option("--expires <iso>", "expiry date-time (ISO 8601)", dateArgument)
    .option("--created-by <who>", "recorded as created_by")
    .action(async (opts: { name: string; expires?: Date; createdBy?: string }) => {
      await withDb(async ({ db }) => {
        const { apiKey, key } = await createApiKey(db, {
          tenantId: null,
          name: opts.name,
          env: "admin",
          scopes: ["admin"],
          expiresAt: opts.expires ?? null,
          createdBy: opts.createdBy ?? null,
        });
        print({ ...apiKey, key }, [
          `created admin key ${displayApiKey(apiKey.prefix, apiKey.last4)} "${apiKey.name}"`,
          `  id      ${apiKey.id}`,
          "  WARNING: an admin key reaches every tenant (X-Tenant-Slug). Guard it accordingly.",
          ...plaintextLines(key),
        ]);
      });
    });

  program
    .command("list-keys")
    .description("list API keys (never the plaintext or the hash)")
    .option("--tenant <slug>", "only this tenant's keys", slugArgument)
    .option("--admin", "only admin keys")
    .action(async (opts: { tenant?: string; admin?: boolean }) => {
      await withDb(async ({ db }) => {
        let tenantId: string | null | undefined;
        if (opts.admin) tenantId = null;
        else if (opts.tenant) tenantId = (await getTenantBySlug(db, opts.tenant)).id;
        const keys = await listApiKeys(db, { tenantId });
        const slugs = new Map<string, string>();
        for (const key of keys) {
          if (key.tenant_id && !slugs.has(key.tenant_id)) {
            const tenant = await tenantById(db, key.tenant_id);
            slugs.set(key.tenant_id, tenant ?? "?");
          }
        }
        print(
          { keys },
          keys.length === 0
            ? "no keys"
            : keys.map((key) =>
                formatKeyLine(key, key.tenant_id ? (slugs.get(key.tenant_id) ?? null) : null),
              ),
        );
      });
    });

  program
    .command("revoke-key")
    .description("revoke a key by id or display form (vola_live…k3Qz); it stops working at once")
    .argument("<id|prefix…last4>", "the key")
    .action(async (reference: string) => {
      await withDb(async ({ db }) => {
        const row = await findApiKey(db, reference);
        const revoked = await revokeApiKey(db, row.id);
        print(
          revoked,
          `revoked key ${displayApiKey(revoked.prefix, revoked.last4)} "${revoked.name}" (${revoked.id})`,
        );
      });
    });

  return program;
}

/** The slug of tenant `id`, or `null`. */
async function tenantById(db: DatabaseHandle["db"], id: string): Promise<string | null> {
  const [row] = await db
    .select({ slug: schema.tenants.slug })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, id));
  return row?.slug ?? null;
}

/**
 * Parses `argv` (without `node` and the script) and returns the process exit code.
 * `program` defaults to `buildProgram(io, options)`; tests pass one with extra commands.
 */
export async function runCli(
  argv: string[],
  io: CliIo,
  program = buildProgram(io),
): Promise<number> {
  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    // commander's exitOverride throws for --help/--version (code 0) and usage errors.
    if (error && typeof error === "object" && "exitCode" in error) {
      return Number((error as { exitCode: number }).exitCode);
    }
    io.err(friendlyError(error));
    return 1;
  }
}

/** The first `code` on `error` or its `cause` chain (drizzle wraps the pg error). */
function errorCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== "object" || depth > 5) return null;
  if ("code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return errorCode((error as { cause?: unknown }).cause, depth + 1);
}

/** One line a person understands, for the errors the commands raise. */
export function friendlyError(error: unknown): string {
  if (error instanceof VolaError) return `${error.code}: ${error.message}`;
  if (error instanceof ConfigError) return error.message;
  const code = errorCode(error);
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET") {
    return `cannot reach the database (${code}); check VOLA_DATABASE_URL`;
  }
  return error instanceof Error ? error.message : String(error);
}

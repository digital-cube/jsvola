import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ApiKey,
  displayApiKey,
  InstanceTypeSchema,
  SCOPES,
  SlugSchema,
  type Tenant,
  type TransferInstance,
  TransferRequestSchema,
  type TransferResult,
  UserIdSchema,
} from "@vola/core";
import { LookupCompileError, promoteCandidates, validateTranslationsCsv } from "@vola/lookups";
import {
  AuditLog,
  type Config,
  ConfigError,
  connect,
  createApiKey,
  createAuditSink,
  createEncryptionService,
  createFileEventBus,
  createTenant,
  type DatabaseHandle,
  DEFAULT_LOOKUPS_PATH,
  findApiKey,
  generateKeyLine,
  getTenantBySlug,
  initLookups,
  KeyFile,
  type KeyUsage,
  keyAuditPayload,
  listApiKeys,
  loadConfig,
  revokeApiKey,
  runMigrations,
  schema,
  setTenantDefaultEncryption,
  TENANT_DEFAULT_ENCRYPTIONS,
  tenantKeyUsage,
  transferInstances,
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
  /**
   * The audit trail key and transfer commands write to (plan 5.2). Default: memento when
   * `VOLA_MEMENTO_URL` + `VOLA_MEMENTO_API_KEY` are in `env`, nothing otherwise; a push is
   * one direct try and the command waits for it. Tests pass their own.
   */
  audit?: AuditLog | undefined;
  /** Who the CLI says it is in audit events (`cli:<user>`). Default: `$USER`, else `cli`. */
  actor?: string | undefined;
  /**
   * Redis `transfer` announces the move on (live subscribers of both tenants). Default:
   * `VOLA_REDIS_URL` from `env`; `null`: announce nowhere (tests).
   */
  redisUrl?: string | null | undefined;
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

/** `type:id` → a transfer instance. */
function instanceArgument(value: string, previous: TransferInstance[] = []): TransferInstance[] {
  const colon = value.indexOf(":");
  if (colon < 0) throw new InvalidArgumentError("must be <instance_type>:<instance_id>");
  const type = InstanceTypeSchema.safeParse(value.slice(0, colon));
  if (!type.success)
    throw new InvalidArgumentError(`instance_type: ${type.error.issues[0]?.message}`);
  const id = value.slice(colon + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new InvalidArgumentError("instance_id: must be a UUID");
  }
  return [...previous, { instance_type: type.data, instance_id: id.toLowerCase() }];
}

/** The `--user-map` file: a JSON object `{ "<old user id>": "<new user id>" }`. */
export async function readUserMap(file: string): Promise<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new VolaError(
      "validation_error",
      422,
      `--user-map ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VolaError("validation_error", 422, `--user-map ${file}: must be a JSON object`);
  }
  const map: Record<string, string> = {};
  for (const [from, to] of Object.entries(parsed as Record<string, unknown>)) {
    if (!UserIdSchema.safeParse(from).success || !UserIdSchema.safeParse(to).success) {
      throw new VolaError(
        "validation_error",
        422,
        `--user-map ${file}: "${from}" must map to a user id (a string of at most 255 characters)`,
      );
    }
    map[from] = to as string;
  }
  return map;
}

/** The lines a transfer result is printed as. */
export function transferLines(result: TransferResult): string[] {
  const verb = result.dry_run ? "would move" : "moved";
  return [
    `${verb} ${result.instances} instance(s) from tenant ${result.from_tenant} to ${result.to_tenant}${result.dry_run ? " (dry run, nothing written)" : ""}`,
    `  files           ${result.files}`,
    `  folders         ${result.folders} (${result.merged_folders} merged into existing destination folders)`,
    `  shares          ${result.shares}`,
    `  jobs            ${result.jobs}`,
    `  metadata        ${result.metadata}`,
    `  uploads         ${result.uploads}`,
  ];
}

/** The lines of `keys-status`. */
export function keyStatusLines(path: string, lines: number, usage: KeyUsage[]): string[] {
  const total = usage.reduce((sum, u) => sum + u.files, 0);
  const orphaned = usage.filter((u) => u.line === null);
  return [
    `${path}: ${lines} key line(s), line 0 active; ${total} tenant-encrypted file(s)`,
    ...usage.map((u) =>
      u.line === null
        ? `  kid ${u.kid}  NO LINE  ${u.files} file(s) — these cannot be decrypted; restore the key line`
        : `  kid ${u.kid}  line ${u.line}${u.line === 0 ? " (active)" : ""}  ${u.files} file(s)`,
    ),
    ...(orphaned.length > 0
      ? [
          `WARNING: ${orphaned.reduce((s, u) => s + u.files, 0)} file(s) depend on a key that is not in the file`,
        ]
      : []),
    ...(usage.some((u) => u.line !== null && u.line > 0)
      ? [
          "older lines are still in use: they retire lazily, one download or info at a time; keep them",
        ]
      : []),
  ];
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
 * The `vola` command tree: `migrate`, `create-tenant`, `tenant-set`, `create-key`,
 * `create-admin-key`, `list-keys`, `revoke-key`, `transfer`, `keys-status` (every one reads
 * `VOLA_DATABASE_URL` and connects only when it runs), `keys-generate` (the encryption key
 * file only) and the vocabulary commands `lookup-promote`, `lookups validate`, `lookups
 * candidates` (files only, no database).
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
  $ vola tenant-set --slug acme --default-encryption tenant
  $ vola keys-generate
  $ vola keys-status
  $ vola transfer --from acme --to beta --instance tickets:5c1b… --instance tickets:9e2f… --dry-run
  $ vola transfer --from acme --to beta --instance tickets:5c1b… --user-map users.json
  $ vola lookups validate
  $ vola lookups candidates
  $ vola lookup-promote --dry-run

Environment:
  VOLA_DATABASE_URL     PostgreSQL the commands use (default postgresql://vola:vola@localhost:5432/vola)
  VOLA_REDIS_URL        with it, transfer announces the move to live subscribers
  VOLA_MEMENTO_URL      with VOLA_MEMENTO_API_KEY: key and transfer commands write audit events to memento
  VOLA_KEY_FILE         the tenant encryption key file (default /run/secrets/vola.key); keys-generate / keys-status / transfer
  VOLA_LOOKUPS_PATH     lookups.yaml the vocabulary commands work on (default: the repository's)

Scopes: ${SCOPES.join(", ")}`,
    );

  const json = () => Boolean(program.opts().json);
  const print = (data: unknown, lines: string | string[]) => {
    if (json()) io.out(JSON.stringify(data));
    else for (const line of Array.isArray(lines) ? lines : [lines]) io.out(line);
  };

  const env = () => options.env ?? process.env;
  let loaded: Config | undefined;
  const config = () => {
    loaded ??= loadConfig(env());
    return loaded;
  };
  /** Runs `fn` with a database handle and closes it afterwards. */
  const withDb = async <T>(fn: (handle: DatabaseHandle) => Promise<T>): Promise<T> => {
    const url = options.databaseUrl ?? config().databaseUrl;
    const handle = connect(url, { max: 1 });
    try {
      return await fn(handle);
    } finally {
      await handle.close();
    }
  };
  /** The audit trail of this process, created on first use and awaited before the command returns. */
  let auditLog: AuditLog | undefined;
  const audit = () => {
    auditLog ??= options.audit ?? new AuditLog({ sink: createAuditSink(config().memento) });
    return auditLog;
  };
  const actor = () => ({
    type: "cli" as const,
    id: `cli:${options.actor ?? env().USER ?? "cli"}`,
  });
  /** Runs `fn`, then waits for the audit events it emitted. */
  const audited = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } finally {
      await auditLog?.close();
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
    .command("tenant-set")
    .description("change a tenant's settings")
    .requiredOption("--slug <slug>", "the tenant", slugArgument)
    .option(
      "--default-encryption <mode>",
      `how an upload that names no encryption is stored: ${TENANT_DEFAULT_ENCRYPTIONS.join(" | ")}`,
    )
    .action(async (opts: { slug: string; defaultEncryption?: string }) => {
      if (opts.defaultEncryption === undefined) {
        throw new VolaError("validation_error", 422, "nothing to set: give --default-encryption");
      }
      await withDb(async ({ db }) => {
        const tenant = await setTenantDefaultEncryption(
          db,
          opts.slug,
          opts.defaultEncryption as string,
        );
        print(tenant, `tenant ${tenant.slug}: default_encryption = ${tenant.default_encryption}`);
      });
    });

  // --- encryption key file -----------------------------------------------------------------

  const keyFilePath = (given: string | undefined) => given ?? config().keyFile;

  program
    .command("keys-generate")
    .description(
      "write a new tenant-encryption key file (one random 32-byte key, mode 0600); refuses to overwrite",
    )
    .option("--path <file>", "where (default: VOLA_KEY_FILE, /run/secrets/vola.key)")
    .addHelpText(
      "after",
      `
To ROTATE, do not run this again: prepend a fresh line to the existing file —
  (echo "$(openssl rand -base64 32)"; cat vola.key) > vola.key.new && mv vola.key.new vola.key
Old lines must stay: they still open what they wrapped (keys-status shows how many files).`,
    )
    .action(async (opts: { path?: string }) => {
      const path = keyFilePath(opts.path);
      await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
      try {
        await writeFile(path, `${generateKeyLine()}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new VolaError(
            "conflict",
            409,
            `${path} exists; refusing to overwrite a key file (rotation = prepend a line, see --help)`,
          );
        }
        throw error;
      }
      print({ path, lines: 1 }, [
        `wrote ${path} (mode 0600, 1 key line)`,
        "Back it up somewhere safe: without this file every tenant-encrypted file is unreadable.",
      ]);
    });

  program
    .command("keys-status")
    .description(
      "how many tenant-encrypted files depend on which line of the key file (never prints a key)",
    )
    .option("--path <file>", "the key file (default: VOLA_KEY_FILE)")
    .action(async (opts: { path?: string }) => {
      const path = keyFilePath(opts.path);
      const lines = await new KeyFile(path).lines();
      await withDb(async ({ db }) => {
        const usage = await tenantKeyUsage(db, lines);
        print(
          {
            path,
            lines: lines.length,
            usage,
            orphaned_files: usage.filter((u) => u.line === null).reduce((s, u) => s + u.files, 0),
          },
          keyStatusLines(path, lines.length, usage),
        );
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
          await audited(async () =>
            audit().emit({
              event_type: "VOLA_KEY_CREATED",
              instance_type: "vola_key",
              instance_id: apiKey.id,
              actor: actor(),
              payload: { ...keyAuditPayload(apiKey), tenant: tenant.slug },
            }),
          );
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
        await audited(async () =>
          audit().emit({
            event_type: "VOLA_KEY_CREATED",
            instance_type: "vola_key",
            instance_id: apiKey.id,
            actor: actor(),
            payload: { ...keyAuditPayload(apiKey), tenant: null },
          }),
        );
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
        await audited(async () =>
          audit().emit({
            event_type: "VOLA_KEY_REVOKED",
            instance_type: "vola_key",
            instance_id: revoked.id,
            actor: actor(),
            payload: {
              ...keyAuditPayload(revoked),
              tenant: revoked.tenant_id ? await tenantById(db, revoked.tenant_id) : null,
            },
          }),
        );
        print(
          revoked,
          `revoked key ${displayApiKey(revoked.prefix, revoked.last4)} "${revoked.name}" (${revoked.id})`,
        );
      });
    });

  program
    .command("transfer")
    .description(
      "move every file of the given instances from one tenant to another (rows only; blobs stay)",
    )
    .requiredOption("--from <slug>", "source tenant", slugArgument)
    .requiredOption("--to <slug>", "destination tenant (must exist)", slugArgument)
    .requiredOption(
      "--instance <type:id>",
      "an instance to move, e.g. tickets:5c1b…; repeat for several",
      instanceArgument,
    )
    .option(
      "--user-map <file.json>",
      'JSON object {"<old user id>": "<new user id>"} rewriting created_by / deleted_by / last_accessed_by',
    )
    .option("--dry-run", "report the counts, write nothing")
    .addHelpText(
      "after",
      `
A folder whose path already exists on the destination is merged into it; share tokens stay the
same; statistics of both tenants are recomputed. The key of a tenant-encrypted file is
re-wrapped for the destination (needs VOLA_KEY_FILE); an instance holding a keyring- or
caller-encrypted file is refused (encrypted_transfer_unsupported), as is one with a resumable
upload in progress (uploads_in_progress). With VOLA_REDIS_URL live subscribers of both tenants
are told.`,
    )
    .action(
      async (opts: {
        from: string;
        to: string;
        instance: TransferInstance[];
        userMap?: string;
        dryRun?: boolean;
      }) => {
        const request = TransferRequestSchema.safeParse({
          from_tenant: opts.from,
          to_tenant: opts.to,
          instances: opts.instance,
          user_map: opts.userMap ? await readUserMap(opts.userMap) : {},
          dry_run: Boolean(opts.dryRun),
        });
        if (!request.success) {
          const issue = request.error.issues[0];
          throw new VolaError(
            "validation_error",
            422,
            `${issue?.path.join(".") || "transfer"}: ${issue?.message ?? "invalid"}`,
          );
        }
        await withDb(async ({ db }) => {
          const redisUrl = options.redisUrl === undefined ? config().redisUrl : options.redisUrl;
          const events = redisUrl ? createFileEventBus(redisUrl) : undefined;
          const crypto = createEncryptionService({ db, keyFile: config().keyFile });
          try {
            const result = await audited(() =>
              transferInstances(
                {
                  db,
                  events,
                  audit: request.data.dry_run ? undefined : audit(),
                  actor: actor(),
                  crypto,
                },
                request.data,
              ),
            );
            print(result, transferLines(result));
          } finally {
            await events?.close();
          }
        });
      },
    );

  // --- vocabulary ------------------------------------------------------------------------

  const lookupsPath = () =>
    (options.env ?? process.env).VOLA_LOOKUPS_PATH?.trim() || DEFAULT_LOOKUPS_PATH;
  const pathOption = () =>
    new Option("--path <file>", "lookups.yaml (default: VOLA_LOOKUPS_PATH or the repository's)");
  const where = (file: string, issue: { line: number; column?: string | undefined }) =>
    issue.line > 0 ? `${file}:${issue.line}${issue.column ? ` [${issue.column}]` : ""}` : file;

  program
    .command("lookup-promote")
    .description(
      "move the candidates recorded under var/candidates into lookups.yaml and i18n/translations.csv",
    )
    .addOption(pathOption())
    .option("--dir <dir>", "candidates directory (default: var/candidates next to lookups.yaml)")
    .option("--translations <file>", "default: i18n/translations.csv next to lookups.yaml")
    .option("--only <Section.TERM...>", "promote only these candidates")
    .option("--dry-run", "report what would change, write nothing")
    .action(
      async (opts: {
        path?: string;
        dir?: string;
        translations?: string;
        only?: string[];
        dryRun?: boolean;
      }) => {
        const result = await promoteCandidates({
          path: opts.path ?? lookupsPath(),
          candidatesDir: opts.dir,
          translationsPath: opts.translations,
          only: opts.only,
          dryRun: opts.dryRun,
        });
        const verb = result.dryRun ? "would promote" : "promoted";
        print(result, [
          ...result.promoted.map(
            (p) =>
              `${verb} ${p.section}.${p.term} (seen ${p.count}×; ${Object.entries(p.labels)
                .map(([locale, label]) => `${locale}: ${label}`)
                .join(", ")})`,
          ),
          ...result.skipped.map((c) => `skipped  ${c.section}.${c.term}: ${c.reason}`),
          result.promoted.length === 0
            ? `nothing to promote in ${result.candidatesDir}`
            : `${result.dryRun ? "" : "wrote "}${result.lookupsPath} and ${result.translationsPath}`,
        ]);
      },
    );

  const lookups = program
    .command("lookups")
    .description("controlled vocabulary: lookups.yaml + i18n/translations.csv")
    .addHelpText(
      "after",
      `
Examples:
  $ vola lookups validate       check lookups.yaml and the translations
  $ vola lookups candidates     unknown values waiting to be promoted
  $ vola lookup-promote         promote them`,
    );

  lookups
    .command("validate")
    .description("check lookups.yaml and a translations CSV (exit 1 on errors)")
    .addOption(pathOption())
    .option("--translations <file>", "default: i18n/translations.csv next to lookups.yaml")
    .action(async (opts: { path?: string; translations?: string }) => {
      const path = opts.path ?? lookupsPath();
      const loaded = await initLookups({ path, candidatesDir: null }).catch((error: unknown) => {
        if (error instanceof LookupCompileError)
          throw new VolaError("validation_error", 422, error.message);
        throw error;
      });
      const csvPath = opts.translations ?? join(path, "..", "i18n", "translations.csv");
      const result = validateTranslationsCsv(await readFile(csvPath, "utf8"), loaded.registry);
      const sections = loaded.registry.sectionNames();
      print(
        {
          ok: result.ok,
          path,
          sections,
          locales: result.locales,
          errors: result.errors,
          warnings: result.warnings,
        },
        [
          `${path}: ${sections.map((s) => `${s} (${loaded.registry.terms(s).length})`).join(", ")}`,
          ...result.errors.map((issue) => `error   ${where(csvPath, issue)}: ${issue.message}`),
          ...result.warnings.map((issue) => `warning ${where(csvPath, issue)}: ${issue.message}`),
          result.ok
            ? `ok: ${result.locales.join(", ")} — ${result.warnings.length} warning(s)`
            : `${result.errors.length} error(s)`,
        ],
      );
      if (!result.ok) throw new VolaError("validation_error", 422, "translations are invalid");
    });

  lookups
    .command("candidates")
    .description("list unknown values recorded at upload, waiting to be promoted")
    .addOption(pathOption())
    .option("--dir <dir>", "default: var/candidates next to lookups.yaml")
    .action(async (opts: { path?: string; dir?: string }) => {
      const path = opts.path ?? lookupsPath();
      const loaded = await initLookups({
        path,
        candidatesDir: opts.dir ?? join(path, "..", "var", "candidates"),
      });
      const recorder = loaded.recorder as NonNullable<typeof loaded.recorder>;
      const all: Record<string, unknown[]> = {};
      const lines: string[] = [];
      for (const section of loaded.registry.sectionNames()) {
        const candidates = await recorder.list(section);
        all[section] = candidates;
        for (const c of candidates) {
          lines.push(`${section}.${c.value}\t${c.count}\t${c.first_seen}\t${c.last_seen}`);
        }
      }
      print(all, lines.length === 0 ? `no candidates in ${recorder.dir}` : lines);
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

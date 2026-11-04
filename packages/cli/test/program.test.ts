import {
  authenticateApiKey,
  connect,
  type DatabaseHandle,
  loadConfig,
  schema,
} from "@vol-a/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProgram, CLI_VERSION, formatKeyLine, friendlyError, runCli } from "../src/index.js";

const databaseUrl = loadConfig().testDatabaseUrl;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

/** Runs the CLI against the test database and returns exit code and output. */
async function vola(...argv: string[]) {
  const c = capture();
  const code = await runCli(argv, c.io, buildProgram(c.io, { databaseUrl }));
  return { code, out: c.out.join("\n"), err: c.err.join("\n"), lines: c.out };
}

/** Same, with `--json`: the parsed last line. */
async function volaJson<T = Record<string, unknown>>(...argv: string[]) {
  const result = await vola("--json", ...argv);
  return { ...result, json: result.out ? (JSON.parse(result.lines.at(-1) as string) as T) : null };
}

describe("vola CLI (no database)", () => {
  it("prints help without arguments", async () => {
    const c = capture();
    expect(await runCli([], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain("Usage: vola");
    expect(c.out.join("\n")).toContain("create-tenant");
  });

  it("prints its version", async () => {
    const c = capture();
    expect(await runCli(["--version"], c.io)).toBe(0);
    expect(c.out.join("\n")).toContain(CLI_VERSION);
  });

  it("fails on an unknown option and on usage errors without connecting", async () => {
    const c = capture();
    expect(await runCli(["--nope"], c.io)).toBe(1);
    expect(c.err.join("\n")).toContain("unknown option");

    const bad = await vola("create-tenant", "--slug", "Not A Slug");
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/lowercase letters, digits and dashes/);

    const env = await vola("create-key", "--tenant", "acme", "--name", "x", "--env", "prod");
    expect(env.code).toBe(1);
    expect(env.err).toMatch(/must be live or test/);

    const missing = await vola("create-key", "--tenant", "acme");
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/required option '--name <name>'/);
  });

  it("reports a failing command as exit code 1 with its message", async () => {
    const c = capture();
    const program = buildProgram(c.io);
    program.command("explode").action(() => {
      throw new Error("kaboom");
    });
    program.command("reject").action(() => Promise.reject("plain string"));
    expect(await runCli(["explode"], c.io, program)).toBe(1);
    expect(c.err).toContain("kaboom");
    expect(await runCli(["reject"], c.io, program)).toBe(1);
    expect(c.err).toContain("plain string");
  });

  it("explains an unreachable database", async () => {
    const c = capture();
    const program = buildProgram(c.io, { databaseUrl: "postgresql://vola:vola@127.0.0.1:1/vola" });
    expect(await runCli(["list-keys"], c.io, program)).toBe(1);
    expect(c.err.join("\n")).toMatch(/cannot reach the database \(ECONNREFUSED\)/);
  });

  it("friendlyError handles the error shapes", () => {
    expect(friendlyError(new Error("x"))).toBe("x");
    expect(friendlyError("y")).toBe("y");
    expect(friendlyError({ code: "ENOTFOUND" })).toMatch(/ENOTFOUND/);
    expect(friendlyError(new Error("wrapped", { cause: { code: "ECONNRESET" } }))).toMatch(
      /ECONNRESET/,
    );
    expect(friendlyError({ code: "OTHER" })).toBe("[object Object]");
  });
});

describe("vola CLI against the test database", () => {
  let handle: DatabaseHandle;
  const slug = `cli-${Date.now().toString(36)}`;

  beforeAll(async () => {
    handle = connect(databaseUrl, { max: 1 });
    await handle.db.delete(schema.apiKeys);
    await handle.db.delete(schema.tenants);
  });
  afterAll(() => handle.close());

  it("migrate is idempotent", async () => {
    const result = await vola("migrate");
    expect(result.code).toBe(0);
    expect(result.out).toBe("migrations applied");
  });

  it("create-tenant creates once and refuses a duplicate", async () => {
    const created = await vola("create-tenant", "--slug", slug, "--name", "CLI Tenant");
    expect(created.code).toBe(0);
    expect(created.out).toMatch(new RegExp(`created tenant ${slug} \\(CLI Tenant\\) id=`));

    const duplicate = await vola("create-tenant", "--slug", slug);
    expect(duplicate.code).toBe(1);
    expect(duplicate.err).toMatch(/^conflict: tenant ".*" already exists/);

    const titled = await volaJson<{ slug: string; name: string }>(
      "create-tenant",
      "--slug",
      `${slug}-two`,
    );
    expect(titled.code).toBe(0);
    expect(titled.json?.name).toMatch(/^Cli .* Two$/);
  });

  it("create-key prints the plaintext once, with the warning, and the key authenticates", async () => {
    const result = await vola(
      "create-key",
      "--tenant",
      slug,
      "--name",
      "backend",
      "--env",
      "test",
      "--scopes",
      "files:read, keys:write",
      "--created-by",
      "igor",
    );
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/created key vola_test…[A-Za-z0-9]{4} "backend" for tenant/);
    expect(result.out).toMatch(/shown ONCE/);
    const key = result.lines
      .map((l) => l.trim())
      .find((l) => /^vola_test_[A-Za-z0-9]{32}$/.test(l));
    expect(key).toBeDefined();

    const found = await authenticateApiKey(handle.db, key as string);
    expect(found?.tenant?.slug).toBe(slug);
    expect(found?.key.scopes).toEqual(["files:read", "keys:write"]);
    expect(found?.key.createdBy).toBe("igor");

    // The plaintext is nowhere but in that output.
    const listed = await vola("list-keys", "--tenant", slug);
    expect(listed.out).not.toContain(key as string);
    expect(listed.out).toContain((key as string).slice(-4));
  });

  it("create-key refuses an unknown tenant, unknown scopes and admin", async () => {
    const tenant = await vola("create-key", "--tenant", "ghost", "--name", "x");
    expect(tenant.code).toBe(1);
    expect(tenant.err).toMatch(/^tenant_not_found/);
    const scopes = await vola(
      "create-key",
      "--tenant",
      slug,
      "--name",
      "x",
      "--scopes",
      "files:all",
    );
    expect(scopes.code).toBe(1);
    expect(scopes.err).toMatch(/unknown scope "files:all"/);
    const admin = await vola("create-key", "--tenant", slug, "--name", "x", "--scopes", "admin");
    expect(admin.code).toBe(1);
    expect(admin.err).toMatch(/cannot hold admin/);
  });

  it("create-admin-key mints an admin key with a warning; --json gives the whole record", async () => {
    const result = await volaJson<{ key: string; is_admin: boolean; scopes: string[]; id: string }>(
      "create-admin-key",
      "--name",
      "ops",
    );
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ is_admin: true, scopes: ["admin"], prefix: "vola_admin" });
    expect(result.json?.key).toMatch(/^vola_admin_[A-Za-z0-9]{32}$/);

    const human = await vola(
      "create-admin-key",
      "--name",
      "ops2",
      "--expires",
      "2099-01-01T00:00:00Z",
    );
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/WARNING: an admin key reaches every tenant/);
    expect(human.out).toMatch(/shown ONCE/);
  });

  it("list-keys lists everything, by tenant, or admin only", async () => {
    const all = await volaJson<{ keys: { tenant_id: string | null }[] }>("list-keys");
    expect(all.json?.keys.length).toBeGreaterThanOrEqual(3);
    const tenant = await volaJson<{ keys: { tenant_id: string | null }[] }>(
      "list-keys",
      "--tenant",
      slug,
    );
    expect(tenant.json?.keys.length).toBe(1);
    const admin = await volaJson<{ keys: { is_admin: boolean }[] }>("list-keys", "--admin");
    expect(admin.json?.keys.every((k) => k.is_admin)).toBe(true);
    expect(admin.json?.keys.length).toBe(2);

    const human = await vola("list-keys", "--tenant", slug);
    expect(human.lines).toHaveLength(1);
    expect(human.out).toMatch(/vola_test…\w{4}\s+backend\s+tenant=cli-/);

    const none = await vola("list-keys", "--tenant", `${slug}-two`);
    expect(none.out).toBe("no keys");
  });

  it("revoke-key by id and by display form; the key stops authenticating", async () => {
    const minted = await volaJson<{ id: string; key: string; prefix: string; last4: string }>(
      "create-key",
      "--tenant",
      slug,
      "--name",
      "doomed",
    );
    const byId = await vola("revoke-key", minted.json?.id as string);
    expect(byId.code).toBe(0);
    expect(byId.out).toMatch(/^revoked key vola_live…\w{4} "doomed"/);
    expect(await authenticateApiKey(handle.db, minted.json?.key as string)).toBeNull();

    const second = await volaJson<{ id: string; key: string; prefix: string; last4: string }>(
      "create-key",
      "--tenant",
      slug,
      "--name",
      "doomed-too",
    );
    const display = `${second.json?.prefix}…${second.json?.last4}`;
    const byDisplay = await vola("revoke-key", display);
    if (byDisplay.code === 0) {
      expect(await authenticateApiKey(handle.db, second.json?.key as string)).toBeNull();
    } else {
      // Two keys happen to share prefix+last4 (1 in 14 million): the CLI must say so.
      expect(byDisplay.err).toMatch(/^conflict/);
    }

    const unknown = await vola("revoke-key", "vola_live…ZZZZ");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/^not_found/);
    const garbage = await vola("revoke-key", "what");
    expect(garbage.code).toBe(1);
    expect(garbage.err).toMatch(/neither a key id nor a display form/);

    const listed = await vola("list-keys", "--tenant", slug);
    expect(listed.out).toMatch(/doomed\s.*\[REVOKED\]/);
  });

  it("formatKeyLine flags admin, revoked and expired keys", () => {
    const base = {
      id: "id",
      tenant_id: null,
      name: "n",
      prefix: "vola_admin" as const,
      last4: "abcd",
      scopes: ["admin" as const],
      is_admin: true,
      created_at: "2026-01-01T00:00:00.000Z",
      last_used_at: "2026-02-01T00:00:00.000Z",
      expires_at: "2020-01-01T00:00:00.000Z",
      revoked_at: "2026-03-01T00:00:00.000Z",
      created_by: null,
    };
    const line = formatKeyLine(base, null);
    expect(line).toContain("tenant=-");
    expect(line).toContain("last_used=2026-02-01");
    expect(line).toContain("[ADMIN,REVOKED,EXPIRED]");
  });
});

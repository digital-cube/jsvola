import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connect,
  createTenant,
  type DatabaseHandle,
  generateKeyLine,
  keyId,
  loadConfig,
  parseKeyFile,
  StaticKeys,
  schema,
  TenantWrapProvider,
} from "@vola/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProgram, keyStatusLines, runCli } from "../src/index.js";

const databaseUrl = loadConfig().testDatabaseUrl;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

let handle: DatabaseHandle;
let dir: string;

/** Runs the CLI against the test database with `VOLA_KEY_FILE` pointing into the temp dir. */
async function vola(keyFile: string, ...argv: string[]) {
  const c = capture();
  const program = buildProgram(c.io, {
    databaseUrl,
    redisUrl: null,
    env: { ...process.env, VOLA_KEY_FILE: keyFile },
  });
  const code = await runCli(argv, c.io, program);
  return { code, out: c.out.join("\n"), err: c.err.join("\n"), lines: c.out };
}

beforeAll(async () => {
  handle = connect(databaseUrl, { max: 2 });
  await handle.db.delete(schema.files);
  await handle.db.delete(schema.apiKeys);
  await handle.db.delete(schema.tenants);
  dir = await mkdtemp(join(tmpdir(), "vola-cli-keys-"));
});
afterAll(async () => {
  await handle.close();
  await rm(dir, { recursive: true, force: true });
});

describe("vola keys-generate", () => {
  it("writes one key line with mode 0600 and refuses to overwrite", async () => {
    const path = join(dir, "nested", "vola.key");
    const first = await vola(path, "keys-generate");
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain(`wrote ${path}`);
    expect(first.out).not.toMatch(/[A-Za-z0-9+/]{43}=/); // never the key itself
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    const lines = parseKeyFile(await readFile(path, "utf8"));
    expect(lines).toHaveLength(1);

    const again = await vola(path, "keys-generate");
    expect(again.code).toBe(1);
    expect(again.err).toContain("refusing to overwrite");
    expect(await readFile(path, "utf8")).toBe(
      `${Buffer.from(lines[0]?.key as Buffer).toString("base64")}\n`,
    );

    const json = await vola(join(dir, "other.key"), "--json", "keys-generate");
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out)).toEqual({ path: join(dir, "other.key"), lines: 1 });
  });
});

async function voleGenerate(path: string) {
  return vola(path, "keys-generate", "--path", path);
}

describe("vola keys-status", () => {
  it("counts tenant-encrypted files per key line and flags keys that are gone", async () => {
    const path = join(dir, "status.key");
    const active = generateKeyLine();
    const older = generateKeyLine();
    const removed = generateKeyLine();
    await writeFile(path, `${active}\n${older}\n`, { mode: 0o600 });
    const tenant = await createTenant(handle.db, { slug: `kt-${randomUUID().slice(0, 8)}` });
    const fileOf = async (provider: TenantWrapProvider, n: number) => {
      for (let i = 0; i < n; i++) {
        const id = randomUUID();
        const fkCt = await provider.wrap(Buffer.alloc(32, i + 1), {
          fileId: id,
          tenantId: tenant.id,
        });
        await handle.db.insert(schema.files).values({
          id,
          tenantId: tenant.id,
          instanceType: "tickets",
          instanceId: randomUUID(),
          hash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
          size: 3,
          filename: `${id}.bin`,
          mimeType: "application/octet-stream",
          kind: "other",
          encryption: "tenant",
          encFormat: 1,
          fkCt,
          metaCt: Buffer.alloc(40),
        });
      }
    };
    await fileOf(new TenantWrapProvider(new StaticKeys([active])), 3);
    await fileOf(new TenantWrapProvider(new StaticKeys([older])), 2);
    await fileOf(new TenantWrapProvider(new StaticKeys([removed])), 1);

    const result = await vola(path, "keys-status");
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(
      `${path}: 2 key line(s), line 0 active; 6 tenant-encrypted file(s)`,
    );
    expect(result.out).toContain(
      `kid ${keyId(Buffer.from(active, "base64")).toString("hex")}  line 0 (active)  3 file(s)`,
    );
    expect(result.out).toContain(
      `kid ${keyId(Buffer.from(older, "base64")).toString("hex")}  line 1  2 file(s)`,
    );
    expect(result.out).toContain("NO LINE  1 file(s)");
    expect(result.out).toContain("WARNING: 1 file(s) depend on a key that is not in the file");
    expect(result.out).toContain("older lines are still in use");
    expect(result.out).not.toContain(active);
    expect(result.out).not.toContain(older);

    const json = await vola(path, "--json", "keys-status");
    expect(JSON.parse(json.out)).toMatchObject({ path, lines: 2, orphaned_files: 1 });

    const missing = await vola(join(dir, "nope.key"), "keys-status");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("not readable");
    await handle.db.delete(schema.files).where(eq(schema.files.tenantId, tenant.id));
  });

  it("keyStatusLines formats an empty state", () => {
    expect(keyStatusLines("/k", 1, [])).toEqual([
      "/k: 1 key line(s), line 0 active; 0 tenant-encrypted file(s)",
    ]);
  });
});

describe("vola tenant-set", () => {
  it("sets --default-encryption and refuses the modes of later phases", async () => {
    const slug = `ts-${randomUUID().slice(0, 8)}`;
    await createTenant(handle.db, { slug });
    const set = await vola(
      join(dir, "x.key"),
      "tenant-set",
      "--slug",
      slug,
      "--default-encryption",
      "tenant",
    );
    expect(set.code, set.err).toBe(0);
    expect(set.out).toContain(`tenant ${slug}: default_encryption = tenant`);
    const [row] = await handle.db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    expect(row?.defaultEncryption).toBe("tenant");
    const keyring = await vola(
      join(dir, "x.key"),
      "tenant-set",
      "--slug",
      slug,
      "--default-encryption",
      "keyring",
    );
    expect(keyring.code).toBe(1);
    expect(keyring.err).toContain("validation_error");
    const nothing = await vola(join(dir, "x.key"), "tenant-set", "--slug", slug);
    expect(nothing.code).toBe(1);
    expect(nothing.err).toContain("nothing to set");
    const back = await vola(
      join(dir, "x.key"),
      "--json",
      "tenant-set",
      "--slug",
      slug,
      "--default-encryption",
      "none",
    );
    expect(JSON.parse(back.out)).toMatchObject({ slug, default_encryption: "none" });
    expect((await voleGenerate(join(dir, "gen.key"))).code).toBe(0);
  });
});

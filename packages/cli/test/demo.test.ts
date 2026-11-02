/**
 * `vola demo-keys` and `vola demo-seed` (plan 8.1): the seeder runs over HTTP against a real
 * server with the examples on (the test database, a temp key file so the `tenant`-encrypted
 * entries of the pack go through), uploading the repository's own demo pack.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseApiKey } from "@vola/core";
import {
  buildApp,
  connect,
  type DatabaseHandle,
  generateApiKey,
  generateKeyLine,
  loadConfig,
  schema,
} from "@vola/server";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProgram, readManifest, runCli } from "../src/index.js";

const ASSETS = fileURLToPath(new URL("../../../apps/examples/assets", import.meta.url));
const READ_KEY = generateApiKey("test").key;
const WRITE_KEY = generateApiKey("test").key;
const INSTANCE = "00000000-0000-4000-8000-0000000000aa";

let handle: DatabaseHandle;
let app: FastifyInstance;
let root: string;
let url: string;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

async function vola(...argv: string[]) {
  const c = capture();
  const code = await runCli(argv, c.io, buildProgram(c.io, { env: {} }));
  return { code, out: c.out.join("\n"), err: c.err.join("\n"), lines: c.out };
}

beforeAll(async () => {
  const base = loadConfig();
  handle = connect(base.testDatabaseUrl, { max: 2 });
  await handle.db.delete(schema.tenants).where(eq(schema.tenants.slug, "demo-cli"));
  root = await mkdtemp(join(tmpdir(), "vola-cli-demo-"));
  const keyFile = join(root, "vola.key");
  await writeFile(keyFile, `${generateKeyLine()}\n`, { mode: 0o600 });
  const config = loadConfig({
    ...process.env,
    VOLA_DATABASE_URL: base.testDatabaseUrl,
    VOLA_PREFIX: "/vola",
    VOLA_RECORD_CANDIDATES: "false",
    VOLA_WORKER_ENABLED: "0",
    VOLA_STORAGE_PATH: join(root, "storage"),
    VOLA_KEY_FILE: keyFile,
    VOLA_EXAMPLES: "true",
    VOLA_DEMO_API_KEY: READ_KEY,
    VOLA_DEMO_WRITE_KEY: WRITE_KEY,
    VOLA_DEMO_TENANT: "demo-cli",
    VOLA_DEMO_INSTANCE_ID: INSTANCE,
    VOLA_DEMO_PURGE_INTERVAL_MIN: "0",
  });
  app = await buildApp({ config, db: handle.db, logger: false, uploadSweepIntervalMs: 0 });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  url = `${address}/vola`;
});
afterAll(async () => {
  await app.close();
  await handle.db.delete(schema.tenants).where(eq(schema.tenants.slug, "demo-cli"));
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

describe("vola demo-keys", () => {
  it("prints two different well-formed keys as .env lines, and as JSON", async () => {
    const text = await vola("demo-keys");
    expect(text.code).toBe(0);
    const lines = text.lines.filter((l) => l.startsWith("VOLA_DEMO_"));
    expect(lines).toHaveLength(2);
    const [read = "", write = ""] = lines.map((l) => l.split("=")[1] ?? "");
    expect(parseApiKey(read)?.env).toBe("live");
    expect(parseApiKey(write)?.env).toBe("live");
    expect(read).not.toBe(write);
    const json = await vola("--json", "demo-keys", "--env", "test");
    const parsed = JSON.parse(json.lines.at(-1) ?? "{}");
    expect(parseApiKey(parsed.VOLA_DEMO_API_KEY)?.env).toBe("test");
    expect(parseApiKey(parsed.VOLA_DEMO_WRITE_KEY)?.env).toBe("test");
  });
});

describe("vola demo-seed", () => {
  it("reads the repository's manifest", async () => {
    const manifest = await readManifest(ASSETS);
    expect(manifest.files.length).toBeGreaterThanOrEqual(8);
    expect(manifest.files.map((f) => f.slug)).toContain("ocr-sample");
    await expect(readManifest(root)).rejects.toThrow(/manifest.json/);
  });

  it("uploads the pack once, leaves it alone the second time, and publishes the media", async () => {
    const first = await vola(
      "--json",
      "demo-seed",
      "--url",
      url,
      "--key",
      WRITE_KEY,
      "--assets",
      ASSETS,
      "--instance-id",
      INSTANCE,
      "--wait",
      "10",
    );
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    const result = JSON.parse(first.lines.at(-1) ?? "{}");
    expect(result.uploaded.length).toBeGreaterThanOrEqual(8);
    expect(result.unchanged).toEqual([]);
    expect(result.published).toEqual(["clip", "tone"]);

    const list = await fetch(`${url}/files/demo/${INSTANCE}?limit=200`, {
      headers: { authorization: `Bearer ${READ_KEY}` },
    });
    expect(list.status).toBe(200);
    const files = (await list.json()).files as {
      slug: string;
      created_by: string;
      encryption: string;
      is_global_public: boolean;
      filename: string;
    }[];
    const bySlug = new Map(files.map((f) => [f.slug, f]));
    expect(bySlug.get("aurora")).toMatchObject({ created_by: "seeder", encryption: "none" });
    expect(bySlug.get("clip")?.is_global_public).toBe(true);
    expect(bySlug.get("vault-poster")?.encryption).toBe("tenant");
    // The folder the entry named exists.
    const folder = await fetch(`${url}/folders/demo/${INSTANCE}/images`, {
      headers: { authorization: `Bearer ${READ_KEY}` },
    });
    expect(folder.status).toBe(200);

    const second = await vola(
      "demo-seed",
      "--url",
      url,
      "--key",
      WRITE_KEY,
      "--assets",
      ASSETS,
      "--instance-id",
      INSTANCE,
      "--wait",
      "10",
    );
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/0 uploaded, \d+ unchanged, 0 published/);
  });

  it("needs a key and reports an unreachable server", async () => {
    const noKey = await vola("demo-seed", "--url", url, "--assets", ASSETS);
    expect(noKey.code).toBe(1);
    expect(noKey.err).toMatch(/write key is required/);
    const down = await vola(
      "demo-seed",
      "--url",
      "http://127.0.0.1:9/vola",
      "--key",
      WRITE_KEY,
      "--assets",
      ASSETS,
      "--wait",
      "0",
    );
    expect(down.code).toBe(1);
    expect(down.err).toMatch(/not ready/);
  });
});

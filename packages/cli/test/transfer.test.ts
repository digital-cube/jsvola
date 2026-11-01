import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TransferResult } from "@vola/core";
import {
  type AuditEvent,
  AuditLog,
  connect,
  createTenant,
  type DatabaseHandle,
  loadConfig,
  schema,
} from "@vola/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildProgram, readUserMap, runCli, transferLines } from "../src/index.js";

const databaseUrl = loadConfig().testDatabaseUrl;
const audited: AuditEvent[] = [];
const audit = new AuditLog({
  sink: {
    async send(event) {
      audited.push(event);
    },
  },
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

/** Runs the CLI against the test database with a capturing audit and no Redis. */
async function vola(...argv: string[]) {
  const c = capture();
  const program = buildProgram(c.io, { databaseUrl, audit, actor: "tester", redisUrl: null });
  const code = await runCli(argv, c.io, program);
  return { code, out: c.out.join("\n"), err: c.err.join("\n"), lines: c.out };
}

let handle: DatabaseHandle;
let dir: string;
let src: { id: string; slug: string };
let dst: { id: string; slug: string };
const TYPE = "tickets";

/** A file row of `tenantId` in `instanceId` (the blob itself is never touched by a transfer). */
async function fileRow(
  tenantId: string,
  instanceId: string,
  filename: string,
  extra: Partial<typeof schema.files.$inferInsert> = {},
) {
  const [row] = await handle.db
    .insert(schema.files)
    .values({
      tenantId,
      instanceType: TYPE,
      instanceId,
      hash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      size: 3,
      filename,
      extension: "txt",
      mimeType: "text/plain",
      kind: "text",
      ...extra,
    })
    .returning();
  return row as typeof schema.files.$inferSelect;
}

beforeAll(async () => {
  handle = connect(databaseUrl, { max: 2 });
  await handle.db.delete(schema.files);
  await handle.db.delete(schema.folders);
  await handle.db.delete(schema.apiKeys);
  await handle.db.delete(schema.tenants);
  dir = await mkdtemp(join(tmpdir(), "vola-cli-transfer-"));
  const stamp = Date.now().toString(36);
  const a = await createTenant(handle.db, { slug: `src-${stamp}` });
  const b = await createTenant(handle.db, { slug: `dst-${stamp}` });
  src = { id: a.id, slug: a.slug };
  dst = { id: b.id, slug: b.slug };
});
afterAll(async () => {
  await handle.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  audited.length = 0;
});

describe("vola transfer", () => {
  it("validates its options before connecting", async () => {
    const missing = await vola("transfer", "--from", "aa", "--to", "bb");
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/required option '--instance <type:id>'/);
    const shape = await vola("transfer", "--from", "aa", "--to", "bb", "--instance", "tickets");
    expect(shape.code).toBe(1);
    expect(shape.err).toMatch(/must be <instance_type>:<instance_id>/);
    const id = await vola("transfer", "--from", "aa", "--to", "bb", "--instance", "tickets:42");
    expect(id.code).toBe(1);
    expect(id.err).toMatch(/instance_id: must be a UUID/);
    const type = await vola(
      "transfer",
      "--from",
      "aa",
      "--to",
      "bb",
      "--instance",
      `Tickets:${randomUUID()}`,
    );
    expect(type.code).toBe(1);
    expect(type.err).toMatch(/instance_type/);
    const same = await vola(
      "transfer",
      "--from",
      "aa",
      "--to",
      "aa",
      "--instance",
      `tickets:${randomUUID()}`,
    );
    expect(same.code).toBe(1);
    expect(same.err).toMatch(/^validation_error: .*same/);
  });

  it("reports an unknown tenant and a bad --user-map file", async () => {
    const instance = `${TYPE}:${randomUUID()}`;
    const ghost = await vola(
      "transfer",
      "--from",
      "ghost",
      "--to",
      dst.slug,
      "--instance",
      instance,
    );
    expect(ghost.code).toBe(1);
    expect(ghost.err).toMatch(/^tenant_not_found: tenant "ghost" not found/);

    const broken = join(dir, "broken.json");
    await writeFile(broken, "{not json");
    const bad = await vola(
      "transfer",
      "--from",
      src.slug,
      "--to",
      dst.slug,
      "--instance",
      instance,
      "--user-map",
      broken,
    );
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^validation_error: --user-map .*broken\.json/);
    const list = join(dir, "list.json");
    await writeFile(list, "[1]");
    await expect(readUserMap(list)).rejects.toThrow(/must be a JSON object/);
    const values = join(dir, "values.json");
    await writeFile(values, '{"a": 1}');
    await expect(readUserMap(values)).rejects.toThrow(/must map to a user id/);
    const missing = await readUserMap(join(dir, "nope.json")).catch((e: unknown) => e);
    expect(String(missing)).toMatch(/ENOENT/);
  });

  it("--dry-run reports the counts and writes nothing; the real run moves the rows and maps users", async () => {
    const instanceId = randomUUID();
    const other = randomUUID();
    const [folder] = await handle.db
      .insert(schema.folders)
      .values({
        tenantId: src.id,
        instanceType: TYPE,
        instanceId,
        name: "docs",
        path: "docs",
        createdBy: "alice",
      })
      .returning();
    const a = await fileRow(src.id, instanceId, "a.txt", {
      folderId: folder?.id,
      createdBy: "alice",
    });
    const b = await fileRow(src.id, instanceId, "b.txt", {
      createdBy: "bob",
      deletedAt: new Date(),
      deletedBy: "alice",
    });
    const stays = await fileRow(src.id, other, "stays.txt");
    const mapFile = join(dir, "users.json");
    await writeFile(mapFile, JSON.stringify({ alice: "u-1" }));

    const dry = await vola(
      "transfer",
      "--from",
      src.slug,
      "--to",
      dst.slug,
      "--instance",
      `${TYPE}:${instanceId}`,
      "--user-map",
      mapFile,
      "--dry-run",
    );
    expect(dry.code, dry.err).toBe(0);
    expect(dry.lines[0]).toBe(
      `would move 1 instance(s) from tenant ${src.slug} to ${dst.slug} (dry run, nothing written)`,
    );
    expect(dry.out).toMatch(/files\s+2/);
    expect(dry.out).toMatch(/folders\s+1 \(0 merged/);
    expect(
      (await handle.db.select().from(schema.files).where(eq(schema.files.id, a.id)))[0],
    ).toMatchObject({
      tenantId: src.id,
      createdBy: "alice",
    });
    expect(audited).toEqual([]);

    const c = capture();
    const program = buildProgram(c.io, { databaseUrl, audit, actor: "tester", redisUrl: null });
    const code = await runCli(
      [
        "--json",
        "transfer",
        "--from",
        src.slug,
        "--to",
        dst.slug,
        "--instance",
        `${TYPE}:${instanceId}`,
        "--user-map",
        mapFile,
      ],
      c.io,
      program,
    );
    expect(code, c.err.join("\n")).toBe(0);
    const result = JSON.parse(c.out.at(-1) as string) as TransferResult;
    expect(result).toMatchObject({
      from_tenant: src.slug,
      to_tenant: dst.slug,
      instances: 1,
      files: 2,
      folders: 1,
      merged_folders: 0,
      dry_run: false,
    });
    expect(
      (await handle.db.select().from(schema.files).where(eq(schema.files.id, a.id)))[0],
    ).toMatchObject({
      tenantId: dst.id,
      createdBy: "u-1",
      folderId: folder?.id,
    });
    expect(
      (await handle.db.select().from(schema.files).where(eq(schema.files.id, b.id)))[0],
    ).toMatchObject({
      tenantId: dst.id,
      createdBy: "bob",
      deletedBy: "u-1",
    });
    expect(
      (
        await handle.db
          .select()
          .from(schema.folders)
          .where(eq(schema.folders.id, folder?.id as string))
      )[0],
    ).toMatchObject({
      tenantId: dst.id,
      createdBy: "u-1",
    });
    expect(
      (await handle.db.select().from(schema.files).where(eq(schema.files.id, stays.id)))[0]
        ?.tenantId,
    ).toBe(src.id);
    // The audit trail names the CLI as the actor; the command waited for the event.
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      event_type: "VOLA_INSTANCES_TRANSFERRED",
      instance_type: "vola_tenant",
      instance_id: dst.slug,
      actor_type: "cli",
      actor_id: "cli:tester",
      payload: { from_tenant: src.slug, to_tenant: dst.slug, files: 2, user_map_entries: 1 },
    });
    expect(JSON.stringify(audited)).not.toContain("a.txt");
  });

  it("transferLines prints every count", () => {
    const lines = transferLines({
      from_tenant: "a",
      to_tenant: "b",
      instances: 2,
      files: 10,
      folders: 3,
      merged_folders: 1,
      shares: 4,
      jobs: 5,
      metadata: 6,
      uploads: 0,
      dry_run: false,
    });
    expect(lines[0]).toBe("moved 2 instance(s) from tenant a to b");
    expect(lines.join("\n")).toMatch(/folders\s+3 \(1 merged/);
    expect(lines.join("\n")).toMatch(/metadata\s+6/);
  });
});

describe("vola create-key / revoke-key audit", () => {
  it("records VOLA_KEY_CREATED and VOLA_KEY_REVOKED as the CLI actor, never the plaintext", async () => {
    const c = capture();
    const program = buildProgram(c.io, { databaseUrl, audit, actor: "tester", redisUrl: null });
    expect(
      await runCli(
        ["--json", "create-key", "--tenant", src.slug, "--name", "ci", "--env", "test"],
        c.io,
        program,
      ),
    ).toBe(0);
    const created = JSON.parse(c.out.at(-1) as string) as {
      id: string;
      key: string;
      last4: string;
    };
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      event_type: "VOLA_KEY_CREATED",
      instance_id: created.id,
      actor_type: "cli",
      actor_id: "cli:tester",
      payload: {
        key_id: created.id,
        name: "ci",
        prefix: "vola_test",
        last4: created.last4,
        tenant: src.slug,
      },
    });
    expect(JSON.stringify(audited)).not.toContain(created.key);

    audited.length = 0;
    const revoked = await vola("revoke-key", created.id);
    expect(revoked.code, revoked.err).toBe(0);
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      event_type: "VOLA_KEY_REVOKED",
      instance_id: created.id,
      actor_id: "cli:tester",
      payload: { key_id: created.id, tenant: src.slug },
    });
    expect(audited[0]?.payload.revoked_at).toEqual(expect.any(String));

    audited.length = 0;
    const admin = await vola("create-admin-key", "--name", "ops");
    expect(admin.code).toBe(0);
    expect(audited[0]).toMatchObject({
      event_type: "VOLA_KEY_CREATED",
      payload: { is_admin: true, tenant: null },
    });
  });
});

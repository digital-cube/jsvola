import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateRecorder, compileLookups, LookupRegistry } from "@vol-a/lookups";
import { DEFAULT_LOOKUPS_PATH } from "@vol-a/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProgram, runCli } from "../src/index.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

/** Runs the CLI with `VOLA_LOOKUPS_PATH` pointing at `path` (no database involved). */
async function vola(path: string, ...argv: string[]) {
  const c = capture();
  const program = buildProgram(c.io, { env: { VOLA_LOOKUPS_PATH: path } });
  const code = await runCli(argv, c.io, program);
  return { code, out: c.out.join("\n"), err: c.err.join("\n"), lines: c.out };
}

const YAML = "FileKinds:\n  - IMAGE\n  - OTHER\nShareScopes: [TENANT]\n";
const CSV =
  "section,term,en,sr\nFileKinds,IMAGE,Image,Slika\nFileKinds,OTHER,Other,Ostalo\nShareScopes,TENANT,Tenant,Tenant\n";

describe("vola lookups / lookup-promote (files only)", () => {
  let dir: string;
  let path: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vola-cli-lookups-"));
    path = join(dir, "lookups.yaml");
    await mkdir(join(dir, "i18n"));
    await writeFile(path, YAML);
    await writeFile(join(dir, "i18n", "translations.csv"), CSV);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("validates the repository vocabulary and a custom one", async () => {
    const repo = await vola(DEFAULT_LOOKUPS_PATH, "lookups", "validate");
    expect(repo.code, repo.err).toBe(0);
    expect(repo.out).toContain("FileKinds (10)");
    expect(repo.out).toContain("EncryptionModes (5)");
    expect(repo.out).toMatch(/ok: en, sr — 0 warning\(s\)/);

    const custom = await vola(path, "lookups", "validate");
    expect(custom.code).toBe(0);
    expect(custom.out).toContain(`${path}: FileKinds (2), ShareScopes (1)`);

    const c = capture();
    const json = await runCli(
      ["--json", "lookups", "validate", "--path", path],
      c.io,
      buildProgram(c.io),
    );
    expect(json).toBe(0);
    expect(JSON.parse(c.out.at(-1) as string)).toMatchObject({ ok: true, locales: ["en", "sr"] });
  });

  it("fails validation on a bad sheet or a bad YAML", async () => {
    const bad = join(dir, "bad.csv");
    await writeFile(bad, "section,term,en\nFileKinds,NOPE,x\n");
    const sheet = await vola(path, "lookups", "validate", "--translations", bad);
    expect(sheet.code).toBe(1);
    expect(sheet.out).toContain(`error   ${bad}:2 [term]: unknown term "NOPE" in FileKinds`);
    expect(sheet.err).toContain("validation_error: translations are invalid");

    const broken = join(dir, "broken.yaml");
    await writeFile(broken, "X: [lower]\n");
    const yaml = await vola(broken, "lookups", "validate");
    expect(yaml.code).toBe(1);
    expect(yaml.err).toMatch(/UPPER_SNAKE_CASE/);
  });

  it("lists candidates, promotes them with a dry run first, then for real", async () => {
    const empty = await vola(path, "lookups", "candidates");
    expect(empty.code).toBe(0);
    expect(empty.out).toMatch(/^no candidates in /);

    const recorder = new CandidateRecorder({
      dir: join(dir, "var", "candidates"),
      registry: new LookupRegistry(compileLookups(YAML)),
      now: () => new Date(Date.UTC(2026, 10, 1, 12, 0, 0)),
    });
    await recorder.record("FileKinds", "webp");
    await recorder.record("FileKinds", "webp");
    await recorder.record("ShareScopes", "EMAIL");

    const listed = await vola(path, "lookups", "candidates");
    expect(listed.lines).toEqual([
      "FileKinds.WEBP\t2\t2026-11-01T12:00:00Z\t2026-11-01T12:00:00Z",
      "ShareScopes.EMAIL\t1\t2026-11-01T12:00:00Z\t2026-11-01T12:00:00Z",
    ]);

    const dry = await vola(path, "lookup-promote", "--dry-run");
    expect(dry.code, dry.err).toBe(0);
    expect(dry.lines).toEqual([
      "would promote FileKinds.WEBP (seen 2×; en: WEBP, sr: WEBP)",
      "would promote ShareScopes.EMAIL (seen 1×; en: EMAIL, sr: EMAIL)",
      `${path} and ${join(dir, "i18n", "translations.csv")}`,
    ]);
    expect(await readFile(path, "utf8")).toBe(YAML);

    const only = await vola(path, "lookup-promote", "--only", "ShareScopes.EMAIL");
    expect(only.code, only.err).toBe(0);
    expect(only.lines[0]).toBe("promoted ShareScopes.EMAIL (seen 1×; en: EMAIL, sr: EMAIL)");
    expect(await readFile(path, "utf8")).toBe(
      "FileKinds:\n  - IMAGE\n  - OTHER\nShareScopes: [ TENANT, EMAIL ]\n",
    );

    const rest = await vola(path, "--json", "lookup-promote");
    expect(rest.code).toBe(0);
    expect(JSON.parse(rest.lines.at(-1) as string)).toMatchObject({
      dryRun: false,
      promoted: [{ section: "FileKinds", term: "WEBP", count: 2 }],
      skipped: [],
    });
    expect(await readFile(join(dir, "i18n", "translations.csv"), "utf8")).toBe(
      `${CSV}ShareScopes,EMAIL,EMAIL,EMAIL\nFileKinds,WEBP,WEBP,WEBP\n`,
    );
    const again = await vola(path, "lookup-promote");
    expect(again.out).toMatch(/^nothing to promote in /);
    expect((await vola(path, "lookups", "validate")).code).toBe(0);
  });
});

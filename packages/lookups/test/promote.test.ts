import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANDIDATES_CSV,
  CandidateRecorder,
  compileLookups,
  LookupCompileError,
  LookupRegistry,
  loadLookups,
  promoteCandidates,
} from "../src/index.js";

const YAML = `# The vocabulary.
FileKinds:
  # images first
  - IMAGE
  - OTHER
ShareScopes: [TENANT]
Nested:
  Inner:
    - ONE
`;
const CSV = [
  "section,term,en,sr",
  "FileKinds,IMAGE,Image,Slika",
  "FileKinds,OTHER,Other,Ostalo",
  "ShareScopes,TENANT,Tenant,Tenant",
  "Nested.Inner,ONE,One,Jedan",
  "",
].join("\n");

describe("promoteCandidates", () => {
  let dir: string;
  let path: string;
  let translations: string;
  let candidates: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vola-promote-"));
    path = join(dir, "lookups.yaml");
    translations = join(dir, "i18n", "translations.csv");
    candidates = join(dir, "var", "candidates");
    await mkdir(join(dir, "i18n"));
    await writeFile(path, YAML);
    await writeFile(translations, CSV);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function record(entries: [string, string][]) {
    const recorder = new CandidateRecorder({
      dir: candidates,
      registry: new LookupRegistry(compileLookups(YAML)),
    });
    for (const [section, value] of entries) await recorder.record(section, value);
    return recorder;
  }

  it("appends terms and rows, keeps comments, empties the queue", async () => {
    await record([
      ["FileKinds", "webp"],
      ["FileKinds", "webp"],
      ["ShareScopes", "EMAIL"],
      ["Nested.Inner", "TWO"],
    ]);
    // A translator filled in the Serbian label of WEBP only.
    const csv = await readFile(join(candidates, CANDIDATES_CSV), "utf8");
    await writeFile(
      join(candidates, CANDIDATES_CSV),
      csv.replace("FileKinds,WEBP,WEBP,WEBP", "FileKinds,WEBP,,WebP slika"),
    );

    const dry = await promoteCandidates({ path, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.promoted.map((p) => `${p.section}.${p.term}`)).toEqual([
      "FileKinds.WEBP",
      "Nested.Inner.TWO",
      "ShareScopes.EMAIL",
    ]);
    expect(await readFile(path, "utf8")).toBe(YAML);
    expect(await readdir(candidates)).toHaveLength(4);

    const result = await promoteCandidates({ path });
    expect(result.promoted).toEqual([
      { section: "FileKinds", term: "WEBP", labels: { en: "WEBP", sr: "WebP slika" }, count: 2 },
      { section: "Nested.Inner", term: "TWO", labels: { en: "TWO", sr: "TWO" }, count: 1 },
      { section: "ShareScopes", term: "EMAIL", labels: { en: "EMAIL", sr: "EMAIL" }, count: 1 },
    ]);
    expect(result.skipped).toEqual([]);
    const yaml = await readFile(path, "utf8");
    expect(yaml).toContain("# The vocabulary.");
    expect(yaml).toContain("  # images first\n  - IMAGE\n  - OTHER\n  - WEBP\n");
    expect(yaml).toContain("ShareScopes: [ TENANT, EMAIL ]");
    expect(yaml).toContain("    - ONE\n    - TWO\n");
    expect(await readFile(translations, "utf8")).toBe(
      `${CSV}FileKinds,WEBP,WEBP,WebP slika\nNested.Inner,TWO,TWO,TWO\nShareScopes,EMAIL,EMAIL,EMAIL\n`,
    );
    expect(await readdir(candidates)).toEqual([]);
    const loaded = await loadLookups({ path, translationsPath: translations });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.registry.label("FileKinds", "webp", ["sr"])).toBe("WebP slika");

    expect(await promoteCandidates({ path })).toMatchObject({ promoted: [], skipped: [] });
  });

  it("promotes only the named candidates and leaves the rest queued", async () => {
    await record([
      ["FileKinds", "WEBP"],
      ["FileKinds", "HEIC"],
    ]);
    const result = await promoteCandidates({ path, only: ["FileKinds.HEIC"] });
    expect(result.promoted.map((p) => p.term)).toEqual(["HEIC"]);
    expect(await readFile(join(candidates, "FileKinds.yaml"), "utf8")).toMatch(/value: WEBP/);
    expect(await readFile(join(candidates, "FileKinds.yaml"), "utf8")).not.toMatch(/HEIC/);
    expect(await readFile(join(candidates, CANDIDATES_CSV), "utf8")).toBe(
      "section,term,en,sr\nFileKinds,WEBP,WEBP,WEBP\n",
    );
  });

  it("skips an unknown section, drops a term already promoted by hand", async () => {
    await record([["FileKinds", "WEBP"]]);
    await writeFile(
      join(candidates, "Colours.yaml"),
      "- value: RED\n  count: 1\n  first_seen: x\n  last_seen: x\n",
    );
    // Somebody added WEBP to the YAML and the sheet already.
    await writeFile(path, YAML.replace("  - OTHER\n", "  - OTHER\n  - WEBP\n"));
    await writeFile(translations, `${CSV}FileKinds,WEBP,WebP,WebP\n`);
    const result = await promoteCandidates({ path });
    expect(result.promoted).toEqual([]);
    expect(result.skipped).toEqual([
      { section: "Colours", term: "RED", reason: "section not in lookups.yaml" },
      { section: "FileKinds", term: "WEBP", reason: "already in lookups.yaml" },
    ]);
    expect((await readdir(candidates)).sort()).toEqual(["Colours.yaml"]);
  });

  it("creates the translations sheet when there is none and handles an empty queue", async () => {
    await rm(translations);
    expect(await promoteCandidates({ path })).toMatchObject({ promoted: [], skipped: [] });
    await record([["ShareScopes", "EMAIL"]]);
    await promoteCandidates({ path, locales: ["en"] });
    expect(await readFile(translations, "utf8")).toBe("section,term,en\nShareScopes,EMAIL,EMAIL\n");
  });

  it("refuses a sheet whose header is broken, writing nothing", async () => {
    await record([["ShareScopes", "EMAIL"]]);
    await writeFile(translations, "name,value,en\n");
    await expect(promoteCandidates({ path })).rejects.toThrow(LookupCompileError);
    expect(await readFile(path, "utf8")).toBe(YAML);
    expect(await readdir(candidates)).toHaveLength(2);
  });
});

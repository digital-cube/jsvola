import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANDIDATES_CSV,
  CandidateRecorder,
  compileLookups,
  constantName,
  detectDelimiter,
  formatCsvRow,
  generateLookupsModule,
  LookupCompileError,
  LookupRegistry,
  loadLookups,
  normalizeTerm,
  parseCsv,
  typeName,
  validateTranslationsCsv,
} from "../src/index.js";

const YAML = `
EventTypes: [USER_LOGIN, TICKET_CREATED]
InstanceTypes:
  - USER
  - TICKET
Statuses:
  Ticket: [OPEN, CLOSED]
`;

const registry = () => new LookupRegistry(compileLookups(YAML));

describe("compileLookups", () => {
  it("compiles flat and nested sections", () => {
    const tree = compileLookups(YAML);
    expect(tree).toEqual({
      EventTypes: ["USER_LOGIN", "TICKET_CREATED"],
      InstanceTypes: ["USER", "TICKET"],
      Statuses: { Ticket: ["OPEN", "CLOSED"] },
    });
    expect(registry().sectionNames()).toEqual(["EventTypes", "InstanceTypes", "Statuses.Ticket"]);
  });

  it("returns an empty tree for an empty file", () => {
    expect(compileLookups("")).toEqual({});
    expect(compileLookups("# only a comment\n")).toEqual({});
  });

  it.each([
    ["- a\n- b\n", /top level must be a mapping/],
    ["X: [lower_case]", /must be UPPER_SNAKE_CASE/],
    ["X: [A, A]", /duplicate term "A"/],
    ["X: [1]", /term must be a string/],
    ["X: 3", /expected a list or a mapping/],
    ["bad-name: [A]", /invalid namespace "bad-name"/],
    ["X:\n  bad-key: [A]", /invalid namespace key "bad-key"/],
    ["X: [A\n", /YAML parse error/],
  ])("rejects %j", (text, message) => {
    expect(() => compileLookups(text, "t.yaml")).toThrow(LookupCompileError);
    expect(() => compileLookups(text, "t.yaml")).toThrow(message);
  });
});

describe("normalizeTerm", () => {
  it.each([
    ["user", "USER"],
    ["  ticket-closed ", "TICKET_CLOSED"],
    ["São Tomé Creole", "SAO_TOME_CREOLE"],
    ["O'Brien", "OBRIEN"],
    ["Đorđe čita", "DJORDJE_CITA"],
    ["Straße Æble", "STRASSE_AEBLE"],
    ["!!!", ""],
  ])("%j → %j", (input, expected) => {
    expect(normalizeTerm(input)).toBe(expected);
  });
});

describe("LookupRegistry", () => {
  it("checks membership after normalizing", () => {
    const r = registry();
    expect(r.has("InstanceTypes", "user")).toBe(true);
    expect(r.has("EventTypes", "USER_LOGIN")).toBe(true);
    expect(r.has("EventTypes", "NOPE")).toBe(false);
    expect(r.has("Nope", "USER")).toBe(false);
    expect(r.terms("Nope")).toEqual([]);
    expect(r.hasSection("Statuses.Ticket")).toBe(true);
  });

  it("resolves labels through the locale list and base language", () => {
    const r = registry().withTranslations(
      new Map([["EventTypes.USER_LOGIN", { en: "User login", sr: "Prijava" }]]),
    );
    expect(r.label("EventTypes", "USER_LOGIN", ["sr-Latn", "en"])).toBe("Prijava");
    expect(r.label("EventTypes", "USER_LOGIN", ["de", "en"])).toBe("User login");
    expect(r.label("EventTypes", "USER_LOGIN", ["de"])).toBeUndefined();
    expect(r.label("EventTypes", "TICKET_CREATED", ["en"])).toBeUndefined();
  });
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded newlines, CRLF, BOM and blank lines", () => {
    const text = '\uFEFFa,b,c\r\n"x, y","say ""hi""","multi\nline"\r\n\r\nlast,,\n';
    expect(parseCsv(text)).toEqual([
      { line: 1, cells: ["a", "b", "c"] },
      { line: 2, cells: ["x, y", 'say "hi"', "multi\nline"] },
      { line: 5, cells: ["last", "", ""] },
    ]);
  });

  it("parses a final record without a newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["1", "2"] },
    ]);
  });

  it("detects semicolon and tab delimiters from the header", () => {
    expect(detectDelimiter("section;term;en;sr\n")).toBe(";");
    expect(detectDelimiter("section\tterm\ten\n")).toBe("\t");
    expect(detectDelimiter("single\n")).toBe(",");
    expect(parseCsv("a;b\n1;2,5\n")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["1", "2,5"] },
    ]);
  });

  it("formats rows that round-trip", () => {
    const row = formatCsvRow(["plain", "a,b", 'q"uote', " pad", "line\nbreak"]);
    expect(row).toBe('plain,"a,b","q""uote"," pad","line\nbreak"');
    expect(parseCsv(row)[0]?.cells).toEqual(["plain", "a,b", 'q"uote', " pad", "line\nbreak"]);
  });
});

describe("validateTranslationsCsv", () => {
  it("accepts a complete sheet and builds translations", () => {
    const csv = [
      "section,term,en,sr",
      "EventTypes,USER_LOGIN,User login,Prijava",
      "EventTypes,TICKET_CREATED,Ticket created,Kreiran tiket",
      "InstanceTypes,USER,User,Korisnik",
      "InstanceTypes,TICKET,Ticket,Tiket",
      "Statuses.Ticket,OPEN,Open,Otvoren",
      "Statuses.Ticket,CLOSED,Closed,Zatvoren",
    ].join("\n");
    const result = validateTranslationsCsv(csv, registry());
    expect(result).toMatchObject({ ok: true, locales: ["en", "sr"], errors: [], warnings: [] });
    expect(result.translations.get("InstanceTypes.USER")).toEqual({ en: "User", sr: "Korisnik" });
  });

  it("accepts an Excel export: BOM, semicolons, CRLF, short rows", () => {
    const csv = "\uFEFFSection;Term;en;sr\r\nEventTypes;USER_LOGIN;User login\r\n";
    const result = validateTranslationsCsv(csv, registry());
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toEqual({
      line: 2,
      column: "sr",
      message: "EventTypes.USER_LOGIN has no sr translation",
    });
    expect(result.warnings).toContainEqual({
      line: 0,
      message: "InstanceTypes.TICKET has no translation row",
    });
  });

  it("reports row errors with line numbers", () => {
    const csv = [
      "section,term,en",
      "Nope,USER,x",
      "EventTypes,NOPE,x",
      "EventTypes,USER_LOGIN,a",
      "EventTypes,USER_LOGIN,b",
      "EventTypes,TICKET_CREATED,a,extra",
    ].join("\n");
    const result = validateTranslationsCsv(csv, registry());
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { line: 2, column: "section", message: 'unknown section "Nope"' },
      { line: 3, column: "term", message: 'unknown term "NOPE" in EventTypes' },
      { line: 5, message: "duplicate row for EventTypes.USER_LOGIN (first on line 4)" },
      { line: 6, message: "4 cells, header has 3" },
    ]);
  });

  it.each([
    ["", /empty file/],
    ["name,value\n", /must start with "section,term"/],
    ["section,term\n", /no locale columns/],
    ["section,term,EN\n", /invalid locale "EN"/],
    ["section,term,en,en\n", /duplicate locale "en"/],
  ])("rejects header %j", (csv, message) => {
    const result = validateTranslationsCsv(csv, registry());
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toMatch(message);
  });
});

describe("codegen", () => {
  it("names constants and types", () => {
    expect(constantName("EventTypes")).toBe("EVENT_TYPES");
    expect(constantName("Statuses.Ticket")).toBe("STATUSES_TICKET");
    expect(typeName("EventTypes")).toBe("EventType");
    expect(typeName("Categories")).toBe("Category");
    expect(typeName("Statuses")).toBe("Status");
    expect(typeName("Boxes")).toBe("Box");
    expect(typeName("Class")).toBe("Class");
    expect(typeName("Statuses.Ticket")).toBe("StatusesTicket");
  });

  it("generates tuples, enums and z.enum schemas", () => {
    const code = generateLookupsModule(registry(), { lowercase: ["InstanceTypes"] });
    expect(code).toContain('export const EVENT_TYPES = ["USER_LOGIN", "TICKET_CREATED"] as const;');
    expect(code).toContain('export const INSTANCE_TYPES = ["user", "ticket"] as const;');
    expect(code).toContain('  USER = "user",');
    expect(code).toContain("export enum StatusesTicket {");
    expect(code).toContain("export const KnownEventTypeSchema = z.enum(EVENT_TYPES);");
    expect(code.startsWith("// Generated from lookups.yaml")).toBe(true);
  });
});

describe("loadLookups and CandidateRecorder (filesystem)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vola-lookups-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("loads YAML with an optional translations sheet", async () => {
    await writeFile(join(dir, "lookups.yaml"), YAML);
    const path = join(dir, "lookups.yaml");
    const missing = await loadLookups({ path, translationsPath: join(dir, "none.csv") });
    expect(missing.registry.terms("EventTypes")).toEqual(["USER_LOGIN", "TICKET_CREATED"]);
    expect((await loadLookups({ path })).warnings).toEqual([]);

    await writeFile(join(dir, "t.csv"), "section,term,en\nEventTypes,USER_LOGIN,User login\n");
    const loaded = await loadLookups({ path, translationsPath: join(dir, "t.csv") });
    expect(loaded.registry.label("EventTypes", "USER_LOGIN", ["en"])).toBe("User login");
    expect(loaded.warnings.length).toBeGreaterThan(0);

    await writeFile(join(dir, "bad.csv"), "section,term,en\nEventTypes,NOPE,x\n");
    await expect(loadLookups({ path, translationsPath: join(dir, "bad.csv") })).rejects.toThrow(
      /bad\.csv: line 2: unknown term "NOPE"/,
    );
    await expect(loadLookups({ path: join(dir, "missing.yaml") })).rejects.toThrow(/ENOENT/);
    await expect(loadLookups({ path, translationsPath: dir })).rejects.toThrow(/EISDIR/);
  });

  it("records unknown values once per term, counting repeats", async () => {
    let tick = 0;
    const recorder = new CandidateRecorder({
      dir: join(dir, "candidates"),
      registry: registry(),
      now: () => new Date(Date.UTC(2026, 9, 30, 10, 0, tick++)),
    });
    expect(await recorder.record("EventTypes", "USER_LOGIN")).toBeNull();
    expect(await recorder.record("InstanceTypes", "user")).toBeNull();
    expect(await recorder.record("EventTypes", "")).toBeNull();
    expect(await recorder.record("EventTypes", null)).toBeNull();
    const results = await Promise.all([
      recorder.record("EventTypes", "INVOICE_PAID"),
      recorder.record("EventTypes", "invoice paid"),
      recorder.record("EventTypes", "ALPHA"),
    ]);
    expect(results).toEqual(["INVOICE_PAID", "INVOICE_PAID", "ALPHA"]);
    await recorder.record("InstanceTypes", "invoice");

    expect(await recorder.list("EventTypes")).toEqual([
      {
        value: "ALPHA",
        count: 1,
        first_seen: "2026-10-30T10:00:02Z",
        last_seen: "2026-10-30T10:00:02Z",
      },
      {
        value: "INVOICE_PAID",
        count: 2,
        first_seen: "2026-10-30T10:00:00Z",
        last_seen: "2026-10-30T10:00:01Z",
      },
    ]);
    expect(await recorder.list("ActorTypes")).toEqual([]);
    const csv = await readFile(join(dir, "candidates", CANDIDATES_CSV), "utf8");
    expect(csv).toBe(
      [
        "section,term,en,sr",
        "EventTypes,INVOICE_PAID,INVOICE_PAID,INVOICE_PAID",
        "EventTypes,ALPHA,ALPHA,ALPHA",
        "InstanceTypes,INVOICE,INVOICE,INVOICE",
        "",
      ].join("\n"),
    );
  });

  it("does not duplicate a CSV row already present and survives a garbage YAML file", async () => {
    const candidates = join(dir, "candidates");
    const recorder = new CandidateRecorder({
      dir: candidates,
      registry: registry(),
      locales: ["en"],
    });
    await recorder.record("EventTypes", "X_ONE");
    await writeFile(join(candidates, "EventTypes.yaml"), "just a string\n");
    await recorder.record("EventTypes", "X_ONE");
    expect(await recorder.list("EventTypes")).toMatchObject([{ value: "X_ONE", count: 1 }]);
    const csv = await readFile(join(candidates, CANDIDATES_CSV), "utf8");
    expect(csv).toBe("section,term,en\nEventTypes,X_ONE,X_ONE\n");
  });

  it("reports IO failures to onError instead of throwing", async () => {
    const blocker = join(dir, "file");
    await writeFile(blocker, "not a directory");
    const errors: unknown[] = [];
    const recorder = new CandidateRecorder({
      dir: join(blocker, "candidates"),
      registry: registry(),
      onError: (error) => errors.push(error),
    });
    expect(await recorder.record("EventTypes", "NEW_ONE")).toBeNull();
    expect(await recorder.record("EventTypes", "NEW_TWO")).toBeNull();
    expect(errors).toHaveLength(2);
    await expect(recorder.list("EventTypes")).rejects.toThrow(/ENOTDIR/);
    const silent = new CandidateRecorder({ dir: join(blocker, "x"), registry: registry() });
    expect(await silent.record("EventTypes", "NEW_ONE")).toBeNull();
  });

  it("rethrows a CSV read failure other than a missing file", async () => {
    const candidates = join(dir, "candidates");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(candidates, CANDIDATES_CSV), { recursive: true });
    const errors: unknown[] = [];
    const recorder = new CandidateRecorder({
      dir: candidates,
      registry: registry(),
      onError: (error) => errors.push(error),
    });
    expect(await recorder.record("EventTypes", "NEW_ONE")).toBeNull();
    expect(String(errors[0])).toMatch(/EISDIR/);
  });
});

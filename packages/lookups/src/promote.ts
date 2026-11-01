import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSeq, parseDocument, stringify } from "yaml";
import { CANDIDATES_CSV, type Candidate } from "./candidates.js";
import { compileLookups, LookupCompileError } from "./compile.js";
import { formatCsvRow, parseCsv, validateTranslationsCsv } from "./csv.js";
import { LookupRegistry } from "./registry.js";

export interface PromoteOptions {
  /** `lookups.yaml`. */
  path: string;
  /** Default `<dir of path>/i18n/translations.csv`; created when missing. */
  translationsPath?: string | undefined;
  /** Default `<dir of path>/var/candidates`. */
  candidatesDir?: string | undefined;
  /** Only these candidates, as `Section.TERM`; default: every recorded one. */
  only?: readonly string[] | undefined;
  /** Compute the result and change nothing. */
  dryRun?: boolean | undefined;
  /** Locale columns of a translations sheet created from scratch. Default `["en", "sr"]`. */
  locales?: readonly string[] | undefined;
}

export interface PromotedTerm {
  section: string;
  term: string;
  /** The labels written to the sheet, per locale (the term itself where nobody filled one in). */
  labels: Record<string, string>;
  count: number;
}

export interface SkippedCandidate {
  section: string;
  term: string;
  reason: string;
}

export interface PromoteResult {
  lookupsPath: string;
  translationsPath: string;
  candidatesDir: string;
  dryRun: boolean;
  /** Terms added to `lookups.yaml` and the sheet (and removed from the queue). */
  promoted: PromotedTerm[];
  /** Candidates left alone, and why (a term already in the vocabulary is dropped from the queue). */
  skipped: SkippedCandidate[];
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

/** `var/candidates/<Section>.yaml` files → section name → its candidates. */
async function readQueue(dir: string): Promise<Map<string, Candidate[]>> {
  const queue = new Map<string, Candidate[]>();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return queue;
    throw error;
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    const section = entry.slice(0, -".yaml".length);
    const data: unknown = parseDocument(await readFile(join(dir, entry), "utf8")).toJS();
    if (!Array.isArray(data)) continue;
    const candidates = data.filter(
      (c): c is Candidate => typeof c === "object" && c !== null && typeof c.value === "string",
    );
    queue.set(section, candidates);
  }
  return queue;
}

/** The labels a translator filled into `translations_candidate.csv`, keyed `Section.TERM`. */
function candidateLabels(text: string | null): Map<string, Record<string, string>> {
  const labels = new Map<string, Record<string, string>>();
  if (!text) return labels;
  const [header, ...rows] = parseCsv(text);
  if (!header) return labels;
  const locales = header.cells.slice(2).map((c) => c.trim());
  for (const { cells } of rows) {
    const key = `${(cells[0] ?? "").trim()}.${(cells[1] ?? "").trim()}`;
    const row: Record<string, string> = {};
    locales.forEach((locale, i) => {
      const value = (cells[i + 2] ?? "").trim();
      if (value) row[locale] = value;
    });
    labels.set(key, row);
  }
  return labels;
}

/** The candidate CSV without the rows of `remove` (`Section.TERM`); `null` when only the header is left. */
function withoutRows(text: string | null, remove: Set<string>): string | null {
  if (!text) return null;
  const [header, ...rows] = parseCsv(text);
  if (!header) return null;
  const kept = rows.filter(({ cells }) => !remove.has(`${cells[0] ?? ""}.${cells[1] ?? ""}`));
  if (kept.length === 0) return null;
  return `${[header, ...kept].map(({ cells }) => formatCsvRow(cells)).join("\n")}\n`;
}

/**
 * Moves recorded candidates into the vocabulary: each term is appended to its section of
 * `lookups.yaml` (comments and layout kept), a row with its labels — the translator's from
 * `translations_candidate.csv`, the term itself otherwise — is appended to the translations
 * sheet, and the candidate leaves the queue. A candidate whose section the vocabulary does
 * not have is skipped and stays; one whose term is already in the vocabulary is dropped from
 * the queue. The new sheet is validated against the new vocabulary before anything is
 * written; `dryRun` only reports.
 */
export async function promoteCandidates(options: PromoteOptions): Promise<PromoteResult> {
  const root = dirname(options.path);
  const translationsPath = options.translationsPath ?? join(root, "i18n", "translations.csv");
  const candidatesDir = options.candidatesDir ?? join(root, "var", "candidates");
  const only = options.only ? new Set(options.only) : null;
  const result: PromoteResult = {
    lookupsPath: options.path,
    translationsPath,
    candidatesDir,
    dryRun: options.dryRun ?? false,
    promoted: [],
    skipped: [],
  };

  const yamlText = await readFile(options.path, "utf8");
  const registry = new LookupRegistry(compileLookups(yamlText, options.path));
  const doc = parseDocument(yamlText);
  const queue = await readQueue(candidatesDir);
  const candidateCsvPath = join(candidatesDir, CANDIDATES_CSV);
  const candidateCsv = await readOptional(candidateCsvPath);
  const labels = candidateLabels(candidateCsv);

  const sheetText = await readOptional(translationsPath);
  const header = sheetText
    ? (parseCsv(sheetText)[0]?.cells.map((c) => c.trim()) ?? [])
    : ["section", "term", ...(options.locales ?? ["en", "sr"])];
  if (header[0]?.toLowerCase() !== "section" || header[1]?.toLowerCase() !== "term") {
    throw new LookupCompileError(`${translationsPath}: header must start with "section,term"`);
  }
  const locales = header.slice(2);

  const newRows: string[] = [];
  const dequeue = new Map<string, Set<string>>(); // section → terms to drop from the queue
  const drop = (section: string, term: string) => {
    const set = dequeue.get(section) ?? new Set<string>();
    set.add(term);
    dequeue.set(section, set);
  };

  for (const [section, candidates] of queue) {
    for (const candidate of candidates) {
      const term = candidate.value;
      const key = `${section}.${term}`;
      if (only && !only.has(key)) continue;
      if (!registry.hasSection(section)) {
        result.skipped.push({ section, term, reason: "section not in lookups.yaml" });
        continue;
      }
      if (registry.terms(section).includes(term)) {
        result.skipped.push({ section, term, reason: "already in lookups.yaml" });
        drop(section, term);
        continue;
      }
      const seq = doc.getIn(section.split("."));
      if (!isSeq(seq)) {
        result.skipped.push({ section, term, reason: "section is not a list" });
        continue;
      }
      seq.add(term);
      const given = labels.get(key) ?? {};
      const row: Record<string, string> = {};
      for (const locale of locales) row[locale] = given[locale] ?? term;
      newRows.push(formatCsvRow([section, term, ...locales.map((l) => row[l] as string)]));
      result.promoted.push({ section, term, labels: row, count: candidate.count ?? 1 });
      drop(section, term);
    }
  }
  if (result.promoted.length === 0 && dequeue.size === 0) return result;

  const newYaml = doc.toString();
  const newRegistry = new LookupRegistry(compileLookups(newYaml, options.path));
  const base = sheetText ?? `${formatCsvRow(header)}\n`;
  const newSheet =
    newRows.length === 0
      ? base
      : `${base.endsWith("\n") || base === "" ? base : `${base}\n`}${newRows.join("\n")}\n`;
  const check = validateTranslationsCsv(newSheet, newRegistry);
  if (!check.ok) {
    const first = check.errors
      .slice(0, 5)
      .map((issue) => `line ${issue.line}: ${issue.message}`)
      .join("; ");
    throw new LookupCompileError(`${translationsPath} after promotion: ${first}`);
  }
  if (result.dryRun) return result;

  if (result.promoted.length > 0) {
    await writeAtomic(options.path, newYaml);
    await writeAtomic(translationsPath, newSheet);
  }
  const removed = new Set<string>();
  for (const [section, terms] of dequeue) {
    for (const term of terms) removed.add(`${section}.${term}`);
    const left = (queue.get(section) ?? []).filter((c) => !terms.has(c.value));
    const file = join(candidatesDir, `${section}.yaml`);
    if (left.length === 0) await unlink(file).catch(() => {});
    else await writeAtomic(file, stringify(left));
  }
  const leftCsv = withoutRows(candidateCsv, removed);
  if (candidateCsv !== null) {
    if (leftCsv === null) await unlink(candidateCsvPath).catch(() => {});
    else await writeAtomic(candidateCsvPath, leftCsv);
  }
  return result;
}

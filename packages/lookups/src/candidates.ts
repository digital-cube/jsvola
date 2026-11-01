import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { formatCsvRow, parseCsv } from "./csv.js";
import { normalizeTerm } from "./normalize.js";
import type { LookupRegistry } from "./registry.js";

/** One unknown value seen at ingestion, waiting to be promoted into `lookups.yaml`. */
export interface Candidate {
  value: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

export const CANDIDATES_CSV = "translations_candidate.csv";

export interface CandidateRecorderOptions {
  /** Where `<Section>.yaml` files and `translations_candidate.csv` are written. */
  dir: string;
  /** Known terms are never recorded. */
  registry: LookupRegistry;
  /** Locale columns pre-filled in the candidate CSV. Default `["en", "sr"]`. */
  locales?: readonly string[];
  /** Receives IO/parse failures; recording never throws. */
  onError?: (error: unknown) => void;
  now?: () => Date;
}

/**
 * Records values that are not (yet) in the vocabulary — `var/candidates/EventTypes.yaml`
 * gets `{ value, count, first_seen, last_seen }` per unknown term, and the shared
 * `translations_candidate.csv` gets a row a translator can fill in and paste into
 * `i18n/translations.csv`. Writes are serialized and best-effort: a failure is reported
 * to `onError` and ingestion goes on.
 */
export class CandidateRecorder {
  readonly dir: string;
  private readonly registry: LookupRegistry;
  private readonly locales: readonly string[];
  private readonly onError: (error: unknown) => void;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: CandidateRecorderOptions) {
    this.dir = options.dir;
    this.registry = options.registry;
    this.locales = options.locales ?? ["en", "sr"];
    this.onError = options.onError ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Records `value` under `section` unless it is empty or already a known term. Resolves
   * to the normalized term when it was recorded, `null` otherwise.
   */
  record(section: string, value: string | null | undefined): Promise<string | null> {
    const term = value ? normalizeTerm(value) : "";
    if (!term || this.registry.has(section, term)) return Promise.resolve(null);
    const task = this.queue.then(() => this.write(section, term));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task.then(
      () => term,
      (error: unknown) => {
        this.onError(error);
        return null;
      },
    );
  }

  /** Every recorded candidate of `section`, sorted by value. */
  async list(section: string): Promise<Candidate[]> {
    await this.queue;
    return this.read(section);
  }

  private async read(section: string): Promise<Candidate[]> {
    let text: string;
    try {
      text = await readFile(this.yamlPath(section), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const data: unknown = parse(text);
    return Array.isArray(data) ? (data as Candidate[]) : [];
  }

  private yamlPath(section: string): string {
    return join(this.dir, `${section}.yaml`);
  }

  private async write(section: string, term: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const candidates = await this.read(section);
    const now = this.now()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    const existing = candidates.find((candidate) => candidate.value === term);
    if (existing) {
      existing.count += 1;
      existing.last_seen = now;
    } else {
      candidates.push({ value: term, count: 1, first_seen: now, last_seen: now });
      candidates.sort((a, b) => a.value.localeCompare(b.value));
    }
    const path = this.yamlPath(section);
    await writeFile(`${path}.tmp`, stringify(candidates));
    await rename(`${path}.tmp`, path);
    if (!existing) await this.appendCsv(section, term);
  }

  private async appendCsv(section: string, term: string): Promise<void> {
    const path = join(this.dir, CANDIDATES_CSV);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      text = `${formatCsvRow(["section", "term", ...this.locales])}\n`;
    }
    if (parseCsv(text, ",").some(({ cells }) => cells[0] === section && cells[1] === term)) {
      return;
    }
    const row = formatCsvRow([section, term, ...this.locales.map(() => term)]);
    await writeFile(path, `${text}${row}\n`);
  }
}

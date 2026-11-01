import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOOKUP_LOCALE,
  LOOKUP_SECTIONS,
  type LookupLocale,
  LookupLocaleSchema,
  type LookupsResponse,
  lookupWireValue,
} from "@vola/core";
import { CandidateRecorder, type CsvIssue, LookupRegistry, loadLookups } from "@vola/lookups";

/** `lookups.yaml` at the repository root (same depth from `src/` and `dist/`). */
export const DEFAULT_LOOKUPS_PATH = fileURLToPath(
  new URL("../../../lookups.yaml", import.meta.url),
);

/** The locale columns a candidate row is pre-filled with (the columns of `i18n/translations.csv`). */
export const LOOKUP_LOCALES_RECORDED = ["en", "sr"] as const;

export interface Lookups {
  registry: LookupRegistry;
  /** `null` when candidate recording is off. */
  recorder: CandidateRecorder | null;
  /** The locales the translations sheet has (`[]` without one). */
  locales: readonly string[];
  /** Problems of the translations sheet that did not stop loading. */
  warnings: CsvIssue[];
}

/** No vocabulary: `GET /lookups` answers empty sections, nothing is recorded. */
export function emptyLookups(): Lookups {
  return { registry: new LookupRegistry(), recorder: null, locales: [], warnings: [] };
}

export interface InitLookupsOptions {
  /** `lookups.yaml`. */
  path: string;
  /** Default `<dir of path>/i18n/translations.csv`; a missing file is fine. */
  translationsPath?: string | undefined;
  /** Default `<dir of path>/var/candidates`; `null` disables recording. */
  candidatesDir?: string | null | undefined;
  locales?: readonly string[] | undefined;
  /** Candidate recording failures (best effort, never fail an upload). */
  onError?: ((error: unknown) => void) | undefined;
}

/**
 * Loads `lookups.yaml` and its translations and wires the candidate recorder. Throws
 * `LookupCompileError` on an invalid vocabulary or a translations sheet with errors.
 */
export async function initLookups(options: InitLookupsOptions): Promise<Lookups> {
  const root = dirname(options.path);
  const { registry, locales, warnings } = await loadLookups({
    path: options.path,
    translationsPath: options.translationsPath ?? join(root, "i18n", "translations.csv"),
  });
  const candidatesDir =
    options.candidatesDir === undefined ? join(root, "var", "candidates") : options.candidatesDir;
  const recorder =
    candidatesDir === null
      ? null
      : new CandidateRecorder({
          dir: candidatesDir,
          registry,
          locales: options.locales ?? LOOKUP_LOCALES_RECORDED,
          ...(options.onError ? { onError: options.onError } : {}),
        });
  return { registry, recorder, locales, warnings };
}

/** `?locale=` of a request: a known locale, or the default for anything else (the fallback). */
export function parseLocale(raw: unknown): LookupLocale {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = LookupLocaleSchema.safeParse(typeof value === "string" ? value.toLowerCase() : "");
  return parsed.success ? parsed.data : DEFAULT_LOOKUP_LOCALE;
}

/**
 * The body of `GET /lookups`: every section of the vocabulary with its terms, their wire
 * values and their labels in `locale` — the default locale's label when `locale` has none,
 * the term itself when neither has one.
 */
export function lookupsResponse(lookups: Lookups, locale: LookupLocale): LookupsResponse {
  const { registry } = lookups;
  const chain = locale === DEFAULT_LOOKUP_LOCALE ? [locale] : [locale, DEFAULT_LOOKUP_LOCALE];
  const sections: LookupsResponse["lookups"] = {};
  for (const section of registry.sectionNames()) {
    sections[section] = registry.terms(section).map((term) => ({
      term,
      value: lookupWireValue(term),
      label: registry.label(section, term, chain) ?? term,
    }));
  }
  return { locale, locales: [...lookups.locales], lookups: sections };
}

/** The lookup values of a stored file. */
export interface FileLookupValues {
  kind: string;
  encryption: string;
}

/** The values of a file the vocabulary does not know, as `section → value`. */
export function unknownFileLookups(
  lookups: Lookups,
  file: FileLookupValues,
): Record<string, string> {
  const unknown: Record<string, string> = {};
  const check = (section: string, value: string | null | undefined) => {
    if (value && !lookups.registry.has(section, value)) unknown[section] = value;
  };
  check(LOOKUP_SECTIONS.fileKinds, file.kind);
  check(LOOKUP_SECTIONS.encryptionModes, file.encryption);
  return unknown;
}

/** Records the file's unknown lookup values as candidates (best effort; never throws). */
export async function recordFileCandidates(
  lookups: Lookups | undefined,
  file: FileLookupValues,
): Promise<void> {
  const recorder = lookups?.recorder;
  if (!lookups || !recorder) return;
  await Promise.all(
    Object.entries(unknownFileLookups(lookups, file)).map(([section, value]) =>
      recorder.record(section, value),
    ),
  );
}

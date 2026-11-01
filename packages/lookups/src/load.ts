import { readFile } from "node:fs/promises";
import { compileLookups, LookupCompileError } from "./compile.js";
import { type CsvIssue, validateTranslationsCsv } from "./csv.js";
import { LookupRegistry } from "./registry.js";

export interface LoadLookupsOptions {
  /** Path of `lookups.yaml`. */
  path: string;
  /** Optional translations sheet (`i18n/translations.csv`); a missing file is no error. */
  translationsPath?: string;
}

export interface LoadedLookups {
  registry: LookupRegistry;
  /** The locale columns of the translations sheet (`[]` without one). */
  locales: string[];
  /** Problems of the translations sheet that did not stop loading. */
  warnings: CsvIssue[];
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Loads the vocabulary at startup. Throws `LookupCompileError` when the YAML is invalid
 * or the translations sheet has errors (unknown terms, duplicates, a bad header).
 */
export async function loadLookups(options: LoadLookupsOptions): Promise<LoadedLookups> {
  const registry = new LookupRegistry(
    compileLookups(await readFile(options.path, "utf8"), options.path),
  );
  if (!options.translationsPath) return { registry, locales: [], warnings: [] };
  const csv = await readOptional(options.translationsPath);
  if (csv === null) return { registry, locales: [], warnings: [] };
  const result = validateTranslationsCsv(csv, registry);
  if (!result.ok) {
    const first = result.errors
      .slice(0, 5)
      .map((issue) => `line ${issue.line}: ${issue.message}`)
      .join("; ");
    throw new LookupCompileError(`${options.translationsPath}: ${first}`);
  }
  return {
    registry: registry.withTranslations(result.translations),
    locales: result.locales,
    warnings: result.warnings,
  };
}

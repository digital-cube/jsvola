import type { LookupRegistry, Translations } from "./registry.js";

export interface CsvRecord {
  /** 1-based line on which the record starts (quoted fields may span lines). */
  line: number;
  cells: string[];
}

const DELIMITERS = [",", ";", "\t"] as const;

/**
 * Picks the delimiter of a spreadsheet export from its header line: Excel writes `;`
 * under locales whose decimal separator is a comma (sr, de, …), LibreOffice may write tabs.
 */
export function detectDelimiter(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = header.split(delimiter).length - 1;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/**
 * RFC 4180 CSV parser, lenient the way spreadsheets need: strips a UTF-8 BOM, accepts
 * CRLF/LF, quoted fields with `""` escapes and embedded newlines, and skips blank lines.
 */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): CsvRecord[] {
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const endRecord = () => {
    cells.push(cell);
    if (cells.length > 1 || cells[0] !== "") records.push({ line: start, cells });
    cells = [];
    cell = "";
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      endRecord();
      line++;
      start = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || cells.length > 0) endRecord();
  return records;
}

/** One CSV line (no trailing newline), quoting cells that need it. */
export function formatCsvRow(cells: readonly string[], delimiter = ","): string {
  return cells
    .map((value) =>
      value.includes(delimiter) || /["\r\n]/.test(value) || value !== value.trim()
        ? `"${value.replaceAll('"', '""')}"`
        : value,
    )
    .join(delimiter);
}

export interface CsvIssue {
  line: number;
  column?: string;
  message: string;
}

export interface TranslationsValidation {
  ok: boolean;
  locales: string[];
  translations: Translations;
  errors: CsvIssue[];
  warnings: CsvIssue[];
}

const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * Validates a translations sheet (`section,term,en,sr,…`) against a registry: the header,
 * that every row names a known section and term, duplicates, and missing translations.
 * Errors make the sheet unusable; warnings (an empty cell, a term without a row) do not.
 */
export function validateTranslationsCsv(
  text: string,
  registry: LookupRegistry,
): TranslationsValidation {
  const errors: CsvIssue[] = [];
  const warnings: CsvIssue[] = [];
  const translations = new Map<string, Record<string, string>>();
  const [header, ...rows] = parseCsv(text);
  const result = (locales: string[]): TranslationsValidation => ({
    ok: errors.length === 0,
    locales,
    translations,
    errors,
    warnings,
  });
  if (!header) {
    errors.push({ line: 1, message: "empty file: expected a header section,term,<locale>…" });
    return result([]);
  }
  const columns = header.cells.map((cell) => cell.trim());
  if (columns[0]?.toLowerCase() !== "section" || columns[1]?.toLowerCase() !== "term") {
    errors.push({ line: header.line, message: 'header must start with "section,term"' });
    return result([]);
  }
  const locales = columns.slice(2);
  if (locales.length === 0) {
    errors.push({ line: header.line, message: "header has no locale columns (e.g. en,sr)" });
  }
  const seenLocales = new Set<string>();
  for (const locale of locales) {
    if (!LOCALE_RE.test(locale)) {
      errors.push({ line: header.line, column: locale, message: `invalid locale "${locale}"` });
    } else if (seenLocales.has(locale)) {
      errors.push({ line: header.line, column: locale, message: `duplicate locale "${locale}"` });
    }
    seenLocales.add(locale);
  }
  const seenRows = new Map<string, number>();
  for (const { line, cells } of rows) {
    const section = (cells[0] ?? "").trim();
    const term = (cells[1] ?? "").trim();
    if (cells.length > columns.length && cells.slice(columns.length).some((c) => c.trim())) {
      errors.push({ line, message: `${cells.length} cells, header has ${columns.length}` });
      continue;
    }
    if (!registry.hasSection(section)) {
      errors.push({ line, column: "section", message: `unknown section "${section}"` });
      continue;
    }
    if (!registry.terms(section).includes(term)) {
      errors.push({ line, column: "term", message: `unknown term "${term}" in ${section}` });
      continue;
    }
    const key = `${section}.${term}`;
    const previous = seenRows.get(key);
    if (previous !== undefined) {
      errors.push({ line, message: `duplicate row for ${key} (first on line ${previous})` });
      continue;
    }
    seenRows.set(key, line);
    const labels: Record<string, string> = {};
    locales.forEach((locale, index) => {
      const value = (cells[index + 2] ?? "").trim();
      if (value) labels[locale] = value;
      else warnings.push({ line, column: locale, message: `${key} has no ${locale} translation` });
    });
    translations.set(key, labels);
  }
  for (const section of registry.sectionNames()) {
    for (const term of registry.terms(section)) {
      if (!seenRows.has(`${section}.${term}`)) {
        warnings.push({ line: 0, message: `${section}.${term} has no translation row` });
      }
    }
  }
  return result(locales);
}

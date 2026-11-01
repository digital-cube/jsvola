import type { LookupRegistry } from "./registry.js";

export interface CodegenOptions {
  /**
   * Sections whose wire values are lower case: the term `USER` of `InstanceTypes` is sent
   * as `"user"`. Other sections keep the term as is (`USER_LOGIN`).
   */
  lowercase?: readonly string[];
  /** Named in the header comment. Default `lookups.yaml`. */
  source?: string;
}

function singular(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ss|us|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function pascal(word: string): string {
  return word
    .split("_")
    .filter(Boolean)
    .map((part) => (part[0] as string).toUpperCase() + part.slice(1))
    .join("");
}

/** `EventTypes` → `EVENT_TYPES`, `Statuses.Ticket` → `STATUSES_TICKET`. */
export function constantName(section: string): string {
  return section
    .split(".")
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
    .join("_")
    .toUpperCase();
}

/** `EventTypes` → `EventType`, `Statuses.Ticket` → `StatusesTicket`. */
export function typeName(section: string): string {
  const parts = section.split(".").map(pascal);
  return parts.length === 1 ? singular(parts[0] as string) : parts.join("");
}

/**
 * Generates a TypeScript module from a registry: per section a `readonly` tuple of wire
 * values, a string enum and a Zod `z.enum`. Deterministic, so a test can compare the
 * committed file against what the current `lookups.yaml` would produce.
 */
export function generateLookupsModule(
  registry: LookupRegistry,
  options: CodegenOptions = {},
): string {
  const lowercase = new Set(options.lowercase ?? []);
  const lines = [
    `// Generated from ${options.source ?? "lookups.yaml"} by \`memento lookups codegen\`.`,
    "// Do not edit by hand: change the YAML and regenerate.",
    'import { z } from "zod";',
    "",
  ];
  for (const section of registry.sectionNames()) {
    const terms = registry.terms(section);
    const wire = (term: string) => (lowercase.has(section) ? term.toLowerCase() : term);
    const constant = constantName(section);
    const type = typeName(section);
    lines.push(
      `/** \`${section}\` from the vocabulary, as sent on the wire. */`,
      `export const ${constant} = [${terms.map((t) => JSON.stringify(wire(t))).join(", ")}] as const;`,
      `export enum ${type} {`,
      ...terms.map((term) => `  ${term} = ${JSON.stringify(wire(term))},`),
      "}",
      `export const Known${type}Schema = z.enum(${constant});`,
      "",
    );
  }
  return lines.join("\n");
}

import { parse, YAMLParseError } from "yaml";

/** A namespace is a flat list of terms or a mapping of nested namespaces. */
export type LookupNode = readonly string[] | { readonly [key: string]: LookupNode };
export type LookupTree = { readonly [namespace: string]: LookupNode };

/** Terms are UPPER_SNAKE_CASE, so they are valid enum keys and stable across locales. */
export const TERM_RE = /^[A-Z][A-Z0-9_]*$/;
/** Namespace keys are PascalCase-ish identifiers: `EventTypes`, `InstanceTypes`. */
const NAMESPACE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export class LookupCompileError extends Error {
  override name = "LookupCompileError";
}

function normalizeNode(body: unknown, path: string): LookupNode {
  if (Array.isArray(body)) {
    const seen = new Set<string>();
    for (const term of body) {
      if (typeof term !== "string") {
        throw new LookupCompileError(`${path}: term must be a string, got ${typeof term}`);
      }
      if (!TERM_RE.test(term)) {
        throw new LookupCompileError(`${path}: term "${term}" must be UPPER_SNAKE_CASE`);
      }
      if (seen.has(term)) throw new LookupCompileError(`${path}: duplicate term "${term}"`);
      seen.add(term);
    }
    return [...body] as string[];
  }
  if (body !== null && typeof body === "object") {
    const out: Record<string, LookupNode> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!NAMESPACE_RE.test(key)) {
        throw new LookupCompileError(`${path}: invalid namespace key "${key}"`);
      }
      out[key] = normalizeNode(value, `${path}.${key}`);
    }
    return out;
  }
  throw new LookupCompileError(`${path}: expected a list or a mapping`);
}

/**
 * Compiles the text of a `lookups.yaml` into a validated tree. `source` names the file
 * in error messages.
 */
export function compileLookups(text: string, source = "lookups.yaml"): LookupTree {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      throw new LookupCompileError(`${source}: YAML parse error: ${error.message}`);
    }
    throw error;
  }
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new LookupCompileError(`${source}: top level must be a mapping of namespaces`);
  }
  const tree: Record<string, LookupNode> = {};
  for (const [namespace, body] of Object.entries(raw)) {
    if (!NAMESPACE_RE.test(namespace)) {
      throw new LookupCompileError(`${source}: invalid namespace "${namespace}"`);
    }
    tree[namespace] = normalizeNode(body, namespace);
  }
  return tree;
}

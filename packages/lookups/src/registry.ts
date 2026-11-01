import type { LookupNode, LookupTree } from "./compile.js";
import { normalizeTerm } from "./normalize.js";

/** `{ "EventTypes.USER_LOGIN": { en: "User login", sr: "Prijava korisnika" } }` */
export type Translations = ReadonlyMap<string, Readonly<Record<string, string>>>;

function flatten(node: LookupNode, prefix: string, out: Map<string, readonly string[]>): void {
  if (Array.isArray(node)) {
    out.set(prefix, node as readonly string[]);
    return;
  }
  for (const [key, child] of Object.entries(node as Record<string, LookupNode>)) {
    flatten(child, `${prefix}.${key}`, out);
  }
}

/**
 * The runtime view of a lookup tree: which terms exist in which section (`EventTypes`,
 * `Statuses.Ticket`), and their translated labels.
 */
export class LookupRegistry {
  readonly tree: LookupTree;
  private readonly sections: Map<string, readonly string[]>;
  private readonly members: Map<string, ReadonlySet<string>>;
  private readonly translations: Translations;

  constructor(tree: LookupTree = {}, translations: Translations = new Map()) {
    this.tree = tree;
    this.sections = new Map();
    for (const [namespace, node] of Object.entries(tree)) flatten(node, namespace, this.sections);
    this.members = new Map([...this.sections].map(([key, terms]) => [key, new Set(terms)]));
    this.translations = translations;
  }

  /** Every section that holds terms, e.g. `["ActorTypes", "EventTypes", "InstanceTypes"]`. */
  sectionNames(): string[] {
    return [...this.sections.keys()];
  }

  hasSection(section: string): boolean {
    return this.sections.has(section);
  }

  /** The terms of a section, in declaration order (empty for an unknown section). */
  terms(section: string): readonly string[] {
    return this.sections.get(section) ?? [];
  }

  /** Whether `value` is a term of `section`; the value is normalized first (`user` → USER). */
  has(section: string, value: string): boolean {
    return this.members.get(section)?.has(normalizeTerm(value)) ?? false;
  }

  /**
   * The label of a term in the first locale of `locales` that has one, or `undefined`.
   * `sr-Latn` also tries `sr`.
   */
  label(section: string, value: string, locales: readonly string[]): string | undefined {
    const row = this.translations.get(`${section}.${normalizeTerm(value)}`);
    if (!row) return undefined;
    for (const locale of locales) {
      const text = row[locale] ?? row[locale.split("-")[0] as string];
      if (text) return text;
    }
    return undefined;
  }

  /** A registry with the same terms and these translations. */
  withTranslations(translations: Translations): LookupRegistry {
    return new LookupRegistry(this.tree, translations);
  }
}

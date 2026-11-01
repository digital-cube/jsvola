/**
 * `@vola/lookups` — controlled vocabularies of JSVola.
 *
 * Skeleton only: the YAML loader, CSV translations and the `lookups.yaml` content arrive
 * with the lookups ticket (plan 3.1). Until then this package exports the section names the
 * vocabulary will have, so dependants can already import from it.
 */

/** Sections `lookups.yaml` is organised in (same format as `@memento/lookups`). */
export const LOOKUP_SECTIONS = ["instance_types", "job_kinds", "job_statuses"] as const;

export type LookupSection = (typeof LOOKUP_SECTIONS)[number];

/** True when `name` is one of `LOOKUP_SECTIONS`. */
export function isLookupSection(name: string): name is LookupSection {
  return (LOOKUP_SECTIONS as readonly string[]).includes(name);
}

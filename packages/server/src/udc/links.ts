import { type FieldDef, isLookupType, type SchemaDoc } from "@jsudc/core";
import { assertRegistryLinks, type CollectionRegistry } from "@jsudc/server";

/**
 * A lookup into a controlled vocabulary: a `lookup` / `lookup_array` whose `ref` names a
 * `lookups.yaml` section (`files.kind` → `FileKinds`) and no collection. `@jsudc/core` 0.3
 * leaves such a field as it is (no `lookup: {collection, label_field}` block, "it names no
 * collection"), `@jsudc/react` draws its value as before, but the startup check of
 * `@jsudc/server` 0.3 (`udcPlugin` `checkLinks`) refuses it as a lookup without a target.
 */
export function isVocabularyLookup(def: FieldDef): boolean {
  return isLookupType(def.type) && def.lookup === undefined && typeof def.ref === "string";
}

/** `schema` without its vocabulary lookups, for the cross-collection check. */
export function withoutVocabularyLookups<S extends Pick<SchemaDoc, "fields">>(schema: S): S {
  const fields = Object.fromEntries(
    Object.entries(schema.fields).filter(([, def]) => !isVocabularyLookup(def)),
  );
  return { ...schema, fields };
}

/**
 * `@jsudc/server`'s startup check of lookups and row links over the ACTIVE schemas of the
 * registry (`checkRegistryLinks`), minus the vocabulary lookups (`isVocabularyLookup`): every
 * lookup that names a collection, and every `row_link`, is checked exactly as jsudc checks it,
 * and a mismatch stops the start with the same error.
 */
export async function checkUdcLinks(registry: CollectionRegistry): Promise<void> {
  const collections = await Promise.all(
    registry.list().map(async (c) => ({
      name: c.name,
      schema: withoutVocabularyLookups(await c.source.describe()),
      view: c.view,
    })),
  );
  assertRegistryLinks(collections, "active schemas");
}

import type { SchemaDoc, ViewConfig } from "@jsudc/core";
import { CollectionRegistry, type Source } from "@jsudc/server";
import { LOOKUP_SECTIONS } from "@vol-a/core";
import { describe, expect, it } from "vitest";
import { checkUdcLinks, isVocabularyLookup, withoutVocabularyLookups } from "../src/udc/links.js";

const schema = (fields: SchemaDoc["fields"]) => ({ fields }) as SchemaDoc;

/** A registry of collections that only answer `describe` (all the check reads). */
function registryOf(
  collections: Record<string, SchemaDoc>,
  views: Record<string, ViewConfig> = {},
) {
  const registry = new CollectionRegistry();
  for (const [name, doc] of Object.entries(collections)) {
    registry.register({
      name,
      label: name,
      source: { describe: async () => doc } as unknown as Source,
      view: views[name] ?? ({} as ViewConfig),
    });
  }
  return registry;
}

const files = schema({
  filename: { type: "string" },
  kind: { type: "lookup", ref: LOOKUP_SECTIONS.fileKinds, required: true },
  encryption: { type: "lookup", ref: LOOKUP_SECTIONS.encryptionModes },
});

describe("UDC link check (@jsudc/server 0.3)", () => {
  it("tells a vocabulary lookup from a collection lookup and other fields", () => {
    expect(isVocabularyLookup({ type: "lookup", ref: LOOKUP_SECTIONS.fileKinds })).toBe(true);
    expect(isVocabularyLookup({ type: "lookup_array", ref: "Books.Genre" })).toBe(true);
    expect(
      isVocabularyLookup({ type: "lookup", lookup: { collection: "users", label_field: "name" } }),
    ).toBe(false);
    expect(isVocabularyLookup({ type: "lookup" })).toBe(false);
    expect(isVocabularyLookup({ type: "relation", ref: "users" })).toBe(false);
    expect(Object.keys(withoutVocabularyLookups(files).fields)).toEqual(["filename"]);
  });

  it("lets vola's vocabulary lookups through (jsudc's own check refuses them)", async () => {
    await expect(checkUdcLinks(registryOf({ files }))).resolves.toBeUndefined();
  });

  it("still stops the start on a lookup or row link that does not fit", async () => {
    const tickets = schema({
      owner: { type: "lookup", lookup: { collection: "users", label_field: "name" } },
    });
    await expect(checkUdcLinks(registryOf({ files, tickets }))).rejects.toThrow(
      /active schemas: lookups and row links do not fit\ntickets\.owner: lookup target users is not a served collection/,
    );
    const view = { row_link: { collection: "files", filter: { field: "nope", value_from: "id" } } };
    await expect(
      checkUdcLinks(registryOf({ files, tickets: schema({}) }, { tickets: view as ViewConfig })),
    ).rejects.toThrow(/tickets\.row_link: files has no field nope/);
  });
});

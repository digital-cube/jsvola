import type { ViewConfig } from "@jsudc/core";
import { CollectionRegistry } from "@jsudc/server";
import type { Database } from "../db/index.js";
import { type DecorateRow, FILES_COLLECTION, FilesCollectionSource } from "./files-source.js";
import { loadFilesView } from "./files-view.js";

export interface FilesCollectionsOptions {
  db: Database;
  /** Mount prefix of the vola routes (`/vola`), for the URLs in rows. */
  prefix: string;
  decorateRow?: DecorateRow | undefined;
  /** Default: `udc/files/view.yaml`. */
  view?: ViewConfig | undefined;
}

/** The registry vola serves under `/udc`: the `files` collection (the `menu` is added by the plugin). */
export function filesCollections(options: FilesCollectionsOptions): CollectionRegistry {
  const registry = new CollectionRegistry();
  registry.register({
    name: FILES_COLLECTION,
    label: "Files",
    source: new FilesCollectionSource(options),
    view: options.view ?? loadFilesView(),
  });
  return registry;
}

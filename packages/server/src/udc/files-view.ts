import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ViewConfig, ViewConfigSchema } from "@jsudc/core";
import { parse } from "yaml";

/** `udc/files/view.yaml` of this package (shipped next to `dist/`). */
export const FILES_VIEW_PATH = fileURLToPath(new URL("../../udc/files/view.yaml", import.meta.url));

/** The view of the `files` collection, validated; a missing or invalid file throws here. */
export function loadFilesView(path = FILES_VIEW_PATH): ViewConfig {
  return ViewConfigSchema.parse(parse(readFileSync(path, "utf8")));
}

import { loadRegistry, MemorySource, makeSource } from "@jsudc/server";
import { buildApp } from "../src/server/app.ts";

const COLLECTIONS = new URL("../collections", import.meta.url).pathname;

/** The backend with the tickets in memory: no database, nothing to start. */
export async function testApp() {
  const registry = loadRegistry(COLLECTIONS, (asset, reg) =>
    asset.name === "tickets"
      ? new MemorySource({ schema: asset.schema })
      : makeSource(asset, { registry: reg }),
  );
  return buildApp({ registry });
}

export const AS_IGOR = { "x-user-id": "igor" };

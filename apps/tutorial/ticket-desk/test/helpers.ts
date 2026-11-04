import { loadRegistry, MemorySource, makeSource } from "@jsudc/server";
import { buildApp } from "../src/server/app.ts";
import type { DeskEvent } from "../src/server/events.ts";

const COLLECTIONS = new URL("../collections", import.meta.url).pathname;

export const FILE = {
  id: "file-1",
  filename: "report.pdf",
  size: 1024,
  mime_type: "application/pdf",
};

/** The backend with the tickets in memory and a list for memento: nothing to start. */
export async function testApp(browserKeys = { memento: "mk_browser", vola: "vola_browser" }) {
  const events: DeskEvent[] = [];
  const registry = loadRegistry(COLLECTIONS, (asset, reg) =>
    asset.name === "tickets"
      ? new MemorySource({ schema: asset.schema })
      : makeSource(asset, { registry: reg }),
  );
  const app = await buildApp({
    registry,
    emit: async (event) => {
      events.push(event);
    },
    lookupFile: async (_ticketId, fileId) => {
      if (fileId !== FILE.id) throw new Error("not on this ticket");
      return FILE;
    },
    browserKeys,
  });
  return Object.assign(app, { events });
}

export const AS_IGOR = { "x-user-id": "igor" };

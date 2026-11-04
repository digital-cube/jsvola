import {
  connect,
  createCollectionTableSql,
  ensureUdcSchema,
  loadRegistry,
  makeSource,
  readCollectionAssets,
  seedCollection,
} from "@jsudc/server";
import { VolaClient } from "@vol-a/client";
import { sql } from "drizzle-orm";
import { buildApp } from "./app.ts";
import { mementoEmitter } from "./memento.ts";

const COLLECTIONS = new URL("../../collections", import.meta.url).pathname;

const { db } = connect(process.env.DATABASE_URL ?? "postgresql://desk:desk@localhost/desk");

// The one table of this program: the tickets, every field in a jsonb column.
await ensureUdcSchema(db);
await db.execute(sql.raw(createCollectionTableSql("tickets")));
const asset = readCollectionAssets(COLLECTIONS).find(({ name }) => name === "tickets");
if (!asset) throw new Error("collections/tickets is missing");
await seedCollection(db, { table: "tickets", schema: asset.schemaJson, rows: [] });

const registry = loadRegistry(COLLECTIONS, (collection, reg) =>
  makeSource(collection, { db, registry: reg }),
);

const VOLA_URL = process.env.VOLA_URL ?? "http://localhost:8300/vola";
const MEMENTO_URL = process.env.MEMENTO_URL ?? "http://localhost:3000/memento";

const vola = new VolaClient({ baseUrl: VOLA_URL, apiKey: process.env.VOLA_SERVER_KEY ?? "" });

const app = await buildApp({
  registry,
  logger: true,
  emit: mementoEmitter(MEMENTO_URL, process.env.MEMENTO_SERVER_KEY ?? "", console),
  lookupFile: (ticketId, fileId) => vola.files.info("tickets", ticketId, fileId),
  browserKeys: {
    memento: process.env.MEMENTO_BROWSER_KEY ?? "",
    vola: process.env.VOLA_BROWSER_KEY ?? "",
  },
  upstreams: { "/vola": new URL(VOLA_URL).origin, "/memento": new URL(MEMENTO_URL).origin },
  webRoot: new URL("../../dist", import.meta.url).pathname,
});
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });

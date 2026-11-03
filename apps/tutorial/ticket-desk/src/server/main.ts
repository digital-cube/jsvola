import {
  connect,
  createCollectionTableSql,
  ensureUdcSchema,
  loadRegistry,
  makeSource,
  readCollectionAssets,
  seedCollection,
} from "@jsudc/server";
import { sql } from "drizzle-orm";
import { buildApp } from "./app.ts";

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

const app = await buildApp({ registry, logger: true });
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });

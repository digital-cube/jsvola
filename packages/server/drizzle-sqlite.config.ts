import { defineConfig } from "drizzle-kit";

// `generate` needs no database; the URL only matters to drizzle-kit's own `push` / `studio`.
const url = process.env.VOLA_DATABASE_URL?.startsWith("file:")
  ? process.env.VOLA_DATABASE_URL
  : "file:var/vola.db";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema-sqlite.ts",
  out: "./drizzle-sqlite",
  dbCredentials: { url },
});

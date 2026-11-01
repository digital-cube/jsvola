import { defineConfig } from "drizzle-kit";

const url = process.env.VOLA_DATABASE_URL ?? "postgresql://vola:vola@localhost:5432/vola";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});

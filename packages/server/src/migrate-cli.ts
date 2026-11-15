import { loadConfig } from "./config.js";
import { connect, dialectOf, runMigrations } from "./db/index.js";
import { sqlitePath } from "./db/sqlite.js";

// `MIGRATE_TARGET=test` points the same migrations at the test database. The URL picks the
// migrations: `drizzle/` for PostgreSQL, `drizzle-sqlite/` for a `file:` URL.
const config = loadConfig();
const url = process.env.MIGRATE_TARGET === "test" ? config.testDatabaseUrl : config.databaseUrl;
const database = connect(url, { max: 1 });
try {
  await runMigrations(database.db);
  // The database name or the file, never the rest of a URL (it may carry a password).
  const target =
    dialectOf(url).name === "sqlite" ? sqlitePath(url) : new URL(url).pathname.slice(1);
  console.log(`migrations applied to ${target}`);
} finally {
  await database.close();
}

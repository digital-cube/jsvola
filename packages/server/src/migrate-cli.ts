import { loadConfig } from "./config.js";
import { connect, runMigrations } from "./db/index.js";

// `MIGRATE_TARGET=test` points the same migrations at the test database.
const config = loadConfig();
const url = process.env.MIGRATE_TARGET === "test" ? config.testDatabaseUrl : config.databaseUrl;
const database = connect(url, { max: 1 });
try {
  await runMigrations(database.db);
  console.log(`migrations applied to ${new URL(url).pathname.slice(1)}`);
} finally {
  await database.close();
}

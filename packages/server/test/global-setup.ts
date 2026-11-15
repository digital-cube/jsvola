import { rmSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { connect, dialectOf, runMigrations } from "../src/db/index.js";
import { sqlitePath } from "../src/db/sqlite.js";

/** What vitest hands a global setup: the project, with the `env` its test files get. */
interface Project {
  config: { env?: Record<string, string | undefined> };
}

/** The test database of `project`: its `env` (the SQLite project) or the environment. */
const testUrl = (project: Project | undefined): string =>
  project?.config.env?.VOLA_DATABASE_URL_TEST ?? loadConfig().testDatabaseUrl;

/** A SQLite test database and its WAL files, gone. */
function removeSqlite(url: string): void {
  if (dialectOf(url).name !== "sqlite" || sqlitePath(url) === ":memory:") return;
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${sqlitePath(url)}${suffix}`, { force: true });
}

/**
 * Brings the test database up to the latest migration once per run: PostgreSQL as it is, a
 * SQLite file created empty for the run (and removed after it).
 */
export default async function setup(project?: Project): Promise<() => void> {
  const url = testUrl(project);
  removeSqlite(url);
  const database = connect(url, { max: 1 });
  try {
    await runMigrations(database.db);
  } finally {
    await database.close();
  }
  return () => removeSqlite(url);
}

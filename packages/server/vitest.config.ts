import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The suite runs twice: on PostgreSQL (`VOLA_DATABASE_URL_TEST`) and on SQLite (a file under
 * the temporary directory, created and migrated for the run). `VOLA_TEST_DIALECT=postgres` or
 * `=sqlite` runs one of them (`pnpm test:pg`, `pnpm test:sqlite` in this package).
 */
const SQLITE_TEST_URL = `file:${join(tmpdir(), `vola-server-test-${process.pid}.db`)}`;
const only = process.env.VOLA_TEST_DIALECT;

const projects = [
  { name: "server", dialect: "postgres", env: { VOLA_TEST_DIALECT: "postgres" } },
  {
    name: "server-sqlite",
    dialect: "sqlite",
    env: { VOLA_TEST_DIALECT: "sqlite", VOLA_DATABASE_URL_TEST: SQLITE_TEST_URL },
  },
].filter((p) => !only || p.dialect === only);

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: {
      "@vol-a/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@vol-a/lookups": fileURLToPath(new URL("../lookups/src/index.ts", import.meta.url)),
    },
  },
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    projects: projects.map(({ name, env }) => ({
      extends: true,
      test: {
        name,
        env,
        include: ["test/**/*.test.ts"],
        globalSetup: ["test/global-setup.ts"],
        // DB test files will truncate the same tables: run files one at a time.
        fileParallelism: false,
      },
    })),
    coverage: {
      include: ["src/**/*.ts"],
      // Process entry points are thin wrappers over tested functions; the schema modules are
      // declarative (their callbacks only run inside drizzle-kit).
      exclude: [
        "src/server.ts",
        "src/migrate-cli.ts",
        "src/db/schema-postgres.ts",
        "src/db/schema-sqlite.ts",
      ],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});

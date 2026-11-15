import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The commands run against the test database twice, like the server suite: PostgreSQL
 * (`VOLA_DATABASE_URL_TEST`) and a SQLite file under the temporary directory, each migrated
 * once. `VOLA_TEST_DIALECT=postgres` or `=sqlite` runs one of them.
 */
const SQLITE_TEST_URL = `file:${join(tmpdir(), `vola-cli-test-${process.pid}.db`)}`;
const only = process.env.VOLA_TEST_DIALECT;

const projects = [
  { name: "cli", dialect: "postgres", env: { VOLA_TEST_DIALECT: "postgres" } },
  {
    name: "cli-sqlite",
    dialect: "sqlite",
    env: { VOLA_TEST_DIALECT: "sqlite", VOLA_DATABASE_URL_TEST: SQLITE_TEST_URL },
  },
].filter((p) => !only || p.dialect === only);

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: {
      "@vol-a/core": src("../core/src/index.ts"),
      "@vol-a/lookups": src("../lookups/src/index.ts"),
      "@vol-a/server": src("../server/src/index.ts"),
    },
  },
  test: {
    root: src("."),
    projects: projects.map(({ name, env }) => ({
      extends: true,
      test: {
        name,
        env,
        include: ["test/**/*.test.ts"],
        globalSetup: ["../server/test/global-setup.ts"],
        fileParallelism: false,
      },
    })),
    coverage: {
      include: ["src/**/*.ts"],
      // The process entry point only wires argv/exit code to `runCli`.
      exclude: ["src/main.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});

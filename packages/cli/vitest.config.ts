import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: {
      "@vola/core": src("../core/src/index.ts"),
      "@vola/lookups": src("../lookups/src/index.ts"),
      "@vola/server": src("../server/src/index.ts"),
    },
  },
  test: {
    name: "cli",
    root: src("."),
    include: ["test/**/*.test.ts"],
    // The commands run against the test database (VOLA_DATABASE_URL_TEST), migrated once.
    globalSetup: ["../server/test/global-setup.ts"],
    fileParallelism: false,
    coverage: {
      include: ["src/**/*.ts"],
      // The process entry point only wires argv/exit code to `runCli`.
      exclude: ["src/main.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: {
      "@vol-a/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@vol-a/lookups": fileURLToPath(new URL("../lookups/src/index.ts", import.meta.url)),
    },
  },
  test: {
    name: "server",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // DB test files will truncate the same tables: run files one at a time.
    fileParallelism: false,
    coverage: {
      include: ["src/**/*.ts"],
      // Process entry points are thin wrappers over tested functions; the schema module is
      // declarative (its callbacks only run inside drizzle-kit).
      exclude: ["src/server.ts", "src/migrate-cli.ts", "src/db/schema.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});

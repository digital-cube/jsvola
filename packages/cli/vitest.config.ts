import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: {
      "@vola/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    name: "cli",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      // The process entry point only wires argv/exit code to `runCli`.
      exclude: ["src/main.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});

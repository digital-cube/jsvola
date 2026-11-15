import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "json-summary", "json"],
      // A red run still reports (tools/test-full.mjs merges it for the thilo Testing tab).
      reportOnFailure: true,
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});

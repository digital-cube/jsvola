import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: {
      "@vola/core": src("../core/src/index.ts"),
      "@vola/client": src("../client/src/index.ts"),
    },
  },
  test: {
    name: "react",
    root: src("."),
    include: ["test/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});

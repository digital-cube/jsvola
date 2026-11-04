import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: {
      "@vol-a/core": src("../core/src/index.ts"),
      "@vol-a/client": src("../client/src/index.ts"),
    },
  },
  test: {
    name: "react",
    root: src("."),
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    server: {
      deps: {
        // @jsudc/react is a real package in node_modules; inline it so Vite transforms its subpaths.
        inline: [/@jsudc\/react/],
      },
    },
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: [
      { find: /^@vola\/core$/, replacement: src("../../packages/core/src/index.ts") },
      { find: /^@vola\/client$/, replacement: src("../../packages/client/src/index.ts") },
      { find: /^@vola\/react$/, replacement: src("../../packages/react/src/index.ts") },
    ],
  },
  test: {
    name: "examples",
    root: src("."),
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    // One react-router and one React for the app and the libraries: run them through Vite too.
    server: { deps: { inline: [/@jsudc\/react/] } },
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      // The entry point only mounts <App />.
      exclude: ["src/main.tsx", "src/vite-env.d.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 75, statements: 75, functions: 70, branches: 65 },
    },
  },
});

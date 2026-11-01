import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// No source aliases: these tests import the BUILT packages (`dist/`), like a deployment does.
export default defineConfig({
  test: {
    name: "e2e",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.e2e.ts"],
    globalSetup: ["test/stack.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});

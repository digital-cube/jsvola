import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VOLA_SERVER || "http://localhost:8300";
  // Same origin for the browser: the API, the demo routes and the /udc/subscribe WebSocket.
  const proxy = { "/vola": { target, changeOrigin: true, ws: true } };
  return {
    plugins: [react()],
    // Use the workspace packages' TypeScript sources: no build step before `pnpm dev`.
    resolve: { conditions: ["@vol-a/source", ...defaultClientConditions] },
    // Production bundle (served by @vol-a/server from VOLA_UI_DIR): no source maps.
    build: { outDir: "dist", sourcemap: false },
    server: { port: 5174, proxy },
    preview: { proxy },
  };
});

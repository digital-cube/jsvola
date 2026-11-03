import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev:web`: the backend is on :8080, with vola and memento behind it.
const backend = process.env.DESK_BACKEND ?? "http://localhost:8080";
const toBackend = { target: backend, ws: true };

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/config": toBackend,
      "/tickets": toBackend,
      "/udc": toBackend,
      "/vola": toBackend,
      "/memento": toBackend,
    },
  },
});

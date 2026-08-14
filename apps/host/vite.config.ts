import react from "@vitejs/plugin-react";
import { envFilePath } from "@fleet/protocol/runtime";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vite";

// The API port is configurable via `.env`, so the dev proxy has to read the
// same value instead of assuming the default — otherwise moving PORT silently
// points the UI at whatever else happens to be on 8787.
loadEnv({ path: envFilePath(), quiet: true });

const apiPort = process.env.PORT ?? "8787";
const apiHost = process.env.HOST ?? "127.0.0.1";

export default defineConfig({
  plugins: [react()],
  root: "ui",
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://${apiHost}:${apiPort}`,
      "/ws": {
        target: `ws://${apiHost}:${apiPort}`,
        ws: true,
      },
    },
  },
});

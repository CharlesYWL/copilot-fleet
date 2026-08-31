import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { rewriteDevProxyOrigin } from "./src/dev-proxy";

// The Host's port lives in the repo-root .env, which only the Host process
// loads. Reading it here too keeps the dev proxy pointed at the Host after
// someone moves PORT off the default — otherwise /api and /ws silently proxy
// to whatever else happens to own the old port.
export default defineConfig(({ mode }) => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const hostPort = loadEnv(mode, repoRoot, "").PORT || "8787";
  const apiOrigin = `http://127.0.0.1:${hostPort}`;

  return {
    plugins: [react()],
    root: "ui",
    build: {
      outDir: "../dist/ui",
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiOrigin,
          // Keep the browser-facing Host. Auth needs to know which local URL
          // owns the cookie, not which internal port Vite forwarded to.
          changeOrigin: false,
          configure(proxy) {
            proxy.on("proxyReq", (request, incoming) => {
              const origin = incoming.headers.origin;
              if (origin) rewriteDevProxyOrigin(request, origin);
            });
          },
        },
        "/ws": {
          target: `ws://127.0.0.1:${hostPort}`,
          changeOrigin: false,
          ws: true,
          configure(proxy) {
            proxy.on("proxyReqWs", (request, incoming) => {
              const origin = incoming.headers.origin;
              if (origin) rewriteDevProxyOrigin(request, origin);
            });
          },
        },
      },
    },
  };
});

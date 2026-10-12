import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { gitRevision } from "@fleet/protocol/runtime";

const here = dirname(fileURLToPath(import.meta.url));
let revision = "";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "node-session-build-revision",
      apply: "build",
      buildStart() {
        revision = gitRevision(resolve(here, "../.."));
      },
      generateBundle: {
        order: "post",
        handler(_options, bundle) {
          const manifest = bundle[".vite/manifest.json"];
          if (!manifest || manifest.type !== "asset") {
            this.error("Session console build did not generate its manifest");
          }
          const records = JSON.parse(String(manifest.source)) as Record<
            string,
            Record<string, unknown>
          >;
          if (!records["index.html"]) {
            this.error("Session console manifest has no HTML entry");
          }
          records["index.html"].revision = revision;
          manifest.source = JSON.stringify(records, null, 2);
        },
      },
    },
  ],
  root: resolve(here, "ui"),
  base: "/session-console/",
  resolve: {
    alias: [
      {
        find: /^@fleet\/protocol$/,
        replacement: resolve(here, "../../packages/protocol/src/index.ts"),
      },
    ],
  },
  build: {
    outDir: resolve(here, "dist/ui"),
    emptyOutDir: true,
    manifest: true,
  },
});

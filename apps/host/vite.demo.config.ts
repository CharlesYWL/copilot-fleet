import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The playable showcase: the real UI bundled with an in-browser Host.
 *
 * Built with relative asset URLs so it works from any subpath, which is how
 * static hosts such as VibeHub serve it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

export default defineConfig({
  plugins: [react()],
  root: resolve(here, "ui/demo"),
  base: "./",
  resolve: {
    alias: [
      {
        find: /^@fleet\/protocol$/,
        replacement: resolve(repoRoot, "packages/protocol/src/index.ts"),
      },
    ],
  },
  build: {
    outDir: resolve(here, "dist/demo"),
    emptyOutDir: true,
  },
});

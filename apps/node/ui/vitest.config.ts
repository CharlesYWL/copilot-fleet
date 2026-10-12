import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    include: ["apps/node/ui/src/**/*.test.{ts,tsx}"],
    setupFiles: ["apps/host/ui/src/test-setup.ts"],
  },
});

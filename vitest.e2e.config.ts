import { defineConfig } from "vitest/config";

/**
 * Browser tests of the built app: a real Host process on a disposable database,
 * a fake Node feeding it events, and an installed Edge (or FLEET_E2E_BROWSER).
 *
 * Separate from `vitest.config.ts`, so `npm test` needs neither a build nor a
 * browser. Run them with `npm run test:e2e`.
 */
export default defineConfig({
  test: {
    name: "e2e",
    environment: "node",
    include: ["scripts/e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});

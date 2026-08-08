import { defineConfig } from "vitest/config";

/**
 * One runner for the whole workspace.
 *
 * The UI half needs a DOM, and the two services must not have one — a global
 * `window` would let a browser-only mistake pass here and fail in production —
 * so they are separate projects rather than one shared environment.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "services",
          environment: "node",
          include: [
            "apps/host/src/**/*.test.ts",
            "apps/node/src/**/*.test.ts",
            "packages/**/src/**/*.test.ts",
          ],
        },
      },
      {
        // Components are compiled with the automatic runtime here, the same as
        // Vite does for the app, so tests do not have to import React.
        esbuild: { jsx: "automatic" },
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["apps/host/ui/src/**/*.test.{ts,tsx}"],
          setupFiles: ["apps/host/ui/src/test-setup.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: [
        "apps/*/src/**/*.ts",
        "apps/host/ui/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.ts",
      ],
      exclude: ["**/*.test.*", "**/test-setup.ts", "**/dist/**"],
      // A floor to keep from sliding backwards, not a target. Statement cover
      // is low because the UI components have none yet; the branch and function
      // numbers are what the service tests actually hold up.
      thresholds: { statements: 30, branches: 75, functions: 60, lines: 30 },
    },
  },
});

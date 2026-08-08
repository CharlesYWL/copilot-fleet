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
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["apps/host/ui/src/**/*.test.{ts,tsx}"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["apps/*/src/**/*.ts", "apps/host/ui/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
      exclude: ["**/*.test.*", "**/dist/**"],
      // A floor to keep from sliding backwards, not a target.
      thresholds: { statements: 45, branches: 65, functions: 55, lines: 45 },
    },
  },
});

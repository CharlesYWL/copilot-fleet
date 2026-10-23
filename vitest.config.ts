import { configDefaults, defineConfig } from "vitest/config";

/**
 * Suites whose work is real OS processes — Git repositories and worktrees,
 * PowerShell, Node children. On Windows each launch costs hundreds of
 * milliseconds, so they run after everything else instead of starving the
 * in-process suites of CPU and disk, and their default budgets are sized for
 * process launches rather than for in-process code.
 */
const processSuites = [
  "apps/host/src/command-execution.e2e.test.ts",
  "apps/host/src/command-execution.test.ts",
  "apps/node/src/command-execution-manager.test.ts",
  "apps/node/src/command-storage.test.ts",
  "apps/node/src/command-supervisor.test.ts",
  "apps/node/src/command-supervisor-posix.test.ts",
  "apps/node/src/managed-worktrees.test.ts",
  "packages/protocol/src/updater.integration.test.ts",
  "scripts/launcher.integration.test.js",
  "scripts/login-service-install.test.js",
  "scripts/managed-worktrees.integration.test.js",
  "scripts/managed-worktrees.recovery.test.js",
  "scripts/windows-login-task.test.js",
];

/**
 * The 5s default leaves no room for a test that takes a second or two alone:
 * a full parallel run on Windows slows in-process tests about fourfold.
 */
const inProcessTimeout = 15_000;

/**
 * One runner for the whole workspace.
 *
 * The UI half needs a DOM, and the two services must not have one — a global
 * `window` would let a browser-only mistake pass here and fail in production —
 * so they are separate projects rather than one shared environment.
 */
export default defineConfig({
  test: {
    // Host and Node tests consume the built workspace package. Rebuilding it
    // must also rerun consumers, not just the protocol's own source tests.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      "**/packages/protocol/dist/**",
      "**/packages/prm-skill/dist/lib/**",
    ],
    projects: [
      {
        test: {
          name: "services",
          environment: "node",
          setupFiles: ["apps/host/src/test-setup.ts"],
          include: [
            "apps/host/src/**/*.test.ts",
            "apps/node/src/**/*.test.ts",
            "packages/**/src/**/*.test.ts",
            "scripts/**/*.test.{js,ts}",
          ],
          exclude: [...configDefaults.exclude, ...processSuites],
          testTimeout: inProcessTimeout,
        },
      },
      {
        test: {
          name: "services-process",
          environment: "node",
          setupFiles: ["apps/host/src/test-setup.ts"],
          include: processSuites,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          sequence: { groupOrder: 1 },
        },
      },
      {
        // Components are compiled with the automatic runtime here, the same as
        // Vite does for the app, so tests do not have to import React.
        esbuild: { jsx: "automatic" },
        test: {
          name: "ui",
          environment: "jsdom",
          include: [
            "apps/host/ui/src/**/*.test.{ts,tsx}",
            "apps/node/ui/src/**/*.test.{ts,tsx}",
          ],
          setupFiles: ["apps/host/ui/src/test-setup.ts"],
          testTimeout: inProcessTimeout,
        },
      },
      {
        // The node's config page is hand-written browser JavaScript served as
        // it is, with no build step to type-check it — so the only way to know
        // it still works is to run it in a DOM, which is what this project is.
        test: {
          name: "node-ui",
          environment: "jsdom",
          include: ["apps/node/public/**/*.test.js"],
          testTimeout: inProcessTimeout,
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

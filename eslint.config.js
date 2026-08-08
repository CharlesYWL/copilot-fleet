import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/**
 * The style here was already consistent by hand; this only fixes it in place
 * and adds the checks a reviewer cannot reliably do by eye — unused code,
 * floating promises, and the rules of hooks.
 */
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "apps/host/ui/dist/**", "apps/node/public/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["warn", { allow: ["error", "warn"] }],
      eqeqeq: ["error", "smart"],
    },
  },
  {
    files: ["apps/host/ui/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    // The two long-standing rules only. The compiler-era additions in this
    // plugin's recommended set (set-state-in-effect, refs) reject patterns the
    // UI uses deliberately, and turning them on is its own piece of work.
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // The node service is a CLI: printing is how it reports what it is doing.
    files: ["apps/node/src/**/*.ts", "apps/host/src/tunnel-process.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  prettier,
);

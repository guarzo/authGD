// Flat config. Deliberately additive-only for now: this config is introduced
// without reformatting or auto-fixing the existing codebase, so every rule here
// is one we're prepared to either honour or explicitly turn off after triage.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Generated, vendored, or build output — never linted.
    ignores: [
      "node_modules/**",
      ".next/**",
      "drizzle/**", // drizzle-kit output; migrations are generated, never hand-written
      "tmp/**",
      "public/**",
      "test-results/**",
      "playwright-report/**",
      ".claude/**",
    ],
  },

  js.configs.recommended,

  // Type-aware linting. The queue/worker code lives or dies on promise
  // handling, so no-floating-promises and no-misused-promises are worth the
  // extra parser cost.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // tsconfig.json only includes *.ts/*.tsx, so the root .mjs config files
    // have no type information — lint them without the type-aware rules
    // rather than widening tsconfig to cover tooling.
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },

  // The Next plugin ships eslintrc-shaped configs (`plugins` is an array), so
  // it can't be spread into flat config directly — register it by hand.
  {
    files: ["src/app/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },

  // Node-side entrypoints and tooling: console output is the intended
  // interface, not a debugging leftover.
  {
    files: [
      "scripts/**/*.ts",
      "src/worker/**/*.ts",
      "src/db/migrate.ts",
      "*.config.{ts,mjs}",
    ],
    rules: { "no-console": "off" },
  },

  // Tests and e2e specs: relax assertions that only make sense in production code.
  {
    files: ["tests/**/*.ts", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // MUST be last: turns off every rule that would fight Prettier.
  prettier,
);

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
      // Written by `next build`/`next dev`, gitignored. Its triple-slash
      // reference trips @typescript-eslint/triple-slash-reference, so a clean
      // checkout lints clean but any machine that has built does not — CI very
      // much included.
      "next-env.d.ts",
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

  // Rule adjustments that encode conventions this codebase already follows,
  // rather than asking the codebase to change to suit the defaults.
  // Scoped to TS: `only-throw-error` is type-aware, and re-enabling it
  // unscoped would undo the disableTypeChecked block above for *.mjs.
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // `_req`, `_url`, `_init` — the leading underscore is already the
      // established "deliberately unused" marker here.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // NOTE: @typescript-eslint/no-unnecessary-type-assertion stays ENABLED.
      // It has five known false positives in src/, each suppressed inline at
      // the call site with the reason. Do not blanket-disable it here: outside
      // those five spots it correctly catches redundant assertions (it found 16
      // real ones in tests/). Be aware that its autofix is not trustworthy in
      // this codebase — where a value is returned into a wider declared type,
      // the assertion is load-bearing and removing it breaks `tsc`. Always run
      // `npm run typecheck` after `npm run lint:fix`.
    },
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
      // Test doubles are declared `async` to match the real interface they
      // stand in for, even when the body has nothing to await. 85 of these,
      // none in src/ — the rule keeps its full value where it matters.
      "@typescript-eslint/require-await": "off",
      // Fixtures and JSON payloads are legitimately `any` in tests.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      // Assertion messages stringify loosely-typed fixture values on purpose.
      "@typescript-eslint/no-base-to-string": "off",
    },
  },

  // MUST be last: turns off every rule that would fight Prettier.
  prettier,
);

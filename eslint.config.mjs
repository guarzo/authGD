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
      // DISABLED, with evidence. This rule flagged 5 assertions in src/ as
      // unnecessary; running its autofix broke `tsc` on all 5. It judges an
      // assertion in isolation, where literal types survive, and misses that
      // the value is then widened by its context:
      //
      //   src/services/accounts.ts  `as "valid" | "needs_reauth"` — without it
      //     the object-literal property widens to `string` and no longer
      //     satisfies the drizzle insert type.
      //   src/jobs/discord-roles.ts `as Record<string, number>` (x4) — without
      //     it the four return branches infer as a union carrying
      //     `notInGuild?: undefined` etc., which fails the index signature on
      //     JobResult["counts"].
      //
      // Returning object literals into a wider declared type is the dominant
      // shape of the job handlers, so this will keep misfiring. A lint rule
      // whose --fix breaks the build is worse than no rule: `npm run lint:fix`
      // is a wired script anyone may run.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
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

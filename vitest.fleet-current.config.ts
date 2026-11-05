import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// Replace include, rather than merging arrays and accidentally running all suites.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["e2e/fleet-current-v2.test.ts"],
    testTimeout: 180000,
    hookTimeout: 30000,
  },
});

import { SYNTHETIC_APP_ENV, WORKTREE_ROOT } from "../../e2e/env";
import { TEST_URL } from "./test-db-url";
import { databaseIsolationEnvironment } from "../../e2e/db-isolation-bootstrap";

// Kept separate so default selection can be checked without opening a database
// or changing the running suite's approved TEST_DATABASE_URL environment.
export function databaseIsolationTestEnvironment() {
  return {
    NODE_ENV: "test" as const,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...SYNTHETIC_APP_ENV,
    ...databaseIsolationEnvironment(),
    E2E_MANAGED_WORKTREE: WORKTREE_ROOT,
    DATABASE_URL: TEST_URL,
    TEST_DATABASE_URL: TEST_URL,
    SYNC_MODE: "dry-run",
  };
}

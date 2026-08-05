import { Client } from "pg";
import {
  deriveWorktreeDbName,
  OWNS_TEST_DB,
  TEST_URL,
} from "../tests/helpers/test-db-url";

/**
 * Drops the database `npm test` derives for this worktree.
 *
 * The unit suite creates that database on first run and never reclaims it, so
 * a deleted worktree would otherwise leave one behind forever. The mirror of
 * `test:e2e:clean`, which removes the e2e container for the same reason.
 *
 * Refuses to touch anything it did not derive: an explicit TEST_DATABASE_URL is
 * the developer's own, and CI's shared database belongs to the workflow. The
 * OWNS_TEST_DB check below is what enforces that; PROTECTED is a backstop
 * against a future change to deriveWorktreeDbName's construction, not a filter
 * on input this script ever sees today.
 */
const PROTECTED = new Set([
  "authgd",
  "authgd_test",
  "postgres",
  "template0",
  "template1",
]);

async function main(): Promise<void> {
  if (!OWNS_TEST_DB) {
    console.log(
      "TEST_DATABASE_URL or CI is set, so npm test is not using a database of " +
        "its own. Nothing to clean.",
    );
    return;
  }

  const name = deriveWorktreeDbName(process.cwd());
  // Not reachable today: deriveWorktreeDbName always prefixes with
  // "authgd_test_", which none of PROTECTED is, so this can never fire against
  // present input. It's an assertion against a future change to that function
  // rather than a live filter — the OWNS_TEST_DB gate above is what actually
  // keeps this script off databases it doesn't own.
  if (PROTECTED.has(name)) {
    throw new Error(`refusing to drop ${name}`);
  }

  const url = new URL(TEST_URL);
  const admin = new Client({
    host: url.hostname,
    port: Number(url.port || "5432"),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: "postgres",
    connectionTimeoutMillis: 3000,
  });

  await admin.connect();
  try {
    // WITH (FORCE) terminates connections a crashed run may have left behind;
    // without it a single stale backend makes the drop fail. Postgres 13+.
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    console.log(`dropped ${name}`);
  } finally {
    await admin.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`could not drop this worktree's test database: ${message}`);
  process.exitCode = 1;
});

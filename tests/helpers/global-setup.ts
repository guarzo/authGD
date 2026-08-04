import { basename } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { TEST_URL } from "./db";

/**
 * Vitest `globalSetup`: take a session-scoped advisory lock on the test
 * database for the lifetime of the run, so two checkouts running `npm test`
 * against the same `authgd_test` fail fast instead of TRUNCATEing each
 * other's rows mid-test (docs/ops.md, "npm test cannot touch your dev
 * database"). Without this, the symptom is assertion failures that move
 * around between runs — indistinguishable from a real regression.
 *
 * Deliberately NOT per-worktree database isolation (that was considered and
 * rejected) — this only turns silent corruption into a named error that
 * points at the existing `TEST_DATABASE_URL` escape hatch.
 */

/**
 * A fixed 64-bit advisory lock key, spelled out from the ASCII bytes of
 * "AUTHGDLK" (0x41 55 54 48 47 44 4C 4B) so it reads as an intentional,
 * memorable constant rather than a value someone might mistake for
 * meaningful data.
 *
 * pg-boss (`node_modules/pg-boss/src/plans.js`, `advisoryLock`) takes
 * `pg_advisory_xact_lock(sha224(current_database() || '.pgboss.' || schema)
 * ::bit(64)::bigint)` in the same per-database advisory-lock key space, and
 * `tests/worker-queues.test.ts` runs pg-boss against this same database. A
 * SHA-224 digest landing on this exact constant is astronomically unlikely,
 * and this constant is fixed and human-chosen rather than derived from any
 * hash, so the two schemes can't be confused with one another either.
 */
const LOCK_KEY = 0x4155544847444c4bn;

const MAX_DB_NAME_LENGTH = 63;
const PREFIX = "authgd_test_";

/**
 * Turns a worktree directory name into the suffix of a legal, unquoted
 * Postgres identifier: lowercase, non `[a-z0-9_]` collapsed to a single `_`,
 * and the whole `authgd_test_<suffix>` name capped at Postgres's 63-byte
 * identifier limit. Matches the naming already in use for hand-made escape
 * databases (`authgd_test_admintbl`, `authgd_test_shellalign`, ...).
 */
export function deriveWorktreeDbName(worktreeDir: string): string {
  const suffix = basename(worktreeDir)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const budget = MAX_DB_NAME_LENGTH - PREFIX.length;
  return PREFIX + (suffix || "worktree").slice(0, budget);
}

/**
 * Best-effort lookup of the container publishing `port`, for the error
 * message's `docker exec` snippet. Never throws and never hangs — this only
 * runs on the already-failing contention path, where the developer is waiting
 * on an error message, and an unresponsive docker daemon must not hold that up.
 * A wrong or missing container name just makes the suggested command need a
 * manual edit.
 */
export function findContainerName(port: string): string {
  try {
    const out = execFileSync(
      "docker",
      ["ps", "--filter", `publish=${port}`, "--format", "{{.Names}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 },
    ).trim();
    return out.split("\n")[0]?.trim() || "<postgres-container>";
  } catch {
    return "<postgres-container>";
  }
}

/**
 * Everything this file can go wrong with is non-fatal by design — a missing
 * database, a dropped connection, a failed unlock. None of them should fail a
 * run, but silently swallowing them leaves no thread to pull on when something
 * genuinely is odd, so they go here. `DEBUG` is not used elsewhere in this
 * repo; it is just the least surprising name for an opt-in diagnostic.
 */
function debugLog(...args: unknown[]): void {
  if (process.env.DEBUG) console.debug("[global-setup]", ...args);
}

export function buildContentionMessage(opts: {
  host: string;
  port: string;
  database: string;
  containerName: string;
  worktreeDbName: string;
}): string {
  const { host, port, database, containerName, worktreeDbName } = opts;
  return `Another checkout is running npm test against ${database} (${host}:${port}).

Wait for it to finish, or give this worktree its own database:

  docker exec ${containerName} psql -U authgd -d postgres \\
    -c "CREATE DATABASE ${worktreeDbName} OWNER authgd;"
  export TEST_DATABASE_URL=postgres://authgd:authgd@${host}:${port}/${worktreeDbName}

See docs/ops.md — "npm test cannot touch your dev database".`;
}

/** Vitest global setup / teardown. Runs once in the runner process. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const url = new URL(TEST_URL);
  // Some networks (and this sandbox's loopback, empirically) silently drop
  // packets to a closed/unreachable port instead of sending RST, so pg's
  // default of no connection timeout would hang the whole run rather than
  // failing open. A few seconds is generous for a real local Postgres.
  const client = new Client({
    connectionString: TEST_URL,
    connectionTimeoutMillis: 3000,
  });

  // This client is held open and idle for the whole run — ~70s for the full
  // suite — so it is far more exposed than a borrowed pool client to the
  // database going away mid-run (Postgres restarted, laptop slept). Without a
  // listener, node-postgres emits `error` as an *unhandled* event and takes
  // the process down with it, losing an otherwise-green run to a stack trace.
  // Nothing is lost by ignoring it: the advisory lock releases itself when the
  // connection dies, which is the entire reason this design needs no
  // stale-lock handling. `src/worker/index.ts` and `tests/worker-queues.test.ts`
  // attach the same guard to their long-lived pg-boss connections.
  client.on("error", (err) => debugLog("lost the connection holding the lock:", err));

  try {
    await client.connect();
  } catch (err) {
    // Fail open: a large share of the suite never touches the database at all
    // and must keep passing with Postgres down entirely. A connection failure
    // here is not this lock's problem to report — whatever DB code the test
    // itself exercises will surface its own error.
    debugLog("could not connect for advisory lock:", err);
    return async () => {};
  }

  const {
    rows: [{ pg_try_advisory_lock: acquired }],
  } = await client.query<{ pg_try_advisory_lock: boolean }>(
    "SELECT pg_try_advisory_lock($1)",
    [LOCK_KEY.toString()],
  );

  if (!acquired) {
    await client.end();
    const host = url.hostname;
    const port = url.port || "5432";
    const database = url.pathname.replace(/^\//, "");
    throw new Error(
      buildContentionMessage({
        host,
        port,
        database,
        containerName: findContainerName(port),
        worktreeDbName: deriveWorktreeDbName(process.cwd()),
      }),
    );
  }

  // Session-scoped advisory locks are held for the life of this connection
  // and released automatically if the process dies abnormally — no
  // stale-lock cleanup is needed. This teardown handles the normal-exit case,
  // and swallows its own failures: vitest awaits it outside the batch it
  // settles, so a throw here reports a fully green run as a startup error.
  // Releasing a lock that the dead connection already released is not worth
  // failing a suite over.
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY.toString()]);
      await client.end();
    } catch (err) {
      debugLog("could not release the advisory lock:", err);
    }
  };
}

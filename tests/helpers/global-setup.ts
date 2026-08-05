import { execFileSync } from "node:child_process";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Client } from "pg";
import { TEST_URL } from "./db";
import { deriveWorktreeDbName, OWNS_TEST_DB } from "./test-db-url";

/**
 * Vitest `globalSetup`: take a session-scoped advisory lock on the test
 * database for the lifetime of the run, so two checkouts running `npm test`
 * against the same `authgd_test` fail fast instead of TRUNCATEing each
 * other's rows mid-test (docs/ops.md, "npm test cannot touch your dev
 * database"). Without this, the symptom is assertion failures that move
 * around between runs — indistinguishable from a real regression.
 *
 * `npm test` now defaults to a database derived from the worktree path
 * (`tests/helpers/test-db-url.ts`), so this contention case is mostly
 * confined to CI's shared `authgd_test` and to anyone using the explicit
 * `TEST_DATABASE_URL` escape hatch to point multiple checkouts at the same
 * database on purpose. See
 * docs/superpowers/specs/2026-08-05-per-worktree-unit-test-db-design.md for
 * why per-worktree isolation was reversed from an earlier "deliberately not"
 * stance.
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

/** Postgres error codes we treat as expected rather than exceptional. */
const UNDEFINED_DATABASE = "3D000"; // invalid_catalog_name
const DUPLICATE_DATABASE = "42P04"; // lost a create race with a sibling run

export function hasCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

/**
 * Connects to the `postgres` maintenance database on the same server and
 * creates this worktree's database.
 *
 * Returns false rather than throwing on every failure: the caller falls open,
 * and a developer with Postgres down must still be able to run the large share
 * of the suite that never touches it. The same 3s connect timeout as the main
 * client — without it an unreachable port hangs the whole run instead of
 * failing, because this sandbox's loopback drops packets rather than sending RST.
 */
async function createDatabase(url: URL): Promise<boolean> {
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const admin = new Client({
    host: url.hostname,
    port: Number(url.port || "5432"),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: "postgres",
    connectionTimeoutMillis: 3000,
  });
  admin.on("error", (err) => debugLog("maintenance connection error:", err));
  try {
    await admin.connect();
    // Identifier, not a value — it cannot be a bound parameter. The name comes
    // from deriveWorktreeDbName, which emits only [a-z0-9_], so quoting it is
    // belt-and-braces rather than the only defence.
    await admin.query(`CREATE DATABASE "${name}" OWNER authgd`);
    debugLog(`created ${name}`);
    return true;
  } catch (err) {
    // A sibling run in this same worktree got there first. That is the goal
    // state; the advisory lock below handles the concurrency it implies.
    if (hasCode(err, DUPLICATE_DATABASE)) return true;
    debugLog("could not create the test database:", err);
    return false;
  } finally {
    try {
      await admin.end();
    } catch (err) {
      debugLog("could not close the maintenance connection:", err);
    }
  }
}

/**
 * This client is held open and idle for the whole run — ~70s for the full
 * suite — so it is far more exposed than a borrowed pool client to the
 * database going away mid-run (Postgres restarted, laptop slept). Without a
 * listener, node-postgres emits `error` as an *unhandled* event and takes
 * the process down with it, losing an otherwise-green run to a stack trace.
 * Nothing is lost by ignoring it: the advisory lock releases itself when the
 * connection dies, which is the entire reason this design needs no
 * stale-lock handling. `src/worker/index.ts` and `tests/worker-queues.test.ts`
 * attach the same guard to their long-lived pg-boss connections.
 */
function newClient(): Client {
  const client = new Client({
    connectionString: TEST_URL,
    connectionTimeoutMillis: 3000,
  });
  client.on("error", (err) => debugLog("lost the connection holding the lock:", err));
  return client;
}

/**
 * Connects, creating this worktree's database first if it does not exist yet.
 * Returns null when the run should fail open.
 */
async function connectOrCreate(url: URL): Promise<Client | null> {
  const client = newClient();
  try {
    await client.connect();
    return client;
  } catch (err) {
    if (!hasCode(err, UNDEFINED_DATABASE) || !OWNS_TEST_DB) {
      debugLog("could not connect for advisory lock:", err);
      return null;
    }
  }
  if (!(await createDatabase(url))) return null;

  const retry = newClient();
  try {
    await retry.connect();
    return retry;
  } catch (err) {
    debugLog("could not connect after creating the database:", err);
    return null;
  }
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

/**
 * Migration hashes applied in the database that this checkout's journal does
 * not contain.
 *
 * `readMigrationFiles` produces exactly the `sha256(fileContents)` that the
 * migrator writes into `drizzle.__drizzle_migrations.hash`, so set membership
 * is an exact comparison rather than a heuristic.
 *
 * Deliberately one-directional. Expected-but-unapplied migrations are the
 * normal case — `setupTestDb()` calls `migrate()` and they get applied. Only
 * the reverse is unrecoverable: the migrator applies journal entries newer than
 * the newest applied one, so a database migrated *ahead* looks identical to one
 * that is current, and nothing repairs it.
 */
export function findForeignMigrations(applied: string[], expected: string[]): string[] {
  const known = new Set(expected);
  return applied.filter((hash) => !known.has(hash));
}

export function buildSchemaDriftMessage(opts: {
  database: string;
  host: string;
  port: string;
  appliedCount: number;
  expectedCount: number;
  foreignCount: number;
  owned: boolean;
  containerName: string;
}): string {
  const {
    database,
    host,
    port,
    appliedCount,
    expectedCount,
    foreignCount,
    owned,
    containerName,
  } = opts;

  // A database this worktree owns is cheap to throw away, so that is the whole
  // fix. One it does not own may be CI's or a colleague's; dropping it is the
  // fallback, never the headline.
  const fix = owned
    ? `Recreate this worktree's database:

  npm run test:clean && npm test`
    : `Unset TEST_DATABASE_URL to use this worktree's own database, or recreate this one:

  docker exec ${containerName} psql -U authgd -d postgres \\
    -c "DROP DATABASE ${database};" -c "CREATE DATABASE ${database} OWNER authgd;"`;

  return `${database} (${host}:${port}) has ${foreignCount} migration(s) this checkout does not have (${appliedCount} applied, ${expectedCount} in drizzle/).

Another checkout migrated it further than this one goes. Drizzle only applies
migrations newer than the newest applied one, so it cannot repair this — the
suite would run against the wrong schema and fail in ways that look like real
regressions.

${fix}

See docs/ops.md — "npm test cannot touch your dev database".`;
}

/**
 * Throws when the database has migrations this checkout does not.
 *
 * Every way of *not knowing* falls open — an unreadable journal or a database
 * with no migration history yet are both ordinary (a brand-new database has no
 * `drizzle` schema until `setupTestDb()` migrates it). Only a confirmed foreign
 * hash is worth failing a run over.
 *
 * Exported for `tests/schema-drift.test.ts`, which drives it against a real
 * connection — the SQL string, the query-failure catch, and the argument
 * order passed to `findForeignMigrations` are only exercised end-to-end there,
 * not by the pure-function unit tests above.
 */
export async function assertNoSchemaDrift(client: Client, url: URL): Promise<void> {
  let expected: string[];
  try {
    expected = readMigrationFiles({ migrationsFolder: "drizzle" }).map((m) => m.hash);
  } catch (err) {
    debugLog("could not read the migration journal:", err);
    return;
  }

  let applied: string[];
  try {
    const { rows } = await client.query<{ hash: string }>(
      "SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at",
    );
    applied = rows.map((row) => row.hash);
  } catch (err) {
    debugLog("no migration history to compare against:", err);
    return;
  }

  const foreign = findForeignMigrations(applied, expected);
  if (foreign.length === 0) return;

  const port = url.port || "5432";
  throw new Error(
    buildSchemaDriftMessage({
      // Matches buildContentionMessage's derivation below: url.pathname is
      // never percent-escaped by our own database names (test-db-url.ts emits
      // only [a-z0-9_]), and decodeURIComponent can throw on a malformed
      // TEST_DATABASE_URL, which would replace this diagnosis with "URI
      // malformed" instead of delivering it.
      database: url.pathname.replace(/^\//, ""),
      host: url.hostname,
      port,
      appliedCount: applied.length,
      expectedCount: expected.length,
      foreignCount: foreign.length,
      owned: OWNS_TEST_DB,
      containerName: findContainerName(port),
    }),
  );
}

/** Vitest global setup / teardown. Runs once in the runner process. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const url = new URL(TEST_URL);
  // Some networks (and this sandbox's loopback, empirically) silently drop
  // packets to a closed/unreachable port instead of sending RST, so pg's
  // default of no connection timeout would hang the whole run rather than
  // failing open. A few seconds is generous for a real local Postgres.
  const client = await connectOrCreate(url);
  // Fail open: a large share of the suite never touches the database at all and
  // must keep passing with Postgres down entirely. A connection failure here is
  // not this lock's problem to report — whatever DB code the test itself
  // exercises will surface its own error.
  if (!client) return async () => {};

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

  // Runs holding the lock, so a second run reports contention (the more urgent
  // problem) rather than racing this check. Release before throwing: the
  // teardown below never runs when globalSetup throws.
  try {
    await assertNoSchemaDrift(client, url);
  } catch (err) {
    await client.end();
    throw err;
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

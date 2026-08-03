import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";

/**
 * The one place the e2e harness decides *which port* and *which database* a run
 * uses.
 *
 * Both halves of the harness import from here:
 *
 *   - `playwright.config.ts` — configures the dev server (its port, and the
 *     `DATABASE_URL` it reads through).
 *   - `e2e/helpers.ts` — connects the *test* process to the database it seeds,
 *     and mints session cookies scoped to the server's origin.
 *
 * They used to hold independent copies of both values. Overriding one and not
 * the other seeded one database while the pages read another, which surfaces as
 * every assertion failing on missing content — indistinguishable from a real
 * regression. Deriving both here makes that state unrepresentable.
 */

/** Worktree root: the parent of this file's directory. */
export const WORKTREE_ROOT = dirname(__dirname);

export const IS_CI = !!process.env.CI;

/**
 * False inside a Playwright worker process.
 *
 * Playwright re-imports `playwright.config.ts` in every worker, so anything
 * with a side effect at module load runs once per worker as well as once in the
 * runner. Provisioning and the port guard are both runner-only: two processes
 * migrating the same database concurrently fails on `CREATE SCHEMA`, and a
 * worker evaluating the port guard could kill the very server it is about to
 * test against.
 */
export const IS_RUNNER = process.env.TEST_WORKER_INDEX === undefined;

/**
 * A port that is stable for a given worktree and (almost always) different
 * between worktrees.
 *
 * Keying on the absolute worktree path rather than a counter or a random value
 * gives the two properties that matter together: repeated runs in one worktree
 * reuse the same port and the same container, while two worktrees checked out
 * side by side do not collide. `salt` separates the app port from the database
 * port so they cannot derive the same number.
 *
 * Collisions are possible (two paths can hash into one slot). They are not
 * silent: `playwright.config.ts` refuses to run against a server it cannot
 * prove is its own, and provisioning fails loudly if the database port is held
 * by something else. Both messages name the override to set.
 */
function portFor(salt: string, base: number, span: number): number {
  const digest = createHash("sha256").update(`${salt}\0${WORKTREE_ROOT}`).digest();
  return base + (digest.readUInt16BE(0) % span);
}

/**
 * Short, filesystem-safe worktree identifier used to name the Postgres
 * container. The hash suffix keeps two worktrees whose directories share a
 * basename (`.../a/authGD` and `.../b/authGD`) from claiming the same one.
 */
export const WORKTREE_SLUG = `${basename(WORKTREE_ROOT)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 24)}-${createHash("sha256").update(WORKTREE_ROOT).digest("hex").slice(0, 6)}`;

/**
 * Reads a port override, or falls back to the derived default when unset.
 *
 * A malformed override throws rather than falling back. Silently substituting
 * the derived port for `E2E_PORT=311l` would put the run on a port the operator
 * did not ask for — and they set the override precisely because the default was
 * wrong for them, so the fallback is the one outcome guaranteed to be unhelpful.
 */
function portOverride(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `[e2e] ${name}=${JSON.stringify(raw)} is not a valid port. ` +
        `Set an integer between 1 and 65535, or unset it to use the ` +
        `port derived from this worktree (${fallback}).`,
    );
  }
  return port;
}

/** Dev server port. `E2E_PORT` overrides, e.g. to dodge a hash collision. */
export const APP_PORT = portOverride("E2E_PORT", portFor("app", 3200, 400));

export const BASE_URL = `http://localhost:${APP_PORT}`;

/** Host port for the per-worktree Postgres container. `E2E_DB_PORT` overrides. */
export const DB_PORT = portOverride("E2E_DB_PORT", portFor("db", 5600, 300));

export const CONTAINER_NAME = `authgd-e2e-${WORKTREE_SLUG}`;

/**
 * The database URL both halves of the harness use.
 *
 * Precedence, and why:
 *
 *   1. An explicit `TEST_DATABASE_URL` always wins — it is the documented
 *      escape hatch, and setting it also disables provisioning.
 *   2. Under CI, the historical shared default. `.github/workflows/ci.yml`
 *      stands up a Postgres *service* on host 5433 and deliberately sets no
 *      override, so this value must stay exactly what it has always been.
 *   3. Otherwise, this worktree's own container.
 *
 * Rule 2 is load-bearing: making the per-worktree URL the unconditional default
 * would leave CI pointing at a database no one started.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  (IS_CI
    ? "postgres://authgd:authgd@localhost:5433/authgd_test"
    : `postgres://authgd:authgd@localhost:${DB_PORT}/authgd_test`);

/** True when this run is responsible for standing up its own database. */
export const SHOULD_PROVISION = IS_RUNNER && !IS_CI && !process.env.TEST_DATABASE_URL;

/**
 * Environment marker `playwright.config.ts` puts into the dev server it starts,
 * so the guard can later prove a process on this port is one the harness owns.
 *
 * A matching cwd is not proof: a developer's own `next dev -p <APP_PORT>` in
 * this worktree looks identical through /proc. The guard restarts servers it
 * owns, and restarting means SIGTERM — so ownership has to be conclusive, not
 * inferred.
 */
export const MANAGED_ENV_KEY = "E2E_MANAGED_WORKTREE";

import { createHash } from "node:crypto";
import { basename } from "node:path";

/**
 * Which database `npm test` uses, and what it may create or drop.
 *
 * Deliberately free of any import beyond node builtins — no Drizzle, no `@/`
 * path alias. `scripts/drop-test-db.ts` runs under `tsx` and vitest's
 * `globalSetup` runs before the alias plugin applies to helper modules, so
 * anything heavier here would break one caller or the other.
 */

const MAX_DB_NAME_LENGTH = 63;
const PREFIX = "authgd_test_";
const HASH_LENGTH = 6;

/** Credentials and host are fixed by docker-compose.dev.yml and CI alike. */
const TEST_DB_ORIGIN = "postgres://authgd:authgd@localhost:5433";

/**
 * The historical shared database. CI stands up a Postgres service on host 5433
 * and deliberately sets no override, so this value must stay exactly what it
 * has always been.
 */
export const SHARED_TEST_URL = `${TEST_DB_ORIGIN}/authgd_test`;

/**
 * Turns a worktree directory into a legal, unquoted Postgres identifier:
 * lowercase, non `[a-z0-9_]` collapsed to a single `_`, and capped at
 * Postgres's 63-byte limit.
 *
 * The 6-char digest of the *absolute* path is what makes the name unique.
 * `basename` alone collides for `.../a/authGD` and `.../b/authGD`, which would
 * silently reintroduce the shared-database bug this naming exists to prevent.
 * `e2e/env.ts` (WORKTREE_SLUG) hashes for the same reason.
 */
export function deriveWorktreeDbName(worktreeDir: string): string {
  const suffix = basename(worktreeDir)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const hash = createHash("sha256")
    .update(worktreeDir)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  // PREFIX + suffix + "_" + hash must fit in 63 bytes.
  const budget = MAX_DB_NAME_LENGTH - PREFIX.length - HASH_LENGTH - 1;
  return `${PREFIX}${(suffix || "worktree").slice(0, budget)}_${hash}`;
}

/**
 * True when the database name was derived by us, and is therefore ours to
 * create and to drop. An explicit `TEST_DATABASE_URL` means the developer is
 * managing that database; CI's is created by the workflow's service container.
 * Neither is ours to touch.
 *
 * Takes `Partial<NodeJS.ProcessEnv>` rather than `NodeJS.ProcessEnv` because
 * Next.js augments the global `ProcessEnv` to require `NODE_ENV`, which would
 * otherwise force every test call site to fabricate one.
 */
export function ownsTestDatabase(env: Partial<NodeJS.ProcessEnv>): boolean {
  return !env.TEST_DATABASE_URL && !env.CI;
}

/**
 * Precedence, and why:
 *
 *   1. An explicit `TEST_DATABASE_URL` always wins — the documented escape
 *      hatch, and it also opts out of creation and cleanup.
 *   2. Under CI, the historical shared database. `.github/workflows/ci.yml`
 *      stands up a Postgres service on host 5433 and sets no override, so this
 *      must stay exactly what it has always been.
 *   3. Otherwise, a database private to this worktree.
 *
 * Rule 2 is load-bearing: making the per-worktree URL unconditional would point
 * CI at a database no one creates. `e2e/env.ts` resolves its URL the same way.
 */
export function resolveTestUrl(env: Partial<NodeJS.ProcessEnv>, cwd: string): string {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  if (env.CI) return SHARED_TEST_URL;
  return `${TEST_DB_ORIGIN}/${deriveWorktreeDbName(cwd)}`;
}

export const TEST_URL = resolveTestUrl(process.env, process.cwd());

/** True when this run may create and drop its own database. */
export const OWNS_TEST_DB = ownsTestDatabase(process.env);

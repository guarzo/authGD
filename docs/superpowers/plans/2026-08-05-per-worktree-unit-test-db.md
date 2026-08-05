# Per-worktree unit test database + drift detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each worktree its own unit-test database by default, and refuse to run against any database migrated ahead of the checkout, so environmental breakage surfaces as one line instead of hundreds of false failures.

**Architecture:** A new dependency-free module `tests/helpers/test-db-url.ts` owns the naming and URL precedence rules; `tests/helpers/db.ts` re-exports `TEST_URL` so the 34 files importing it are untouched. `tests/helpers/global-setup.ts` creates the database on first run, then compares applied migration hashes against the checkout's journal and throws a single actionable error on divergence. All new logic is expressed as pure functions so it is testable in the existing harness.

**Tech Stack:** TypeScript, Vitest (`globalSetup`), `pg` (`Client`), Drizzle ORM (`readMigrationFiles` from `drizzle-orm/migrator`), Postgres 16.

**Spec:** `docs/superpowers/specs/2026-08-05-per-worktree-unit-test-db-design.md`

## File Structure

| File | Responsibility |
|---|---|
| `tests/helpers/test-db-url.ts` (new) | Derive the database name; resolve URL precedence; decide ownership. Imports only `node:crypto` and `node:path` — **no `@/` alias, no Drizzle** — so `scripts/` and `globalSetup` can both import it under `tsx` and Vitest alike. |
| `tests/helpers/db.ts` | Unchanged responsibility (connect, migrate, truncate). Re-exports `TEST_URL` so its 34 consumers need no edit. |
| `tests/helpers/global-setup.ts` | Advisory lock (existing), database creation, drift detection. |
| `scripts/drop-test-db.ts` (new) | Reclaim this worktree's database. |

## Global Constraints

- CI must keep resolving to `postgres://authgd:authgd@localhost:5433/authgd_test`. `.github/workflows/ci.yml` sets no `TEST_DATABASE_URL` and stands up a Postgres service on host 5433.
- An explicit `TEST_DATABASE_URL` always wins over everything else.
- Fail open on every database error. A large share of the suite never touches Postgres and must pass with the database down entirely (`global-setup.ts:131`). Only a confirmed foreign migration hash may throw.
- Never auto-create or auto-drop a database whose name we did not derive.
- Derive paths from `process.cwd()`, consistent with the existing cwd-relative `migrationsFolder: "drizzle"` at `db.ts:16`. Do not introduce `__dirname` (unreliable under Vitest's ESM transform).
- Postgres identifiers cap at 63 bytes.
- Error codes used: `3D000` `invalid_catalog_name`, `42P04` `duplicate_database`.
- Run `npm run format:check` per task, not only at the end.

---

### Task 1: Hash-suffixed database naming, relocated to `db.ts`

`deriveWorktreeDbName` keys on `basename` alone, so `~/a/authGD` and `~/b/authGD` collide. Add a 6-char path hash, mirroring `WORKTREE_SLUG` (`e2e/env.ts:63`). It moves out of `global-setup.ts` into a new dependency-free module: `global-setup.ts` imports `TEST_URL` from `db.ts`, so `db.ts` cannot import back without a cycle, and `scripts/` must be able to import the naming rule without pulling in Drizzle or the `@/` alias.

**Files:**
- Create: `tests/helpers/test-db-url.ts`
- Modify: `tests/helpers/db.ts`
- Modify: `tests/helpers/global-setup.ts:35-52` (remove derivation, import it instead)
- Test: `tests/global-setup.test.ts:1-49`

**Interfaces:**
- Consumes: nothing.
- Produces: `deriveWorktreeDbName(worktreeDir: string): string` and `SHARED_TEST_URL: string`, exported from `tests/helpers/test-db-url.ts`.

- [ ] **Step 1: Write the failing tests**

Replace the `deriveWorktreeDbName` import in `tests/global-setup.test.ts:2` with:

```ts
import { buildContentionMessage } from "./helpers/global-setup";
import { deriveWorktreeDbName } from "./helpers/test-db-url";
```

Replace the whole `describe("deriveWorktreeDbName", ...)` block (lines 4-49) with:

```ts
describe("deriveWorktreeDbName", () => {
  const HASH = /_[0-9a-f]{6}$/;

  it("lowercases and keeps the authgd_test_ prefix", () => {
    expect(deriveWorktreeDbName("/home/tng/workspace/authGD")).toMatch(
      /^authgd_test_authgd_[0-9a-f]{6}$/,
    );
  });

  it("collapses illegal characters to underscores", () => {
    expect(deriveWorktreeDbName("/worktrees/fix+account-page-mechanics")).toMatch(
      /^authgd_test_fix_account_page_mechanics_[0-9a-f]{6}$/,
    );
  });

  it("collapses runs of separators instead of leaving repeats", () => {
    expect(deriveWorktreeDbName("/worktrees/a---b")).toMatch(/^authgd_test_a_b_[0-9a-f]{6}$/);
  });

  it("trims leading and trailing separators produced by sanitizing", () => {
    expect(deriveWorktreeDbName("/worktrees/-leading-and-trailing-")).toMatch(
      /^authgd_test_leading_and_trailing_[0-9a-f]{6}$/,
    );
  });

  it("falls back to a placeholder if the basename sanitizes to nothing", () => {
    expect(deriveWorktreeDbName("/worktrees/---")).toMatch(
      /^authgd_test_worktree_[0-9a-f]{6}$/,
    );
  });

  // The reason the hash exists: two worktrees can share a basename.
  it("gives two worktrees with the same basename different databases", () => {
    const a = deriveWorktreeDbName("/home/tng/a/authGD");
    const b = deriveWorktreeDbName("/home/tng/b/authGD");
    expect(a).not.toBe(b);
    expect(a.replace(HASH, "")).toBe(b.replace(HASH, ""));
  });

  it("is stable for the same directory", () => {
    expect(deriveWorktreeDbName("/home/tng/a/authGD")).toBe(
      deriveWorktreeDbName("/home/tng/a/authGD"),
    );
  });

  it("caps the result at 63 characters with the hash still intact", () => {
    const name = deriveWorktreeDbName(`/worktrees/${"a".repeat(100)}`);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(HASH);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/global-setup.test.ts`
Expected: FAIL — cannot resolve `./helpers/test-db-url`.

- [ ] **Step 3: Implement**

Create `tests/helpers/test-db-url.ts`:

```ts
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
```

In `tests/helpers/db.ts`, replace lines 1-7 with:

```ts
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, type Db } from "@/db";
import { TRUNCATE_ALL_SQL } from "@/db/tables";
import { SHARED_TEST_URL } from "./test-db-url";

// Re-exported so the 34 test files that import TEST_URL from here keep working.
export const TEST_URL = process.env.TEST_DATABASE_URL ?? SHARED_TEST_URL;
```

Then in `tests/helpers/global-setup.ts`: delete lines 35-52 (the `MAX_DB_NAME_LENGTH` and `PREFIX` constants and the `deriveWorktreeDbName` function), and add alongside the existing `TEST_URL` import at line 4:

```ts
import { TEST_URL } from "./db";
import { deriveWorktreeDbName } from "./test-db-url";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/global-setup.test.ts`
Expected: PASS (all `deriveWorktreeDbName` and `buildContentionMessage` tests).

- [ ] **Step 5: Format, lint, typecheck, commit**

```bash
npm run format:check && npm run lint && npm run typecheck
git add tests/helpers/test-db-url.ts tests/helpers/db.ts tests/helpers/global-setup.ts tests/global-setup.test.ts
git commit -m "test: make the derived test database name collision-proof"
```

---

### Task 2: Resolve the default URL per-worktree

`TEST_URL` becomes a pure function of environment and cwd so all three precedence branches are testable without module-reset gymnastics.

**Files:**
- Modify: `tests/helpers/test-db-url.ts`
- Modify: `tests/helpers/db.ts`
- Test: `tests/global-setup.test.ts`

**Interfaces:**
- Consumes: `deriveWorktreeDbName`, `SHARED_TEST_URL` (Task 1).
- Produces: `resolveTestUrl(env: NodeJS.ProcessEnv, cwd: string): string`, `ownsTestDatabase(env: NodeJS.ProcessEnv): boolean`, `TEST_URL: string`, and `OWNS_TEST_DB: boolean`, all exported from `tests/helpers/test-db-url.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/global-setup.test.ts`:

```ts
describe("resolveTestUrl", () => {
  it("prefers an explicit TEST_DATABASE_URL over everything", () => {
    expect(
      resolveTestUrl(
        { TEST_DATABASE_URL: "postgres://u:p@example:5432/mine", CI: "true" },
        "/worktrees/x",
      ),
    ).toBe("postgres://u:p@example:5432/mine");
  });

  // CI stands up a shared Postgres service and sets no override. Changing this
  // would point CI at a database nothing creates.
  it("uses the historical shared database under CI", () => {
    expect(resolveTestUrl({ CI: "true" }, "/worktrees/x")).toBe(
      "postgres://authgd:authgd@localhost:5433/authgd_test",
    );
  });

  it("otherwise derives a database for this worktree", () => {
    expect(resolveTestUrl({}, "/worktrees/my-branch")).toMatch(
      /^postgres:\/\/authgd:authgd@localhost:5433\/authgd_test_my_branch_[0-9a-f]{6}$/,
    );
  });

  it("ignores an empty TEST_DATABASE_URL rather than connecting nowhere", () => {
    expect(resolveTestUrl({ TEST_DATABASE_URL: "" }, "/worktrees/x")).toMatch(
      /authgd_test_x_[0-9a-f]{6}$/,
    );
  });
});

describe("ownsTestDatabase", () => {
  it("owns the database it derived itself", () => {
    expect(ownsTestDatabase({})).toBe(true);
  });

  it("does not own a database named by TEST_DATABASE_URL", () => {
    expect(ownsTestDatabase({ TEST_DATABASE_URL: "postgres://u:p@h:1/d" })).toBe(false);
  });

  it("does not own CI's shared database", () => {
    expect(ownsTestDatabase({ CI: "true" })).toBe(false);
  });
});
```

Update the import to:

```ts
import {
  deriveWorktreeDbName,
  ownsTestDatabase,
  resolveTestUrl,
} from "./helpers/test-db-url";
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/global-setup.test.ts`
Expected: FAIL — `resolveTestUrl` is not exported.

- [ ] **Step 3: Implement**

Append to `tests/helpers/test-db-url.ts`:

```ts
/**
 * True when the database name was derived by us, and is therefore ours to
 * create and to drop. An explicit `TEST_DATABASE_URL` means the developer is
 * managing that database; CI's is created by the workflow's service container.
 * Neither is ours to touch.
 */
export function ownsTestDatabase(env: NodeJS.ProcessEnv): boolean {
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
export function resolveTestUrl(env: NodeJS.ProcessEnv, cwd: string): string {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;
  if (env.CI) return SHARED_TEST_URL;
  return `${TEST_DB_ORIGIN}/${deriveWorktreeDbName(cwd)}`;
}

export const TEST_URL = resolveTestUrl(process.env, process.cwd());

/** True when this run may create and drop its own database. */
export const OWNS_TEST_DB = ownsTestDatabase(process.env);
```

Then in `tests/helpers/db.ts`, replace the re-export line added in Task 1 with:

```ts
import { TEST_URL } from "./test-db-url";

// Re-exported so the 34 test files that import TEST_URL from here keep working.
export { TEST_URL };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/global-setup.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, lint, typecheck, commit**

```bash
npm run format:check && npm run lint && npm run typecheck
git add tests/helpers/test-db-url.ts tests/helpers/db.ts tests/global-setup.test.ts
git commit -m "test: default npm test to a per-worktree database"
```

---

### Task 3: Create the database on first run

The derived database does not exist yet. Create it from `globalSetup`, which already runs once per run and already holds a connection.

**Files:**
- Modify: `tests/helpers/global-setup.ts`

**Interfaces:**
- Consumes: `TEST_URL`, `OWNS_TEST_DB` (Task 2).
- Produces: nothing exported; `globalSetup` now connects to a database it may have just created.

- [ ] **Step 1: Implement the creation path**

In `tests/helpers/global-setup.ts`, add after the `debugLog` helper:

```ts
/** Postgres error codes we treat as expected rather than exceptional. */
const UNDEFINED_DATABASE = "3D000"; // invalid_catalog_name
const DUPLICATE_DATABASE = "42P04"; // lost a create race with a sibling run

function hasCode(err: unknown, code: string): boolean {
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

function newClient(): Client {
  const client = new Client({ connectionString: TEST_URL, connectionTimeoutMillis: 3000 });
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
```

Change the import at line 4 to include `OWNS_TEST_DB`:

```ts
import { TEST_URL } from "./db";
import { deriveWorktreeDbName, OWNS_TEST_DB } from "./test-db-url";
```

Then replace the body of `globalSetup` from the `const client = new Client({...})` declaration through the `try { await client.connect(); } catch { ... }` block with:

```ts
const client = await connectOrCreate(url);
// Fail open: a large share of the suite never touches the database at all and
// must keep passing with Postgres down entirely. A connection failure here is
// not this lock's problem to report — whatever DB code the test itself
// exercises will surface its own error.
if (!client) return async () => {};
```

Keep the long comments that documented the error listener and the fail-open decision by moving them onto `newClient` and this call site respectively; do not delete them.

- [ ] **Step 2: Verify the database is created**

```bash
docker exec payouts-phase-2-postgres-1 psql -U authgd -d postgres -c "\l" | grep authgd_test_ || echo "none yet"
npx vitest run tests/smoke.test.ts
docker exec payouts-phase-2-postgres-1 psql -U authgd -d postgres -c "\l" | grep authgd_test_
```

Expected: a database named `authgd_test_per_worktree_test_db_<hash>` exists after the run.

- [ ] **Step 3: Verify it still fails open with Postgres unreachable**

```bash
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:59999/nope npx vitest run tests/pricing.test.ts
```

Expected: PASS (10 tests). The suite must not hard-fail on an unreachable database.

- [ ] **Step 4: Full suite on the new database**

Run: `npm test`
Expected: 73 files / 945 tests passing, same as the recorded baseline.

- [ ] **Step 5: Format, lint, typecheck, commit**

```bash
npm run format:check && npm run lint && npm run typecheck
git add tests/helpers/global-setup.ts
git commit -m "test: create this worktree's test database on first run"
```

---

### Task 4: Detect a database migrated ahead of the checkout

The core fix. Drizzle applies only journal entries newer than the newest applied one, so a database migrated ahead is silently accepted and the suite fails with confusing errors instead.

**Files:**
- Modify: `tests/helpers/global-setup.ts`
- Test: `tests/global-setup.test.ts`

**Interfaces:**
- Consumes: `TEST_URL`, `OWNS_TEST_DB` (Task 2); `findContainerName`, `debugLog` (existing).
- Produces: `findForeignMigrations(applied: string[], expected: string[]): string[]` and `buildSchemaDriftMessage(opts): string`, both exported from `tests/helpers/global-setup.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/global-setup.test.ts`:

```ts
describe("findForeignMigrations", () => {
  // The reported bug: another checkout migrated this database further than the
  // journal here goes, and drizzle's migrator cannot see it.
  it("finds a hash the checkout's journal does not contain", () => {
    expect(findForeignMigrations(["a", "b", "c"], ["a", "b"])).toEqual(["c"]);
  });

  // The normal case. migrate() applies the rest; this must stay silent.
  it("stays quiet when the database is merely behind", () => {
    expect(findForeignMigrations(["a"], ["a", "b", "c"])).toEqual([]);
  });

  it("stays quiet when the database matches exactly", () => {
    expect(findForeignMigrations(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("stays quiet on a brand-new database with no history", () => {
    expect(findForeignMigrations([], ["a", "b"])).toEqual([]);
  });

  // Two branches that each added one migration have equal counts, so counting
  // rows would miss this entirely. Hashes catch it.
  it("catches divergence that equal counts would hide", () => {
    expect(findForeignMigrations(["a", "theirs"], ["a", "ours"])).toEqual(["theirs"]);
  });

  it("reports every foreign hash, not just the first", () => {
    expect(findForeignMigrations(["a", "x", "y"], ["a"])).toEqual(["x", "y"]);
  });
});

describe("buildSchemaDriftMessage", () => {
  it("points a worktree at test:clean, which recreates its own database", () => {
    const message = buildSchemaDriftMessage({
      database: "authgd_test_mine_a1b2c3",
      host: "localhost",
      port: "5433",
      appliedCount: 8,
      expectedCount: 7,
      foreignCount: 1,
      owned: true,
      containerName: "authgd-dev-postgres-1",
    });

    expect(message).toContain("authgd_test_mine_a1b2c3 (localhost:5433)");
    expect(message).toContain("8 applied");
    expect(message).toContain("7 in drizzle/");
    expect(message).toContain("npm run test:clean");
    expect(message).toContain("docs/ops.md");
  });

  // A database we do not own must never be handed a drop command as step one.
  it("tells an unowned database to unset the override first", () => {
    const message = buildSchemaDriftMessage({
      database: "authgd_test",
      host: "localhost",
      port: "5433",
      appliedCount: 8,
      expectedCount: 7,
      foreignCount: 1,
      owned: false,
      containerName: "authgd-dev-postgres-1",
    });

    expect(message).toContain("Unset TEST_DATABASE_URL");
    expect(message).not.toContain("npm run test:clean");
    expect(message).toContain("DROP DATABASE authgd_test");
  });
});
```

Add to the `./helpers/global-setup` import:

```ts
import {
  buildContentionMessage,
  buildSchemaDriftMessage,
  findForeignMigrations,
} from "./helpers/global-setup";
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/global-setup.test.ts`
Expected: FAIL — `findForeignMigrations` is not exported.

- [ ] **Step 3: Implement**

Add to the top of `tests/helpers/global-setup.ts`:

```ts
import { readMigrationFiles } from "drizzle-orm/migrator";
```

Add after `buildContentionMessage`:

```ts
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
```

Then add the check function:

```ts
/**
 * Throws when the database has migrations this checkout does not.
 *
 * Every way of *not knowing* falls open — an unreadable journal or a database
 * with no migration history yet are both ordinary (a brand-new database has no
 * `drizzle` schema until `setupTestDb()` migrates it). Only a confirmed foreign
 * hash is worth failing a run over.
 */
async function assertNoSchemaDrift(client: Client, url: URL): Promise<void> {
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
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
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
```

Wire it into `globalSetup` immediately after the advisory lock is acquired — after the `if (!acquired) { ... }` block and before the teardown `return`:

```ts
  // Runs holding the lock, so a second run reports contention (the more urgent
  // problem) rather than racing this check. Release before throwing: the
  // teardown below never runs when globalSetup throws.
  try {
    await assertNoSchemaDrift(client, url);
  } catch (err) {
    await client.end();
    throw err;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/global-setup.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify it fires on a genuinely drifted database**

The shared `authgd_test` is at `origin/main`; a checkout behind it will diverge. Confirm the real path end-to-end:

```bash
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test npx vitest run tests/smoke.test.ts
```

Expected on a checkout whose journal differs from the shared database: one error naming the database, the counts, and `Unset TEST_DATABASE_URL`. If this checkout matches the shared database, the run passes instead — record which happened, and do not treat a pass as evidence the check works.

- [ ] **Step 6: Format, lint, typecheck, commit**

```bash
npm run format:check && npm run lint && npm run typecheck
git add tests/helpers/global-setup.ts tests/global-setup.test.ts
git commit -m "test: refuse to run against a database migrated ahead of the checkout"
```

---

### Task 5: `npm run test:clean`

Worktrees get deleted; their databases do not. This is the reclaim path, and the fix the drift message points at.

**Files:**
- Create: `scripts/drop-test-db.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `deriveWorktreeDbName`, `OWNS_TEST_DB`, `TEST_URL` (Tasks 1-2), all from `tests/helpers/test-db-url.ts`. Importing that module rather than `db.ts` is deliberate: `db.ts` pulls in Drizzle through the `@/` path alias, which `tsx` does not resolve for standalone scripts.
- Produces: the `test:clean` npm script.

- [ ] **Step 1: Write the script**

Create `scripts/drop-test-db.ts`:

```ts
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
 * the developer's own, and CI's shared database belongs to the workflow.
 */
const PROTECTED = new Set(["authgd", "authgd_test", "postgres", "template0", "template1"]);

async function main(): Promise<void> {
  if (!OWNS_TEST_DB) {
    console.log(
      "TEST_DATABASE_URL or CI is set, so npm test is not using a database of " +
        "its own. Nothing to clean.",
    );
    return;
  }

  const name = deriveWorktreeDbName(process.cwd());
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

main().catch((err) => {
  console.error(`could not drop this worktree's test database: ${err.message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add the npm script**

In `package.json`, add directly after the `"test:watch"` entry:

```json
    "test:clean": "tsx scripts/drop-test-db.ts",
```

- [ ] **Step 3: Verify it drops and is idempotent**

```bash
npm test -- tests/smoke.test.ts
docker exec payouts-phase-2-postgres-1 psql -U authgd -d postgres -c "\l" | grep authgd_test_
npm run test:clean
docker exec payouts-phase-2-postgres-1 psql -U authgd -d postgres -c "\l" | grep authgd_test_ || echo "gone"
npm run test:clean
```

Expected: first `test:clean` prints `dropped authgd_test_...`; the database is gone; the second run prints the same line without error (`IF EXISTS`).

- [ ] **Step 4: Verify it refuses a database it does not own**

```bash
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test npm run test:clean
CI=true npm run test:clean
```

Expected: both print "Nothing to clean" and exit 0. Confirm `authgd_test` still exists afterwards.

- [ ] **Step 5: Verify the suite still rebuilds from nothing**

Run: `npm test`
Expected: 73 files / 945 tests passing, having recreated and migrated the database from scratch.

- [ ] **Step 6: Format, lint, typecheck, commit**

```bash
npm run format:check && npm run lint && npm run typecheck
git add scripts/drop-test-db.ts package.json
git commit -m "test: add npm run test:clean to reclaim a worktree's test database"
```

---

### Task 6: Update the operations documentation

`docs/ops.md` states in two places that `npm test` uses one shared database. That is the central claim of its section and it is now wrong.

**Files:**
- Modify: `docs/ops.md` (section "`npm test` cannot touch your dev database", around lines 476-525; and the troubleshooting item around line 769)

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: Rewrite the main section**

Replace the table and the two paragraphs following it (from `docker-compose.dev.yml` starts **one** Postgres... through the `TEST_DATABASE_URL=... npm test` code block) with:

```markdown
`docker-compose.dev.yml` starts **one** Postgres hosting your dev database plus
a test database per worktree:

| Database | Used by | Destructive operations |
|---|---|---|
| `authgd` | `npm run dev`, `npm run worker`, `npm run db:migrate` | none automatic |
| `authgd_test_<worktree>_<hash>` | `npm test` in that worktree | `TRUNCATE` between every test |
| `authgd_test` | `npm test` under CI only | `TRUNCATE` between every test |

`npm test` derives its database name from the worktree directory
(`tests/helpers/db.ts`), creates it on first run, and migrates it. Two worktrees
therefore never share a database, and the `TRUNCATE ... CASCADE` the suite runs
between tests physically cannot reach `authgd`. Run the tests freely.

Nothing reclaims these databases when a worktree is deleted, so:

```bash
npm run test:clean        # drop this worktree's test database
```

**Under CI the shared `authgd_test` is still used**, because the workflow stands
up its own Postgres service and sets no override. An explicit
`TEST_DATABASE_URL` also wins over the derived name, and opts that database out
of both creation and `test:clean` — it is yours, not the harness's.

**Two `npm test` runs at once used to fight** when every checkout shared one
database. Per-worktree databases remove that for the normal case, and
`tests/helpers/global-setup.ts` still takes a session-scoped
`pg_try_advisory_lock` for the cases that remain — CI, an explicit shared
`TEST_DATABASE_URL`, or two runs in the same worktree.

**A database migrated by a different checkout is refused.** Drizzle applies only
migrations newer than the newest applied one, so a database migrated *ahead* of
your checkout looks up-to-date to the migrator, and the suite fails against the
wrong schema with errors that look like real regressions (`22P02` on an enum
value that no longer exists, typically). `global-setup.ts` compares applied
migration hashes against `drizzle/` and fails the run with one message instead.
The fix is `npm run test:clean`.

If Postgres is not reachable at all, every one of these checks falls open rather
than blocking the suite: plenty of test files never touch the database and must
keep working with Postgres down.
```

- [ ] **Step 2: Fix the troubleshooting item**

The item beginning "**The `authgd_test` database exists** — it is created only by" now applies to CI only. Replace that item with:

```markdown
3. **The test database exists** — `npm test` creates its own per worktree, so
   this is only a concern under CI or with an explicit `TEST_DATABASE_URL`.
   List them with:

   ```bash
   docker exec <container> psql -U authgd -lqt | cut -d'|' -f1 | grep authgd_test
   ```
```

- [ ] **Step 3: Update the override table**

In the overrides table of the e2e section, leave the e2e rows unchanged. Confirm by reading the section that no remaining sentence claims `npm test` uses a shared database by default.

- [ ] **Step 4: Verify formatting and commit**

```bash
npm run format:check
git add docs/ops.md
git commit -m "docs: npm test now uses a per-worktree database"
```

---

### Task 7: Full verification

- [ ] **Step 1: Unit suite from a clean slate**

```bash
npm run test:clean
npm test
```
Expected: 73 files / 945 tests passing (baseline: 945 passed, 98.65s).

- [ ] **Step 2: CI resolution unchanged**

```bash
npx tsx -e "import {resolveTestUrl} from './tests/helpers/test-db-url'; \
  console.log('ci      :', resolveTestUrl({CI:'true'}, process.cwd())); \
  console.log('explicit:', resolveTestUrl({TEST_DATABASE_URL:'postgres://u:p@h:1/d'}, process.cwd())); \
  console.log('derived :', resolveTestUrl({}, process.cwd()))"
```

Expected:

```
ci      : postgres://authgd:authgd@localhost:5433/authgd_test
explicit: postgres://u:p@h:1/d
derived : postgres://authgd:authgd@localhost:5433/authgd_test_per_worktree_test_db_<hash>
```

- [ ] **Step 3: Static checks**

```bash
npm run typecheck && npm run lint && npm run format:check
```
Expected: all clean.

- [ ] **Step 4: e2e unaffected**

```bash
npm run test:e2e
```
Expected: passing. Nothing the e2e harness reads is in this diff; this run confirms that rather than validating a change. Afterwards check `git status` — `tsconfig.json` and `AGENTS.md` are rewritten by `next dev` and must be restored with `git checkout`, never deleted.

- [ ] **Step 5: Final diff review**

```bash
git diff main...HEAD
```
Confirm: no debug output, no placeholders, no unrelated files, and that the long explanatory comments in `global-setup.ts` survived the restructuring in Task 3.

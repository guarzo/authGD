# Per-worktree unit test database, and detecting schema drift

**Status:** approved, ready for planning
**Date:** 2026-08-05

## Problem

`npm test` shares one database, `authgd_test` on `localhost:5433`, across every
checkout. `tests/helpers/db.ts` defaults to it:

```ts
export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://authgd:authgd@localhost:5433/authgd_test";
```

When that database has been migrated by a checkout with a *different* set of
migrations, a run against it fails wholesale — 21 files / 244 tests in the
reported case — with errors like:

```
Serialized Error: { severity: 'ERROR', code: '22P02',
  where: "unnamed portal parameter $1 = '...'",
  file: 'enum.c', routine: 'enum_in' }
```

The failures are not real. Each one costs a full ~100s suite run before anyone
recognises them as environmental.

### Why `migrate()` does not self-heal

`setupTestDb()` calls `migrate()` on every run, which looks like it should fix
any mismatch. It cannot. Drizzle's migrator applies only journal entries whose
`when` exceeds the newest applied `created_at`. A database migrated *ahead* has
a newer `created_at` than anything the checkout knows about, so the migrator
correctly concludes nothing is pending, applies nothing, and reports no error.

A database that is ahead is indistinguishable, to the migrator, from one that is
current. That is the entire bug.

Measured on the live shared database:

| | rows / files |
|---|---|
| `drizzle.__drizzle_migrations` | 8 |
| `drizzle/*.sql` in a stale checkout | 7 |

Rows 1–7 carry `created_at` values identical to the stale checkout's journal
`when` values. Row 8 (`created_at=1785897816406`, hash `bc5c9c92…`) is newer
than the checkout's newest (`1785867291348`) and unknown to it.

### Who actually gets bitten

The shared database is not holding a sibling feature branch's schema. It sits at
`origin/main`, where the tier rename has landed. The checkouts that fail are
those *behind* `origin/main` — long-lived branches predating the rename. This
makes recurrence more likely over time, not less: every branch drifts into this
state simply by ageing.

### Why the existing advisory lock does not cover it

`tests/helpers/global-setup.ts` takes a session-scoped `pg_try_advisory_lock` so
two *concurrent* runs fail fast instead of `TRUNCATE`ing each other. That guards
simultaneity. What bites here is *sequential* schema divergence — one checkout
migrates, then another runs later — which no lock can observe.

## Approach

Two changes that compose. Detection is the floor; isolation removes the routine
collisions that trigger it.

### Part 1 — Detect drift, keyed on migration hashes

`drizzle-orm/migrator` exports `readMigrationFiles()`, which returns exactly the
`sha256(fileContents)` that the migrator writes into
`drizzle.__drizzle_migrations.hash`. So the rule is set membership:

> Every hash applied in the database must appear in this checkout's journal.

This is strictly stronger than comparing 8 against 7:

| Situation | Count check | Hash check |
|---|---|---|
| DB ahead (the reported case) | caught | caught |
| Sibling branches, one migration each — 7 vs 7 | **missed** | caught |
| Migration file edited in place after being applied | **missed** | caught |
| DB merely behind (normal; `migrate()` fixes it) | quiet | quiet |

Validated against live data before implementation: **1 foreign hash** detected
using the stale checkout's journal, **0** using the current one.

### Part 2 — Per-worktree database by default

`tests/helpers/db.ts` derives its default database name from the worktree
instead of using the shared `authgd_test`, creating it on first run.

This reverses the decision recorded in `a60f1e8` (#56), which said:

> Deliberately not per-worktree database isolation. That would make local runs
> structurally different from CI — where unit and e2e share one database by
> design — and leave a private database per worktree to rot independently.

**On "structurally different from CI":** CI does not change. The precedence rule
already used by `e2e/env.ts:116` — explicit `TEST_DATABASE_URL`, then CI's
shared `5433`, then per-worktree — keeps CI byte-identical, and `e2e/env.ts:112`
records that rule as load-bearing for this exact reason. What changes is local
only. And locally this codebase already made the same trade one PR earlier:
`ae78763` (#49) landed per-worktree e2e provisioning *before* #56, so "one
behaviour everywhere" was not accurate when written. The decision preserved
unit-local ↔ unit-CI symmetry at the price of unit-local ↔ e2e-local asymmetry,
and `docs/ops.md` presents the e2e half of that asymmetry as the reason
`npm run test:e2e` "remains the only command you need" — while the unit suite
still requires a hand-typed `CREATE DATABASE`.

**On "rot independently":** this objection is correct, and Part 2 does not
answer it. A per-worktree database still drifts when you switch branches *inside*
that worktree — the same silent `22P02`, just rarer. That is why both parts ship
together: Part 1 kills the class of bug, Part 2 removes the routine collisions.
Reclamation gets an explicit command rather than being left implicit.

## Design

### Naming

`deriveWorktreeDbName()` gains a 6-character path hash, mirroring
`WORKTREE_SLUG` in `e2e/env.ts:63`. Without it, `~/a/authGD` and `~/b/authGD`
derive the same name and reintroduce the bug silently.

```
PREFIX(12) + sanitized basename(<=44) + "_" + sha256(absDir).slice(0,6)  <= 63
```

One convention serves both the automatic default and the name suggested in the
contention message. Existing exact-name assertions in
`tests/global-setup.test.ts` are updated; any hand-made `authgd_test_*` database
becomes orphaned, which is harmless.

### Default URL

Mirrors `e2e/env.ts:116` precedence exactly:

1. `process.env.TEST_DATABASE_URL` — the developer manages it.
2. CI — the historical shared `authgd_test` on `5433`, unchanged and
   load-bearing.
3. Otherwise — this worktree's derived database.

The port stays **5433**. Unlike e2e, this reuses the existing shared *container*
and takes only a separate database inside it: no new container, no `initdb`, and
`docker-compose.dev.yml` stays authoritative.

**Import direction.** `global-setup.ts` imports `TEST_URL` from `db.ts`, so
`db.ts` cannot import the derivation back from `global-setup.ts`. Therefore
`deriveWorktreeDbName` moves into `db.ts`, and `global-setup.ts` imports it from
there. `tests/global-setup.test.ts` updates its import path. This move is forced
by the change, not opportunistic cleanup.

### Creation

In `globalSetup`, connect to the target database. On Postgres `3D000`
(`invalid_catalog_name`) — **and only when the name was derived by us**, not CI
and not an explicit `TEST_DATABASE_URL` — connect to the `postgres` maintenance
database on the same host and port and issue
`CREATE DATABASE <name> OWNER authgd`, then proceed.

### Fail-open behaviour

A large share of the suite never touches Postgres and must keep passing with the
database down entirely. Every new failure path preserves that stance:

| Situation | Behaviour |
|---|---|
| Cannot connect, and cannot reach the maintenance DB | fail open — `debugLog`, no lock, no check |
| `CREATE DATABASE` fails | fail open |
| `drizzle.__drizzle_migrations` missing (fresh DB) | not drift — `setupTestDb()` will migrate it |
| Journal or migration files unreadable | fail open |
| Foreign hash found | **throw** one clear message |

### Advisory lock

Unchanged. Locally it is now near-always uncontended, since advisory locks are
per-database. It still guards CI, explicit shared URLs, and hash collisions. Its
message keeps working; the name it suggests simply gains the hash suffix.

### Cleanup

`npm run test:clean` → `scripts/drop-test-db.ts`, alongside the existing
`test:e2e:clean`. Drops this worktree's derived database, no-op if absent.
Refuses to drop `authgd` or the shared `authgd_test`, and does nothing when
`TEST_DATABASE_URL` is set — that database is not ours to delete.

## Testing

Extends `tests/global-setup.test.ts` rather than adding a parallel harness. Both
new functions are pure, so no new fixtures are needed.

- Hash-suffix naming: two same-basename directories derive different names; the
  63-byte cap holds with the suffix present; existing sanitising behaviour is
  preserved.
- `findForeignMigrations`: foreign hash detected; subset (DB behind) stays
  quiet; empty applied set stays quiet.
- `buildSchemaDriftMessage`: names the database and carries the
  `CREATE DATABASE` / `TEST_DATABASE_URL` escape hatch and the `docs/ops.md`
  pointer.
- `TEST_URL` precedence across all three branches.

## Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`. Nothing
the e2e harness reads is in this diff, so `npm run test:e2e` is run to confirm
that rather than because a change is expected.

Baseline before any change, in this worktree: **73 files, 945 tests, 0
failures**.

End-to-end checks beyond the unit tests:

- Default path on a fresh worktree creates the database and runs green.
- Pointing `TEST_DATABASE_URL` at the drifted shared database produces the
  single drift error rather than a wall of failures.
- `CI=1` still resolves to the shared `authgd_test` URL.

## Out of scope

- Making CI or an explicit shared `TEST_DATABASE_URL` safe for concurrent runs.
  The advisory lock still governs those.
- Any change to the e2e harness, which already isolates itself.
- Migrating or reconciling the shared `authgd_test` database itself.

## Documentation

`docs/ops.md`, section "`npm test` cannot touch your dev database", is wrong in
its central claim once this lands and is rewritten: the default is no longer
shared. The override table gains `test:clean`, and the drift error is documented
alongside the contention error.

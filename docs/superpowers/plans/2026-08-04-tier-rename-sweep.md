# Tier Rename Sweep (PR1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the `tier` enum and every identifier derived from it —
`flygd|blue|green` → `member|associate|alumni` — across schema, migration, core,
services, jobs, app, CSS, config and tests, and ship the deploy/rollback runbook
that migration needs.

**Architecture:** One in-place Postgres `ALTER TYPE ... RENAME VALUE` migration
(no row rewrite), then a per-module rename sweep gated by grep after each module.
No display-label configuration in this PR — the UI reads the generic names until
PR2 lands. Spec: `docs/superpowers/specs/2026-08-04-open-source-de-branding-design.md`.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM 0.45 + drizzle-kit 0.31,
Postgres 16, pg-boss, Vitest, Playwright.

## Global Constraints

- Mapping is exactly: `flygd → member`, `blue → associate`, `green → alumni`.
  `pending` is unchanged.
- **`flygd` has three meanings. Never sweep it blindly.** Tier values and
  identifiers → `member`; `DISCORD_ROLE_ID_FLYGD` → `DISCORD_ROLE_ID_MEMBER`;
  **standings contact-label fixtures → `authgd`, NOT `member`** (Task 9).
- `blue` and `green` collide with colour identifiers. Only rename occurrences in
  tier context. Leave every non-`--tier-` colour token alone —
  `--signal-ok: oklch(0.76 0.13 158)` keeps its value and its name even though
  that value is also `--tier-green`'s.
- No display-label config in this PR. Do not add `TIER_LABEL_*` — that is PR2.
- Migrations are generated first (`npm run db:generate`). Only hand-write if the
  generated output is a destructive drop-and-recreate (spec D3), and say so in
  the commit message.
- Never claim a command passed without running it and quoting the output.
  `npm run format:check` runs per task, not only at the end.
- Postgres for tests is on port 5433:
  `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test`
- Do not add a back-compat shim for the old `DISCORD_ROLE_ID_*` names (spec D8).
- Do not add a legacy audit alias map (spec D4) — pre-rename audit rows render
  their raw stored string, and that is intended.
- **User-visible tier copy is in scope; corp branding is not.** `"Approve as
  Green"`, `"Set Zed to blue"`, and `"Operation pages are FlyGD-only"` all name
  a *tier* and must track the rename (`"Approve as Alumni"`, `"Set Zed to
  associate"`, `"Operation pages are Member-only"`). `[FLYGD]` in
  `src/app/layout.tsx` and `src/app/login/page.tsx` is the corporation's ticker
  — leave it for PR2.
- **Incidental English is not tier vocabulary.** `e2e/shell.spec.ts` ("with this
  test still green") and `e2e/admin.spec.ts` ("went green against CSS") use the
  word in its ordinary sense. Renaming them makes the comment nonsense. Only
  rename `blue`/`green` where the surrounding code or sentence is about a tier.
- **Line numbers in this plan are advisory, not authoritative.** They were taken
  at plan time and every task's own commits shift the ones after it. Locate work
  by grepping for the literal in the named file; if a cited line does not contain
  what the plan says it does, trust the grep and say so in your report.

---

## File Structure

| File | Responsibility | Task |
| ---- | -------------- | ---- |
| `src/db/schema.ts` | enum declaration + column default | 1 |
| `drizzle/0007_*.sql` | the `RENAME VALUE` migration | 1 |
| `tests/db-schema.test.ts` | asserts enum values in the live DB | 1 |
| `src/config.ts` | `DISCORD_ROLE_ID_*` names + `roleIds` keys | 2 |
| `.env.example` | documented role vars | 2 |
| `tests/config.test.ts` | config parse assertions | 2 |
| `src/core/tier.ts` | `Tier` union, `decideTier` | 3 |
| `src/core/role-diff.ts` | `ManagedRoleIds`, `diffRoles`, `validateRoleConfig` | 3 |
| `src/services/desired.ts` | `MemberCharacter`, `getMemberCharacters` | 4 |
| `src/services/{accounts,admin-accounts,account-view,payouts}.ts` | tier literals | 4 |
| `src/jobs/{membership,contacts,wanderer}.ts` | tier literals + renamed imports | 5 |
| `src/app/**` | server actions, pages, `ui.tsx` | 6 |
| `src/app/account/standing.tsx` | runtime `tier === "green"/"blue"` branches | 6 |
| `src/app/account/account-payouts.tsx` | the `FlyGD-only` visible line | 6 |
| `src/app/globals.css` | `--tier-*` tokens and `.tier--*` classes | 7 |
| `tests/helpers/seed.ts`, `e2e/helpers.ts`, `scripts/seed-dev.ts` | seed defaults | 8 |
| `playwright.config.ts`, `tests/helpers/config.ts`, `tests/config.test.ts`, `tests/contacts-job.test.ts`, `tests/esi-client.test.ts` | **standings label**, not tiers | 9 |
| `e2e/*.spec.ts` | tier assertions | 10 |
| `docs/ops.md` | deploy + rollback runbook | 11 |

---

### Task 1: Schema and migration

**Files:**
- Modify: `src/db/schema.ts:19,45`
- Create: `drizzle/0007_<generated-name>.sql`
- Test: `tests/db-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: enum type `tier` with values `('member','associate','alumni','pending')`
  in that order; `account.tier` default `'alumni'`. Every later task depends on
  this.

- [ ] **Step 1: Write the failing test**

`tests/db-schema.test.ts:15` already asserts the old default. Change it:

```ts
    expect(acc.tier).toBe("alumni");
```

Then append two new cases to the same `describe("schema", …)` block:

```ts
it("tier enum carries the generic vocabulary in declaration order", async () => {
  const rows = await ctx.db.execute(
    sql`SELECT e.enumlabel AS label
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'tier'
        ORDER BY e.enumsortorder`,
  );
  expect(rows.map((r) => r.label)).toEqual([
    "member",
    "associate",
    "alumni",
    "pending",
  ]);
});

it("account.tier defaults to alumni", async () => {
  const rows = await ctx.db.execute(
    sql`SELECT column_default FROM information_schema.columns
        WHERE table_name = 'account' AND column_name = 'tier'`,
  );
  expect(String(rows[0]?.column_default)).toContain("alumni");
});
```

If `sql` is not already imported in that file, add `import { sql } from "drizzle-orm";`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/db-schema.test.ts`
Expected: FAIL — received `["flygd","blue","green","pending"]`.

- [ ] **Step 3: Edit the schema**

In `src/db/schema.ts`, line 19 and line 45:

```ts
export const tierEnum = pgEnum("tier", ["member", "associate", "alumni", "pending"]);
```

```ts
  tier: tierEnum("tier").notNull().default("alumni"),
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`

Inspect `drizzle/0007_*.sql`. **Expected content:**

```sql
ALTER TYPE "public"."tier" RENAME VALUE 'flygd' TO 'member';--> statement-breakpoint
ALTER TYPE "public"."tier" RENAME VALUE 'blue' TO 'associate';--> statement-breakpoint
ALTER TYPE "public"."tier" RENAME VALUE 'green' TO 'alumni';--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "tier" SET DEFAULT 'alumni';
```

**If the generated file instead drops and recreates the type** (look for
`DROP TYPE`, `CREATE TYPE`, or `USING ... ::text::tier`), replace its entire
contents with the four statements above by hand, and note the substitution in
the commit message. This is the documented D3 exception. Do not renumber or
rename the file.

- [ ] **Step 5: Apply to the test database and run the test**

`setupTestDb()` (`tests/helpers/db.ts:16`) calls `migrate()` itself against
`TEST_DATABASE_URL`, defaulting to
`postgres://authgd:authgd@localhost:5433/authgd_test`. So the test run migrates
the test database for you — do **not** invoke `npm run db:migrate` here. That
script reads `DATABASE_URL`, which is unset in this shell, and would either
throw `DATABASE_URL not set` or migrate your dev database:

```bash
npm test -- tests/db-schema.test.ts
```

Expected: PASS.

Note that `authgd_test` at :5433 is shared with the main checkout, so this
migration is visible outside this worktree. That is expected and reversible via
the rollback SQL.

- [ ] **Step 6: Prove the migration and its rollback on a disposable database**

The point is to exercise the committed `0007` file through Drizzle — including
the journal bookkeeping the runbook depends on — not just the enum statements in
isolation. First bring a scratch database up to `0006` only, the state
production is in today, by moving the new migration aside. Do **not** use
`git stash` for this — the stash stack is shared across worktrees.

```bash
export SCRATCH="postgres://authgd:authgd@localhost:5433/tier_roundtrip"
createdb -h localhost -p 5433 -U authgd tier_roundtrip

mkdir -p /tmp/tier-hold
mv drizzle/0007_*.sql /tmp/tier-hold/
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("drizzle/meta/_journal.json")
j = json.loads(p.read_text())
j["entries"] = [e for e in j["entries"] if not e["tag"].startswith("0007")]
p.write_text(json.dumps(j, indent=2))
PY

# Migrate to 0006 and seed every tier value.
DATABASE_URL="$SCRATCH" npm run db:migrate
psql "$SCRATCH" -c "INSERT INTO account (tier) VALUES ('flygd'),('blue'),('green'),('pending');"
psql "$SCRATCH" -c "SELECT tier, count(*) FROM account GROUP BY tier ORDER BY tier;"

# Restore 0007 and apply it through Drizzle.
mv /tmp/tier-hold/0007_*.sql drizzle/
git checkout -- drizzle/meta/_journal.json
DATABASE_URL="$SCRATCH" npm run db:migrate
```

Verify all four properties:

```bash
psql "$SCRATCH" -c "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='tier' ORDER BY enumsortorder;"
psql "$SCRATCH" -c "SELECT tier, count(*) FROM account GROUP BY tier ORDER BY tier;"
psql "$SCRATCH" -c "SELECT column_default FROM information_schema.columns WHERE table_name='account' AND column_name='tier';"
psql "$SCRATCH" -c "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 2;"
```

Expected: labels `member, associate, alumni, pending` in that order; one row
each for `member`, `associate`, `alumni`, `pending` — **the same four counts as
before the migration, with the names changed**; default `'alumni'::tier`; a new
migrations row whose `created_at` equals the `when` field of the `0007` entry in
`drizzle/meta/_journal.json`.

Now run the documented rollback against the scratch DB — the exact SQL from
`docs/ops.md` (Task 11), including the `created_at` delete:

```bash
psql "$SCRATCH" -c "BEGIN;
ALTER TYPE tier RENAME VALUE 'member' TO 'flygd';
ALTER TYPE tier RENAME VALUE 'associate' TO 'blue';
ALTER TYPE tier RENAME VALUE 'alumni' TO 'green';
ALTER TABLE account ALTER COLUMN tier SET DEFAULT 'green';
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = <when>;
COMMIT;"
psql "$SCRATCH" -c "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='tier' ORDER BY enumsortorder;"
psql "$SCRATCH" -c "SELECT tier, count(*) FROM account GROUP BY tier ORDER BY tier;"
```

Expected: `flygd, blue, green, pending`; the same four counts again, original
names. Then prove the forward path still works after a rollback:

```bash
DATABASE_URL="$SCRATCH" npm run db:migrate
psql "$SCRATCH" -c "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='tier' ORDER BY enumsortorder;"
dropdb -h localhost -p 5433 -U authgd tier_roundtrip
```

Expected: prints `migrations applied` and the generic labels again. **If it
prints nothing applied, the `DELETE` did not match — that is the P0 this step
exists to catch.** Quote every output above in the PR description.

Finally confirm you left no journal edit behind:

```bash
git status --short drizzle/
```

Expected: only the new `0007_*.sql` and `drizzle/meta/0007_snapshot.json` as
untracked/added; `_journal.json` modified only by `db:generate`, not by the
Python above.

- [ ] **Step 7: Commit**

```bash
npm run format:check
git add src/db/schema.ts drizzle/ tests/db-schema.test.ts
git commit -m "feat(db): rename tier enum values to generic vocabulary"
```

---

### Task 2: Config and .env.example

**Files:**
- Modify: `src/config.ts:71-73,118-120`
- Modify: `.env.example:49-51`
- Modify: **every fixture that sets the old names.** This is the complete list —
  do not go hunting, and do not defer any of it to a later task:

| File | Lines | Form |
| ---- | ----- | ---- |
| `playwright.config.ts` | 41-43 | object literal |
| `tests/helpers/config.ts` | 17-19 | object literal |
| `tests/config.test.ts` | 17-19 | object literal |
| `tests/accounts.test.ts` | 60-62 | object literal |
| `tests/account-view.test.ts` | 39-41 | object literal |
| `tests/payouts-service.test.ts` | 58-60 | object literal |
| `tests/eve-sso.test.ts` | 24-26 | object literal |
| `tests/sync-mode.test.ts` | 67-69 | object literal |
| `tests/discord-link.test.ts` | 19-21 | `process.env.X = "10"` |
| `tests/auth-routes.test.ts` | 21-23 | `process.env.X = "10"` |

The last two use assignment rather than an object literal, so an
object-literal-shaped search-and-replace silently skips them. Ten files, thirty
lines — that is the whole set; Step 5's grep proves it.

Also rename the Discord **role name** fixture in `tests/discord-rest.test.ts:21,26`
(`name: "FlyGD"` → `name: "Member"`). That string is the guild role's display
name in a REST-shape fixture, not a tier value and not a role id — it is renamed
for de-branding, and nothing asserts on its content beyond round-tripping it.


**Interfaces:**
- Consumes: nothing.
- Produces: `config.discord.roleIds: { member: string; associate: string; alumni: string }`.
  Task 3 (`ManagedRoleIds`) and Task 5 consume these key names.

- [ ] **Step 1: Write the failing test**

In `tests/config.test.ts`, update the fixture env to use the new var names and
add:

```ts
it("exposes discord role ids under the generic tier keys", () => {
  const cfg = loadConfig({
    ...baseEnv,
    DISCORD_ROLE_ID_MEMBER: "10",
    DISCORD_ROLE_ID_ASSOCIATE: "11",
    DISCORD_ROLE_ID_ALUMNI: "12",
  });
  expect(cfg.discord.roleIds).toEqual({
    member: "10",
    associate: "11",
    alumni: "12",
  });
});
```

Replace every `DISCORD_ROLE_ID_FLYGD` / `_BLUE` / `_GREEN` in that file's fixture
with the new names. Use whatever the file already calls its base fixture in place
of `baseEnv`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — zod reports `DISCORD_ROLE_ID_FLYGD` required.

- [ ] **Step 3: Edit config**

`src/config.ts` lines 71-73:

```ts
  DISCORD_ROLE_ID_MEMBER: z.string().min(1),
  DISCORD_ROLE_ID_ASSOCIATE: z.string().min(1),
  DISCORD_ROLE_ID_ALUMNI: z.string().min(1),
```

Lines 117-121:

```ts
      roleIds: {
        member: e.DISCORD_ROLE_ID_MEMBER,
        associate: e.DISCORD_ROLE_ID_ASSOCIATE,
        alumni: e.DISCORD_ROLE_ID_ALUMNI,
      },
```

`.env.example` lines 49-51:

```
DISCORD_ROLE_ID_MEMBER=10
DISCORD_ROLE_ID_ASSOCIATE=11
DISCORD_ROLE_ID_ALUMNI=12
```

- [ ] **Step 4: Update every fixture in the table above**

`tests/helpers/config.ts` — replace the three old role vars with the new names.
**Do not touch `STANDINGS_LABEL` on line 24 in this task**; that is Task 9 and a
different concern.

Do the same in the other nine files. Config is validated by a strict zod schema
that fails at boot, so a single missed fixture fails that whole test file with
`DISCORD_ROLE_ID_MEMBER: Required` — there is no partial-credit failure mode
here.

- [ ] **Step 5: Verify no fixture was missed**

Run: `grep -rn "DISCORD_ROLE_ID_\(FLYGD\|BLUE\|GREEN\)" src tests e2e scripts playwright.config.ts .env.example`
Expected: no output.

Run: `grep -rn "FlyGD" tests/discord-rest.test.ts`
Expected: no output.

- [ ] **Step 6: Run tests**

Run: `npm test -- tests/config.test.ts && npm run typecheck`
Expected: config test PASS. `typecheck` will still report errors in
`role-diff.ts` and its callers — that is expected until Task 3 and is not a
regression.

- [ ] **Step 7: Commit**

```bash
npm run format:check
git add src/config.ts .env.example tests/ playwright.config.ts
git commit -m "feat(config): rename discord role id vars to generic tiers"
```

---

### Task 3: Core (pure modules)

**Files:**
- Modify: `src/core/tier.ts:1,3-11,17,21-24`
- Modify: `src/core/role-diff.ts:1,5,12,14,21,29,31,62`
- Test: `tests/tier.test.ts`, `tests/role-diff.test.ts`

**Interfaces:**
- Consumes: `config.discord.roleIds` key names from Task 2.
- Produces:
  - `type Tier = "pending" | "member" | "associate" | "alumni"`
  - `decideTier(input): "member" | "alumni" | null`
  - `type ManagedRoleIds = { member: string; associate: string; alumni: string }`
  - `diffRoles({tier, managed, memberRoleIds})`, `stripManagedRoles(managed, memberRoleIds)`,
    `validateRoleConfig({managed, guildRoles, botRoleIds, everyoneRoleId?})` — signatures
    otherwise unchanged.

- [ ] **Step 1: Update the tests first**

In `tests/tier.test.ts` and `tests/role-diff.test.ts`, replace every `"flygd"` →
`"member"`, `"blue"` → `"associate"`, `"green"` → `"alumni"`, and every
`managed: { flygd, blue, green }` object key accordingly. Test *names* mentioning
tiers change too ("promotes a green main to flygd" → "promotes an alumni main to
member").

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/tier.test.ts tests/role-diff.test.ts`
Expected: FAIL — `decideTier` returns `"flygd"` where `"member"` is expected.

- [ ] **Step 3: Rewrite `src/core/tier.ts`**

```ts
export type Tier = "pending" | "member" | "associate" | "alumni";

/**
 * Membership rule: unlocked accounts are system-managed — the desired tier is
 * member when the main is in the configured alliance, alumni otherwise (this is
 * how an unlocked associate converges after "return to auto"). Transitions
 * require a CONFIRMED affiliation read of the main in this run. A pending
 * account is held as-is until a confirmed alliance main promotes it to member;
 * it is never auto-converged to alumni. Returns the tier to set, or null for no
 * change.
 */
export function decideTier(input: {
  tier: Tier;
  tierLocked: boolean;
  mainConfirmed: boolean;
  mainInAlliance: boolean;
}): "member" | "alumni" | null {
  if (input.tierLocked || !input.mainConfirmed) return null;
  // A pending account is never moved by the system except to promote a
  // confirmed alliance member. Falling through to the desired-tier rule below
  // would hand it alumni — the automatic grant this state exists to withhold.
  if (input.tier === "pending" && !input.mainInAlliance) return null;
  const desired = input.mainInAlliance ? "member" : "alumni";
  return input.tier === desired ? null : desired;
}
```

- [ ] **Step 4: Edit `src/core/role-diff.ts`**

Line 1:

```ts
export type ManagedRoleIds = { member: string; associate: string; alumni: string };
```

Line 5 (the `diffRoles` input type):

```ts
  tier: "pending" | "member" | "associate" | "alumni";
```

Lines 12, 29 and 62 — the three `managedAll` / `ids` array literals:

```ts
  const managedAll = [input.managed.member, input.managed.associate, input.managed.alumni];
```

```ts
  const managedAll = new Set([managed.member, managed.associate, managed.alumni]);
```

```ts
  const ids = [input.managed.member, input.managed.associate, input.managed.alumni];
```

Line 21's comment stays accurate as written — `pending` still has no key.

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/tier.test.ts tests/role-diff.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify no tier vocabulary remains in core**

Run: `grep -rniE "flygd|\"blue\"|\"green\"" src/core/`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
npm run format:check
git add src/core tests/tier.test.ts tests/role-diff.test.ts
git commit -m "refactor(core): rename tier vocabulary in tier and role-diff"
```

---

### Task 4: Services

**Files:**
- Modify: `src/services/desired.ts` (whole file)
- Modify: `src/services/accounts.ts:157,163,172`
- Modify: `src/services/admin-accounts.ts:27,35,112,116,118,125,133`
- Modify: `src/services/account-view.ts:22,99,212,230,369`
- Modify: `src/services/payouts.ts:32,36,37,41,44`
- Test: `tests/desired.test.ts`, `tests/accounts.test.ts`, `tests/admin-accounts.test.ts`,
  `tests/account-view.test.ts`, `tests/deprovision-flow.test.ts`,
  `tests/payouts-service.test.ts`, `tests/payout-view.test.ts`,
  `tests/payout-loot.test.ts`

**Interfaces:**
- Consumes: `Tier` from Task 3.
- Produces:
  - `type MemberCharacter = { characterId: number; accountId: string; name: string; refreshTokenEnc: string | null; tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing"; scopes: string[] }`
  - `getMemberCharacters(dbx: Dbx): Promise<MemberCharacter[]>`
  - `isContactsTarget(input: { tier: string; affiliationInvalid: boolean }): boolean`
  - `setTier(dbx, accountId, tier: "member" | "associate" | "alumni", actor)`
  - `approveAccount(dbx, accountId, tier: "alumni" | "associate", actor)`

  Task 5 imports `getMemberCharacters` and `MemberCharacter`.

- [ ] **Step 1: Update the tests first**

Across the eight test files: `"flygd"` → `"member"`, `"blue"` → `"associate"`,
`"green"` → `"alumni"`, `getFlygdCharacters` → `getMemberCharacters`,
`FlygdCharacter` → `MemberCharacter`. Test names change with them.

In `tests/payout-loot.test.ts` the three `const green = await seedAccount(…)`
bindings (lines 202, 374, 537) are local variable *names* that echo the tier —
rename each to `alumnus` along with its uses in that test body, so the fixture
still reads as what it is.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/desired.test.ts tests/admin-accounts.test.ts`
Expected: FAIL — `getMemberCharacters is not a function`.

- [ ] **Step 3: Rewrite `src/services/desired.ts`**

```ts
import { and, eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import { account, character } from "@/db/schema";

export type MemberCharacter = {
  characterId: number;
  accountId: string;
  name: string;
  refreshTokenEnc: string | null;
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  scopes: string[];
};

/**
 * The same membership test as `getMemberCharacters`, for callers that already
 * hold the rows and only need to know whether a character is in the desired
 * set. Kept next to the query so the two cannot drift: change one, change both.
 */
export function isContactsTarget(input: {
  tier: string;
  affiliationInvalid: boolean;
}): boolean {
  return input.tier === "member" && !input.affiliationInvalid;
}

/**
 * The derived desired set: every character of every member account (spec: Data
 * model → Derived). Alumni/associate accounts simply fall out; nothing is
 * deleted. A character with affiliation_invalid (biomassed/deleted at CCP) is
 * excluded: it can't be a valid contact target or ACL member, and ESI rejects
 * it — leaving it in would permanently poison every downstream sync that shares
 * this desired set.
 */
export async function getMemberCharacters(dbx: Dbx): Promise<MemberCharacter[]> {
  return dbx
    .select({
      characterId: character.id,
      accountId: character.accountId,
      name: character.name,
      refreshTokenEnc: character.refreshTokenEnc,
      tokenStatus: character.tokenStatus,
      scopes: character.scopes,
    })
    .from(character)
    .innerJoin(account, eq(character.accountId, account.id))
    .where(and(eq(account.tier, "member"), eq(character.affiliationInvalid, false)));
}
```

- [ ] **Step 4: Edit the four remaining service files**

`src/services/accounts.ts` lines 157, 163, 172 — replace the three `"green"`
literals with `"alumni"`. Line 157 reads
`!acc.tierLocked && acc.tier !== "alumni" && acc.tier !== "pending"` after the
change.

`src/services/admin-accounts.ts`:
- line 35: `tier: "member" | "associate" | "alumni",`
- line 125: `tier: "alumni" | "associate",`
- line 133: `const locked = tier === "associate";`
- comments on lines 27, 112, 116, 118: replace tier words in prose — "ANY manual
  set (member, associate, or alumni) locks the account", "member with no admin
  involved. An unlocked alumni is stable", "associate is inherently a locked
  tier", "member is not an approval target".

`src/services/account-view.ts` lines 99, 212, 230, 369 — the four
`"pending" | "flygd" | "blue" | "green"` unions become
`"pending" | "member" | "associate" | "alumni"`. Line 22's comment: "keyed by the
member character whose contact list is…".

`src/services/payouts.ts`:
- line 36: `if (!acc || acc.tier !== "member" || acc.status !== "active") {`
- line 37: message → `"payout mutation requires an active member account"`
- line 44: `return acc?.tier === "member";`
- comments on lines 32 and 41: "neither can anyone below member" / "any member
  account, any status".

- [ ] **Step 5: Run the service tests**

Run: `npm test -- tests/desired.test.ts tests/accounts.test.ts tests/admin-accounts.test.ts tests/account-view.test.ts tests/deprovision-flow.test.ts tests/payouts-service.test.ts tests/payout-view.test.ts tests/payout-loot.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify**

Run: `grep -rniE "flygd|\"blue\"|\"green\"" src/services/`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
npm run format:check
git add src/services tests/
git commit -m "refactor(services): rename tier vocabulary and desired-set helpers"
```

---

### Task 5: Jobs

**Files:**
- Modify: `src/jobs/membership.ts:25,65,205`
- Modify: `src/jobs/contacts.ts:9,24,75,76,88`
- Modify: `src/jobs/wanderer.ts:13,38`
- Test: `tests/contacts-job.test.ts`, `tests/wanderer-job.test.ts`,
  `tests/discord-roles-job.test.ts`, `tests/token-health-job.test.ts`

**Interfaces:**
- Consumes: `getMemberCharacters`, `MemberCharacter` (Task 4); `decideTier`,
  `ManagedRoleIds` (Task 3); `config.discord.roleIds` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Update the tests first**

In `tests/contacts-job.test.ts` and `tests/wanderer-job.test.ts`, replace
`seedAccount(ctx.db, { tier: "flygd" })` → `{ tier: "member" }` and rename the
helper `seedFlygdChar` → `seedMemberChar` (`wanderer-job.test.ts:74,81,106,116,140,155,165,183,196,212,230,242`).

**Do NOT touch the ESI label strings in `contacts-job.test.ts`** — every
`labelName: "flygd"`, `"FLYGD"`, `"flygd "` and the `lastDetail` assertions
quoting them are the standings label, handled in Task 9. Change only the `tier:`
properties and the `getFlygdCharacters` mention in the comment on line 124.

In `tests/discord-roles-job.test.ts`, update any `managed: {flygd,blue,green}`
fixtures to the new keys.

`tests/token-health-job.test.ts` has fourteen `seedAccount(ctx.db, { tier:
"flygd" })` calls and three `expect(after.tier).toBe("green")` assertions —
straight tier renames, plus the trailing comment on the deprovision case
(`// deprovisioned, not left flygd` → `not left member`).

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/contacts-job.test.ts tests/wanderer-job.test.ts`
Expected: FAIL — invalid input value for enum tier: "flygd", or a missing import.

- [ ] **Step 3: Edit the jobs**

`src/jobs/membership.ts`:
- line 25: `next: "member" | "alumni";`
- line 65: `cause: input.next === "member" ? "main joined alliance" : "main left alliance",`
- line 205: `if (next === "member") promoted++;`

`src/jobs/contacts.ts`:
- line 9: `import { getMemberCharacters, type MemberCharacter } from "@/services/desired";`
- line 24: `ch: Pick<MemberCharacter, "tokenStatus" | "scopes" | "refreshTokenEnc">,`
- line 75: `const members = await getMemberCharacters(db);`
- line 76: `const desiredAll = members.map((c) => c.characterId);`
- line 88: `for (const target of members) {`

`src/jobs/wanderer.ts`:
- line 13: `import { getMemberCharacters } from "@/services/desired";`
- line 38: `const desiredIds = (await getMemberCharacters(db)).map((c) => c.characterId);`

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/contacts-job.test.ts tests/wanderer-job.test.ts tests/discord-roles-job.test.ts tests/token-health-job.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify — note the deliberate exclusion**

Run: `grep -rniE "flygd|\"blue\"|\"green\"" src/jobs/`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
npm run format:check
git add src/jobs tests/
git commit -m "refactor(jobs): rename tier vocabulary in membership, contacts and wanderer"
```

---

### Task 6: App — actions, pages, primitives

**Files:**
- Modify: `src/app/_components/ui.tsx:220,221,301`
- Modify: `src/app/admin/accounts/actions.ts:82,95`
- Modify: `src/app/admin/accounts/page.tsx:53,502-503,576,587,589,599,601`
- Modify: `src/app/admin/audit/summarize.ts:38,49,159` (doc comments only)
- Modify: `src/app/payouts/access.ts:17,35,36,55`
- Modify: `src/app/payouts/actions.ts:58`
- Modify: `src/app/payouts/page.tsx:84-86`
- Modify: `src/app/payouts/new/page.tsx:43`
- Modify: `src/app/account/account-payouts.tsx:20,35,48,54`
- Modify: `src/app/account/standing.tsx:17,20,36,48`
- Modify: `src/app/_components/submit.tsx:42`
- Test: `tests/admin-accounts.test.ts`, `tests/account-payouts.test.ts`,
  `tests/audit-summarize.test.ts`

**Interfaces:**
- Consumes: `setTier`, `approveAccount` signatures from Task 4.
- Produces: `TIERS` const in `admin/accounts/page.tsx` is
  `["member", "associate", "alumni"] as const`; PR2's label work reads it.

- [ ] **Step 1: Update the tests first**

Replace tier literals in the three test files as in previous tasks. Two of them
need more than a literal swap:

- `tests/audit-summarize.test.ts` — the role-name map on lines 44-46
  (`["100","flygd"], ["200","blue"], ["300","green"]`) is a Discord role-name
  lookup keyed by id; rename the *names* to `member`/`associate`/`alumni` and
  update the `"+green −flygd"` expectations to `"+alumni −member"`. Line 248's
  `new Map([["1", "green"]])` and its assertion move together. **Keep one case
  on the old vocabulary** — Task 10 Step 3 specifies which and why; if you are
  running Task 6 first, leave lines 6-12's `flygd → green` case alone and Task
  10 will formalise it.
- `tests/account-payouts.test.ts` — line 40's comment, and the two test names
  and two assertions on lines 88-96 that quote `"FlyGD-only"`. Those become
  `"Member-only"`, matching the copy change in Step 3.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/admin-accounts.test.ts tests/audit-summarize.test.ts`
Expected: FAIL on tier literals.

- [ ] **Step 3: Edit the app files**

`src/app/_components/ui.tsx:220`:

```tsx
  const known =
    tier === "member" || tier === "associate" || tier === "alumni" || tier === "pending";
```

Line 221's following comment says "not a blue member" → "not an associate
member". Line 301's doc comment quotes an example peek (`audit log's
`green → flygd``) → `alumni → member`.

`src/app/admin/accounts/actions.ts`:
- line 82: `tier: "member" | "associate" | "alumni",`
- line 95: `tier: "alumni" | "associate",`

`src/app/admin/accounts/page.tsx`:
- line 53: `const TIERS = ["member", "associate", "alumni"] as const;`
- line 581: `action={approveAction.bind(null, r.accountId, "alumni", listSearch)}`
- line 593: `action={approveAction.bind(null, r.accountId, "associate", listSearch)}`
  — note the **fourth argument `listSearch`**; keep it, only the tier changes.
- the visible button copy and its matching `aria-label`, which must stay
  character-identical to each other (WCAG 2.5.3 — the comment on line 576 says
  so, and `e2e/admin.spec.ts` asserts both):
  - line 587 `aria-label={`Approve as Alumni for ${identity}`}`, line 589 text
    `Approve as Alumni`
  - line 599 `aria-label={`Approve as Associate for ${identity}`}`, line 601
    text `Approve as Associate`
  - line 576's comment quotes `"Approve as Green"` as its example → `"Approve as
    Alumni"`
- comments on lines 502-503: "Every character of a member account is meant to be
  on the map ACL … Non-member".

The `Set ${identity} to ${t}` label on line 628 is templated from `TIERS` and
follows the rename on its own — do not hand-edit it.

`src/app/account/standing.tsx` — this file branches on the tier at runtime:
- line 36: `if (tier === "alumni") {`
- line 48: `if (tier === "associate") {`
- the doc comment on lines 15-22 explains both branches by name: "Green and blue
  get the same badge-plus-sentence treatment" → "Alumni and associate get…";
  "desired.ts targets `tier === "member"` only"; "Alumni is the system's own call
  (tier.ts) and converges back to member on its own; associate is admin-set".

The two `<span className="dim">` sentences themselves say nothing tier-named —
leave their wording alone.

`src/app/account/account-payouts.tsx`:
- line 20 comment: "Reading an OPERATION needs tier member. A member demoted to
  associate/alumni…"
- line 48 comment: "a member below member loses the operation page" reads badly
  after the rename — write "an account below member tier loses the operation
  page behind these names (canReadPayouts)".
- line 54, **visible copy**:

```tsx
          Operation pages are Member-only. Your own payout history here stays regardless of
```

  This is the tier, not the corporation — see Global Constraints.
- line 35's comment mentions "standing.tsx's green/blue sentences" →
  "standing.tsx's alumni/associate sentences".

`src/app/admin/audit/summarize.ts` — doc comments only, no code:
- line 38: `` `member → alumni`, or `→ alumni` when… ``
- line 49: `` `+alumni −member`. Ids the app manages… ``
- line 159: `` `tier.changed` -> `member → alumni` ``

`src/app/payouts/access.ts`:
- line 17 comment: "tier member AND status active"
- line 35 comment: "account is not tier `member`"
- line 55 comment: "Only \"not an active member account\" means…"
- any literal `"flygd"` in the code body → `"member"`.

`src/app/payouts/actions.ts:58` comment: "anyone not member+active — a cryo
member".

`src/app/payouts/page.tsx:84-86` comment: "Any member reads every operation …
only an operator — member AND active … A cryo member".

`src/app/payouts/new/page.tsx:43` comment: "A cryo member (or any non-operator
member reader)".

`src/app/_components/submit.tsx:42` — the `aria-label` doc comment lists the
admin-row buttons by their visible text, and "blue" there is the tier button
rendered from `TIERS`. It must track the rename:

```tsx
  // drawer or not, because "associate", "freeze" and "sync now" all say nothing
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- tests/admin-accounts.test.ts tests/account-payouts.test.ts tests/audit-summarize.test.ts && npm run typecheck`
Expected: tests PASS; `typecheck` clean — quote the output.

- [ ] **Step 5: Verify, excluding the known false positive**

Run: `grep -rniE "flygd|\"blue\"|\"green\"" src/app/ --include="*.ts" --include="*.tsx"`
Expected: only `src/app/layout.tsx:27` (`[FLYGD]` in the description string,
which is branding and belongs to PR2) and `src/app/login/page.tsx:120`
(`[FLYGD]` footer, also PR2). Anything else is a miss — fix it before
committing. Then check the prose too:

Run: `grep -rniE "\bblue\b|\bgreen\b" src/app/ --include="*.ts" --include="*.tsx"`
Expected: no output.

Run: `grep -rn "FlyGD-only" src/app/`
Expected: no output — the visible line now reads `Member-only`.

- [ ] **Step 6: Commit**

```bash
npm run format:check
git add src/app tests/
git commit -m "refactor(app): rename tier vocabulary in actions, pages and primitives"
```

---

### Task 7: CSS tokens

**Files:**
- Modify: `src/app/globals.css:29,31,52,53,54,1107,1309,1310,1313,1314,1317,1318`
- Test: `tests/account-page.test.ts:228`

**Interfaces:**
- Consumes: the class names `Tier` emits (`tier tier--${tier}`) from Task 6.
- Produces: `.tier--member`, `.tier--associate`, `.tier--alumni` and the
  `--tier-member/-associate/-alumni` custom properties. PR2 does not change these.

- [ ] **Step 1: Rename the custom properties**

Lines 52-54:

```css
  --tier-member: oklch(0.83 0.155 88);
  --tier-associate: oklch(0.72 0.13 245);
  --tier-alumni: oklch(0.76 0.13 158);
```

Values are unchanged — the palette must look identical.

- [ ] **Step 2: Rename the tone classes**

Lines 1309-1319:

```css
.tier--member {
  --tone: var(--tier-member);
}

.tier--associate {
  --tone: var(--tier-associate);
}

.tier--alumni {
  --tone: var(--tier-alumni);
}
```

Leave `.tier--unknown`, `.tier--pending` and `.tier--lead` exactly as they are.

- [ ] **Step 3: Update the three comments**

Line 29: "from --gold / --tier-member with near-identical chroma…".
Line 31: "tell a gold MEMBER tier badge from an amber CRYO token…".
Line 1107: the `.json__peek` comment quotes an example audit peek,
`` `flygd -> green, alliance_left` `` → `` `member -> alumni, alliance_left` ``.

- [ ] **Step 3a: Update the class-name assertion in the unit test**

`tests/account-page.test.ts:228` asserts the rendered class name:

```ts
    expect(render("alumni")).toContain("tier--alumni");
```

Run: `npm test -- tests/account-page.test.ts`
Expected: PASS.

- [ ] **Step 4: Verify no tier token was missed and no colour was over-renamed**

Run: `grep -nE "tier--|--tier-" src/app/globals.css`
Expected: only `member`, `associate`, `alumni`, `unknown`, `pending`, `lead`.

Run: `grep -ncE "\bgreen\b|\bblue\b" src/app/globals.css`
Expected: the same count as before this task for any non-`--tier-` colour usage —
if the number dropped, a colour identifier was renamed by mistake. Check with
`git diff src/app/globals.css` that every changed line contains `tier`.

- [ ] **Step 5: Commit**

```bash
npm run format:check
git add src/app/globals.css tests/account-page.test.ts
git commit -m "refactor(css): rename tier colour tokens and tone classes"
```

---

### Task 8: Seed helpers and the dev seed script

**Files:**
- Modify: `tests/helpers/seed.ts:10,20`
- Modify: `e2e/helpers.ts:26,43`
- Modify: `scripts/seed-dev.ts:30,53,61,62,64,65,67,68,74,81,160,161`
- Test: `tests/seed-dev.test.ts:32,70,79`

**Interfaces:**
- Consumes: the enum from Task 1.
- Produces: `seedAccount`/`seedMember` accept
  `tier?: "pending" | "member" | "associate" | "alumni"` and default to `"alumni"`.
  Task 10's specs rely on this default.

- [ ] **Step 1: Edit both test helpers**

`tests/helpers/seed.ts`:

```ts
    tier?: "pending" | "member" | "associate" | "alumni";
```

```ts
      tier: opts.tier ?? "alumni",
```

`e2e/helpers.ts` lines 26 and 43 — identical changes.

- [ ] **Step 2: Edit the dev seed script and its test**

`scripts/seed-dev.ts` has its own `Tier` union that shadows the one in
`src/core/tier.ts`:

```ts
type Tier = "member" | "associate" | "alumni";
```

Then the seeded fixtures. Lines 53, 64, 74 and 81 are `tier:` properties — map
them by the standard rule. Lines 61, 67 and 68 carry a `label` that doubles as
the display name for the seeded account, so both fields move together, and lines
62 and 65's character names go with them:

```ts
    label: "member",
    name: "Member Pilot",
```

```ts
    alts: [{ id: 91_000_103, name: "Member Pilot Alt" }],
```

```ts
  { label: "associate", name: "Associate Pilot", mainId: 91_000_003, tier: "associate" },
  { label: "alumni", name: "Alumni Pilot", mainId: 91_000_004, tier: "alumni" },
```

Line 160-161's comment and its condition:

```ts
        // member tier is derived from alliance membership by the sync jobs.
        allianceId: spec.tier === "member" ? cfg.allianceId : null,
```

`tests/seed-dev.test.ts` asserts the seeded tier set and the convergence case:
line 32 `new Set(["member", "associate", "alumni"])`, line 70's drift `.set({
tier: "alumni", … })`, line 79 `expect(restored.tier).toBe("member")`.

- [ ] **Step 3: Run the unit suite**

Run: `npm test`
Expected: PASS. Quote the summary line. If anything fails, it is a tier literal
missed in Tasks 3-6 — fix it here rather than deferring.

- [ ] **Step 4: Verify the seed script**

Run: `grep -rniE "flygd|\"blue\"|\"green\"" scripts/ tests/helpers/ e2e/helpers.ts`
Expected: no output.

- [ ] **Step 5: Smoke-test the seed script against the scratch database**

`tests/seed-dev.test.ts` covers `seedDev()` as a function, but nothing exercises
the script's own entrypoint — its config load, migration assumptions and exit
path. Run it once end to end:

```bash
createdb -h localhost -p 5433 -U authgd seed_smoke
DATABASE_URL="postgres://authgd:authgd@localhost:5433/seed_smoke" npm run db:migrate
DATABASE_URL="postgres://authgd:authgd@localhost:5433/seed_smoke" npm run db:seed
psql "postgres://authgd:authgd@localhost:5433/seed_smoke" -c "SELECT tier, count(*) FROM account GROUP BY tier ORDER BY tier;"
dropdb -h localhost -p 5433 -U authgd seed_smoke
```

Expected: the seed completes without error and the tier counts use only
`member`, `associate`, `alumni`, `pending`.

- [ ] **Step 6: Commit**

```bash
npm run format:check
git add tests/helpers/seed.ts e2e/helpers.ts scripts/seed-dev.ts tests/seed-dev.test.ts
git commit -m "test: seed helpers and dev seed script use the generic tier vocabulary"
```

---

### Task 9: Decouple the standings label from the tier name

**This task is not a tier rename.** `STANDINGS_LABEL` is the in-game contact
label the app owns. It was set to `"flygd"` in test fixtures only because the
corp's tier name and its contact label happened to match. Production defaults to
`authgd` (`src/config.ts:83`, `.env.example:64`). Rewriting these to `"member"`
would keep the suite green while making it describe something that never happens.

**Files:**
- Modify: `playwright.config.ts:47`
- Modify: `tests/helpers/config.ts:24`
- Modify: `tests/config.test.ts:23`
- Modify: `tests/contacts-job.test.ts:11,41,256,270,276,289,290,295,313,315,317,331,345`
- Modify: `tests/esi-client.test.ts:219,224`
- Modify: `e2e/account.spec.ts:94,109,125,153`

**Interfaces:**
- Consumes: nothing.
- Produces: every fixture uses `authgd` as the standings label. No source change.

- [ ] **Step 1: Change the three config fixtures**

`playwright.config.ts:47`, `tests/helpers/config.ts:24`, `tests/config.test.ts:23`:

```ts
  STANDINGS_LABEL: "authgd",
```

- [ ] **Step 2: Change the ESI label fixtures**

In `tests/contacts-job.test.ts`, replace the label *strings* only:
- `labelName: "flygd"` → `labelName: "authgd"`
- `labelName: "FLYGD"` → `labelName: "AUTHGD"`
- `labelName: "flygd "` → `labelName: "authgd "` (trailing space preserved — that
  test asserts whitespace handling)
- `JSON.stringify(["FLYGD"])` → `JSON.stringify(["AUTHGD"])`
- `JSON.stringify(["FLYGD", "flygd "])` → `JSON.stringify(["AUTHGD", "authgd "])`
- line 11's comment: `// label "authgd", standing 5`

The case-sensitivity and whitespace assertions must keep exactly the same shape —
only the word changes.

`tests/esi-client.test.ts:219,224` carry the same fixture one layer lower — the
raw ESI payload `{ label_id: 7, label_name: "flygd" }` and the camel-cased object
the client is expected to return. Both become `authgd`.

- [ ] **Step 3: Update the e2e comments and assertion**

`e2e/account.spec.ts`:
- line 94: the comment explaining the collision is now obsolete. Replace with:
  `// STANDINGS_LABEL is "authgd" in the e2e env, which the page echoes.`
- line 109: "MEMBER, because only a member account's characters are contacts
  targets at…"
- lines 125 and 153: `/authGD owns the authgd contact label/` — there are **two**
  of these assertions, not one; the second is inside a different test.

Note line 97's `toContainText("flygd")` is the *tier* badge, not the label — it
belongs to Task 10 and becomes `"member"`. If Task 10 ran first it is already
done; if not, leave it.

- [ ] **Step 4: Run both suites**

Run: `npm test -- tests/contacts-job.test.ts tests/config.test.ts tests/esi-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the label no longer collides with a tier name**

Run: `grep -rn "flygd" -i tests/ playwright.config.ts`
Expected: **only** the deliberately-retained legacy audit case in
`tests/audit-summarize.test.ts` (Task 6 Step 1 left it alone; Task 10 Step 3
formalises it with a comment). Every remaining hit is either a tier Tasks 3-6
missed or a label this task missed — resolve it rather than committing.

- [ ] **Step 6: Commit**

```bash
npm run format:check
git add tests/ playwright.config.ts e2e/account.spec.ts
git commit -m "test: use authgd as the standings label fixture, not the tier name"
```

---

### Task 10: E2E specs

**Files:**
- Modify: `e2e/account.spec.ts:85,97,106,163,209,263,300,304,305,308,323,330,333,353,394,405,407,435,439,445,448`
- Modify: `e2e/audit.spec.ts` — every `seedMember(..., tier: "flygd")` (~25
  occurrences), every `details: {from,to}` fixture, and the rendered-text
  assertions on lines 69 and 658. **The fixture on line 1269 and its assertion
  on 1281 are deliberately left on the old vocabulary — see Step 3.**
- Modify: `tests/audit-summarize.test.ts` (new legacy-history regression test)
- Modify: `e2e/not-found.spec.ts:26,178,179`
- Modify: `e2e/payouts.spec.ts:62,63,234,453,1074`
- Modify: `e2e/admin.spec.ts` — every tier literal **and** the visible-copy
  assertions (`"Approve as Green"`, `"Approve as Blue"`, `"Set Zed to blue"`)
- Modify: `e2e/sync.spec.ts`, `e2e/submit-guard.spec.ts`, `e2e/error-boundary.spec.ts` —
  every tier literal

**Interfaces:**
- Consumes: seed helpers from Task 8, the enum from Task 1.
- Produces: nothing.

- [ ] **Step 1: Replace tier literals**

Across all `e2e/*.spec.ts`: `tier: "flygd"` → `tier: "member"`, `"blue"` →
`"associate"`, `"green"` → `"alumni"`, including inside `details:` fixtures —
except the one held back in Step 3.

**Two hits in `e2e/` are ordinary English and must not change:**
`e2e/shell.spec.ts:55` ("with this test still green") and
`e2e/admin.spec.ts:931` ("went green against CSS"). Both describe a passing
test, not a tier.

Local variable names that echo a tier move with it — `e2e/not-found.spec.ts:178`
`const green = await seedMember(…)` becomes `const alumnus`, and its use on the
next line follows.

- [ ] **Step 2: Update rendered-text assertions**

These assert what the page displays, and PR1 ships no label config, so they read
the raw enum value:

`e2e/account.spec.ts:97`:

```ts
  await expect(page.locator("[data-field='tier']")).toContainText("member");
```

`e2e/audit.spec.ts:69`:

```ts
  await expect(adminDetails.locator(".json__peek")).toHaveText("alumni → member, admin");
```

`e2e/audit.spec.ts:658`:

```ts
    "member → alumni, alliance_left",
```

`e2e/admin.spec.ts` asserts the admin table's visible tier copy, which Task 6
renamed. Every one of these must move with it or the spec fails:
- lines 417, 423, 474, 477, 531, 637: `"Approve as Green"` /
  `"Approve as Green for Waiting Pilot"` → `"Approve as Alumni"` /
  `"Approve as Alumni for Waiting Pilot"`
- lines 480, 483: `"Approve as Blue"` → `"Approve as Associate"`
- lines 185, 277, 1138, 1575: the `Set Zed to blue` accessible name →
  `Set Zed to associate` (it is templated from `TIERS`, so the *page* follows
  automatically — only the spec's expected string is hand-written)
- line 281: `await expect(zedRow.locator(".tier")).toHaveText(/associate/);`
- line 178's comment explains why the query keys on the full accessible name
  rather than the visible word (`name: "blue"` now matches nothing) — update the
  quoted word, keep the explanation.
- lines 452 and 1563: `for (const tier of ["member", "associate", "alumni"])`
- line 431's comment: "alumni is the unlocked…"

`tests/account-payouts.test.ts`'s `"Member-only"` assertions were handled in
Task 6; do not touch them again here.

- [ ] **Step 3: Keep one legacy fixture on purpose**

Spec D4 decides that pre-rename audit rows keep their stored strings and render
them verbatim — there is no alias map. That is a behaviour, so it needs a test,
and a blanket fixture rename would delete the only coverage of it.

Add to `tests/audit-summarize.test.ts`:

```ts
it("renders a pre-rename audit detail verbatim", () => {
  // Spec D4: audit_log.details is history, not live state. Rows written before
  // migration 0007 keep the old tier strings and are shown as stored — there is
  // no alias map, and adding one would rewrite history to match today's config.
  expect(summarizeDetails("tier_change", { from: "green", to: "flygd", cause: "admin" }, {})).toBe(
    "green → flygd, admin",
  );
});
```

If `summarizeDetails`' third parameter is not a bare `roleNames` record, match
whatever `tests/audit-summarize.test.ts` already passes in its neighbouring
cases rather than inventing a shape.

And in `e2e/audit.spec.ts`, leave **one** seeded row on the old vocabulary — the
line 1269 fixture, `cause: "main left alliance"` — with its assertion at 1281
(`"flygd → green, main left alliance"`) unchanged. Add the comment above it:

```ts
  // Deliberately NOT renamed: this row stands in for audit history written
  // before migration 0007. Per spec D4 it must still render its stored values.
  details: { from: "flygd", to: "green", cause: "main left alliance" },
```

Note there is a **second, near-identical** fixture at line 599,
`{ from: "flygd", to: "green", cause: "alliance_left" }`. That one is renamed as
normal — only the `"main left alliance"` row is held back. Distinguish them by
`cause`, not by shape.

Rename the fixtures at lines 23 and 269 — and every other `details` object in the
file — as normal.

- [ ] **Step 4: Update test names and prose**

`e2e/account.spec.ts:330` → `test("a member still sees the first-run notice", …)`;
line 333's seeded name `"Flygd Pilot"` → `"Member Pilot"`; line 439 →
`test("a member who is no longer a member sees their payout row with no link to the operation", …)`
— reword to `"a demoted member sees their payout row with no link to the operation"`
to avoid the awkward repetition. Line 435's doc comment ("tier flygd. A member
demoted out of flygd…") likewise.

Line 300 → `test("an associate is not told their first sync is pending", …)`;
line 308's seeded name `"Blue Pilot"` → `"Associate Pilot"`; lines 304-307's
comment ("only ever writes FLYGD members' contact lists, so a blue member…")
becomes "only ever writes MEMBER accounts' contact lists, so an associate…".

- [ ] **Step 5: Run the e2e suite**

Run: `npm run test:e2e`
Expected: PASS. Quote the summary. If `tsconfig.json` or `AGENTS.md` show as
modified afterwards, restore them with `git checkout --` — `next dev` rewrites
both, and they are tracked files. Do not delete them.

- [ ] **Step 6: Verify**

Run: `grep -rniE "flygd|\"blue\"|\"green\"" e2e/`
Expected: **exactly** the retained legacy fixture in `e2e/audit.spec.ts` (its
`details` object, its assertion, and the comment above it). Nothing else. If the
grep is empty, Step 3's deliberate exclusion was renamed by mistake — restore it.

- [ ] **Step 7: Commit**

```bash
npm run format:check
git add e2e/ tests/audit-summarize.test.ts
git commit -m "test(e2e): rename tier vocabulary, keep one pre-rename audit fixture"
```

---

### Task 11: Deploy and rollback runbook

**Files:**
- Modify: `docs/ops.md`

**Interfaces:**
- Consumes: the migration from Task 1, the secret names from Task 2.
- Produces: nothing consumed by code. This must land in PR1 — the runbook has to
  exist before the migration it describes ships.

- [ ] **Step 1: Add the section**

Append to `docs/ops.md`:

````markdown
## Tier rename migration (0007)

The tier enum values were renamed in place: `flygd → member`, `blue →
associate`, `green → alumni`. `RENAME VALUE` rewrites no rows, but the old image
cannot run against the new enum — its queries use values Postgres no longer
accepts. **This deploy requires a maintenance window.**

### Deploy

`docs/ops.md` § "Sizing and redundancy" runs **`web=2`, `worker=1`** — `web=2`
is a deliberate choice that closes the deploy gap, not a default. Record the
live counts before scaling down and restore those, rather than trusting the
numbers written here:

```bash
fly scale show   # record the current web and worker counts
```

1. `fly scale count web=0 worker=0`
2. Set the new role secrets, copying each value verbatim from the old one.
   Leave the old three set:
   ```bash
   fly secrets set DISCORD_ROLE_ID_MEMBER=<value of DISCORD_ROLE_ID_FLYGD> \
                   DISCORD_ROLE_ID_ASSOCIATE=<value of DISCORD_ROLE_ID_BLUE> \
                   DISCORD_ROLE_ID_ALUMNI=<value of DISCORD_ROLE_ID_GREEN>
   ```
3. `fly deploy` — the release command runs the migration
4. `fly scale count web=2 worker=1` (or the counts recorded above), then verify
   `/api/health` and load `/admin/accounts`
5. Only after step 4 is confirmed healthy:
   ```bash
   fly secrets unset DISCORD_ROLE_ID_FLYGD DISCORD_ROLE_ID_BLUE DISCORD_ROLE_ID_GREEN
   ```

Step 5 is last and separate so a rollback still has a bootable old image.

### Rollback

Keeping the old secrets is **necessary but not sufficient** — the enum must be
reverted before the old image starts, or it fails on every tier read regardless
of configuration.

1. `fly scale count web=0 worker=0`
2. Revert the enum:
   ```sql
   ALTER TYPE "public"."tier" RENAME VALUE 'member' TO 'flygd';
   ALTER TYPE "public"."tier" RENAME VALUE 'associate' TO 'blue';
   ALTER TYPE "public"."tier" RENAME VALUE 'alumni' TO 'green';
   ALTER TABLE "account" ALTER COLUMN "tier" SET DEFAULT 'green';
   ```
3. Remove the migration's row so the next forward deploy re-applies it.
   **`__drizzle_migrations.hash` is a SHA-256 of the file contents, not the
   filename — matching on `'%0007%'` finds nothing and silently leaves the row
   in place.** The row is identified by `created_at`, which is the `when` value
   drizzle-kit recorded in `drizzle/meta/_journal.json` for the `0007_*` entry.
   Read that number out of the journal in the deployed image, then, in the same
   transaction as step 2:

   ```sql
   -- <when> is the "when" field of the 0007 entry in drizzle/meta/_journal.json
   SELECT id, hash, created_at FROM drizzle.__drizzle_migrations
    WHERE created_at = <when>;
   -- confirm exactly one row, and that its hash matches:
   --   sha256sum drizzle/0007_<name>.sql
   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = <when>;
   ```

   Run steps 2 and 3 inside one `BEGIN`/`COMMIT`. If the `SELECT` returns zero
   or more than one row, `ROLLBACK` and stop — reverting the enum without
   clearing the record leaves the next deploy unable to move forward, and
   clearing the wrong record is worse.
4. Re-set `DISCORD_ROLE_ID_FLYGD/_BLUE/_GREEN` if step 5 of the deploy already ran
5. `fly deploy --image <previous image ref>`
6. `fly scale count web=2 worker=1` (or the counts recorded before the deploy)

A Fly version bump does not guarantee a new image — check `ImageRef` before
concluding the rollback took effect.
````

- [ ] **Step 2: Verify the doc has no stale corp references introduced**

Run: `npm run format:check`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add docs/ops.md
git commit -m "docs(ops): add tier rename deploy and rollback runbook"
```

---

### Task 12: Final verification gate

**Files:** none modified unless a check fails.

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: PASS. Quote the summary line.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. Quote the output.

- [ ] **Step 3: E2E**

Run: `npm run test:e2e`
Expected: PASS. Quote the summary. Restore `tsconfig.json` / `AGENTS.md` with
`git checkout --` if `next dev` rewrote them.

- [ ] **Step 4: Lint, build and format**

Run: `npm run lint`
Expected: clean. This sweep touches ~40 files across `src/`, so an unused import
left behind by a rename is a real risk that `typecheck` alone will not catch.

Run: `npm run build`
Expected: succeeds. A production build is the only check that exercises Next.js
route collection and static generation over the renamed pages — `npm run dev`
and the e2e suite both run in dev mode.

Run: `npm run format:check`
Expected: pass. Quote the output.

- [ ] **Step 5: Whole-repo sweep for missed literals**

```bash
grep -rniE "flygd" src tests e2e scripts docs/ops.md .env.example playwright.config.ts
```

Expected: **only**
- `src/app/layout.tsx:27` (`"Corporation auth for Zoo Landers [FLYGD]."`) and
  `src/app/login/page.tsx:120` (`Est. MMXXV · [FLYGD]`) — corp-ticker branding
  strings owned by PR2, not tier names
- the retained legacy audit fixture in `e2e/audit.spec.ts` (its `details`
  object, its assertion, and the comment above it) and the matching case in
  `tests/audit-summarize.test.ts` (Task 10 Step 3)
- `docs/ops.md`'s rollback SQL, which names the old values deliberately

Anything else is a miss. In particular the grep must return **nothing** from
`src/core/`, `src/services/`, `src/jobs/`, `src/config.ts`, `scripts/`,
`.env.example`, or `playwright.config.ts` — every one of those had hits before
this sweep.

```bash
grep -rnE '"(blue|green)"' src tests e2e scripts
```

Expected: only the retained legacy audit fixture and its unit-test counterpart.
(The word "green" appears unquoted in `e2e/shell.spec.ts:55` and
`e2e/admin.spec.ts:931` as ordinary English about a passing test — this pattern
requires the quotes precisely so those do not match. If you widen it, expect
them and leave them alone.)

```bash
grep -rn "DISCORD_ROLE_ID_\(FLYGD\|BLUE\|GREEN\)" src tests e2e scripts playwright.config.ts .env.example
```

Expected: no output. (`docs/ops.md` keeps them in the rollback and `unset` steps.)

- [ ] **Step 6: Code review**

Dispatch the `code-reviewer` agent on the full diff. Ask it explicitly to check
for: a missed tier literal; an over-eager colour rename in `globals.css`; a
category-3 standings-label fixture rewritten as a tier; whether the migration is
a `RENAME VALUE` rather than a drop-and-recreate; and whether the rollback's
`__drizzle_migrations` delete keys on `created_at` rather than the filename.

- [ ] **Step 7: Open the PR**

Include in the description: the migration SQL, every output from Task 1 Step 6
(forward, rollback, and re-apply), the inverse SQL, and a note that this deploy
needs the maintenance window documented in `docs/ops.md`.

---

## Out of scope for this PR

`TIER_LABEL_*`, `BRAND_*`, `resolveTierLabel`/`tierLabel`, `generateMetadata()`,
the client-boundary brand provider, neutral placeholder art, README/PRODUCT.md/
DESIGN.md rewrites. All PR2 and PR3.

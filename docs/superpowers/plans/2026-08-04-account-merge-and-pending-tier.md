# Account Merge and Pending Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New accounts land on a `pending` tier that grants no Discord role until an admin approves them, and a character stranded on an accidentally-created account can be folded into its owner's real account from the account page.

**Architecture:** `pending` becomes a fourth value of the existing `tier` enum. Every *reader* of tier learns about it in deploy 1 while account creation still writes `green`; a second deploy flips creation to `pending`. This ordering is mandatory — migrations run as a Fly release command before a rolling replacement, so old worker code coexists with new web code, and an old `decideTier` would transition a pending account straight to green. The merge is a new branch inside the existing `linkCharacter` transaction, reusing locks that are already held.

**Tech Stack:** TypeScript, Next.js 15 App Router, Drizzle ORM + Postgres, pg-boss, Vitest, Playwright.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-04-account-merge-and-pending-tier-design.md`. Read it before Task 1.
- **Deploy boundary is load-bearing.** Tasks 1–10 are deploy 1. Task 11 is deploy 2 and MUST be its own commit, merged and deployed separately. Never fold Task 11 into an earlier commit.
- Migrations are generated, never hand-written: `npm run db:generate` after a schema edit. Never edit a migration that has already been applied.
- `pending` goes **last** in the `pgEnum` array. Drizzle emits `ALTER TYPE ... ADD VALUE`, which can only append.
- The `tier` column default stays `green`. Postgres refuses to *use* a new enum value in the transaction that adds it, and the Drizzle migrator runs migrations in a transaction — setting the default to `pending` in that migration fails with `unsafe use of new value of enum type`.
- Never claim a command passed without running it and quoting the output. `npm run format:check` is cheap; run it per task.
- Tests need Postgres on 5433: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test` (default in `tests/helpers/db.ts`).
- Commit messages: no `Co-Authored-By` trailers (a global commit-msg hook strips them).

---

### Task 1: Make `pending` representable

No behaviour changes. This task only widens types and the enum so later tasks compile. `tier` unions are hand-copied into seven files; a missed one is a typecheck failure, which is the gate.

**Files:**
- Modify: `src/db/schema.ts:19`, `src/core/tier.ts:1`, `src/core/role-diff.ts:5`, `src/services/account-view.ts:99,212,230,236`, `src/services/admin-accounts.ts:35`, `src/app/admin/accounts/actions.ts:30`, `src/app/_components/ui.tsx:204`, `tests/helpers/seed.ts:10`, `e2e/helpers.ts:26`
- Create: `drizzle/<generated>.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `Tier = "pending" | "flygd" | "blue" | "green"` from `@/core/tier`; `TIER_RANK` with a `pending` entry.

- [ ] **Step 1: Append the enum value**

In `src/db/schema.ts:19`:

```ts
export const tierEnum = pgEnum("tier", ["flygd", "blue", "green", "pending"]);
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`

Expected: a new file in `drizzle/` containing `ALTER TYPE "public"."tier" ADD VALUE 'pending';` and nothing else. If it also contains an `ALTER COLUMN ... SET DEFAULT`, you changed the default — revert that and regenerate.

- [ ] **Step 3: Widen the Tier type**

In `src/core/tier.ts:1`:

```ts
export type Tier = "pending" | "flygd" | "blue" | "green";
```

- [ ] **Step 4: Widen every hand-copied union**

`src/core/role-diff.ts:5` — change the `tier` field of `diffRoles`'s input to `"pending" | "flygd" | "blue" | "green"`.

`src/services/account-view.ts` — lines 99, 212 and 230, same widening. Then at line 236:

```ts
// pending ranks first: an unapproved account is the one an admin has to act
// on, so the tier-sorted view puts the queue at the top. This is NOT how an
// admin finds the queue — the table defaults to name sort — see the pending
// count link on the accounts page.
const TIER_RANK = { pending: 0, flygd: 1, blue: 2, green: 3 } as const;
```

`src/services/admin-accounts.ts:35`, `src/app/admin/accounts/actions.ts:30` — widen the `tier` parameter unions.

`src/app/_components/ui.tsx:204`:

```ts
  const known =
    tier === "flygd" || tier === "blue" || tier === "green" || tier === "pending";
```

`tests/helpers/seed.ts:10` and `e2e/helpers.ts:26` — widen the `tier?:` option so tests can seed a pending account.

- [ ] **Step 5: Verify nothing broke**

Run: `npm test && npm run typecheck && npm run format:check`

Expected: all pass. `tests/db-schema.test.ts:15` asserts a bare insert defaults to `green` — it must still pass, because the column default is unchanged.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(tier): add pending as a fourth tier value

Enum value and type surface only. Nothing creates or reads pending yet."
```

---

### Task 2: `decideTier` holds a pending account

**Files:**
- Modify: `src/core/tier.ts`
- Test: `tests/tier.test.ts`

**Interfaces:**
- Consumes: `Tier` from Task 1.
- Produces: `decideTier` returns `null` for pending + non-alliance main; `"flygd"` for pending + alliance main. Return type is unchanged (`"flygd" | "green" | null`) — the function never *returns* pending.

- [ ] **Step 1: Write the failing tests**

`tests/tier.test.ts` uses a table of cases with `tier`, `tierLocked`, `mainConfirmed`, `mainInAlliance`, `expected`. Widen that table's `tier` field type to include `"pending"`, then add these two entries:

```ts
    {
      name: "pending + main in alliance → flygd (real members skip the queue)",
      tier: "pending",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: true,
      expected: "flygd",
    },
    {
      name: "pending + main out of alliance → stays pending, never auto-green",
      tier: "pending",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: false,
      expected: null,
    },
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tier.test.ts`

Expected: FAIL — the second case returns `"green"` instead of `null`.

- [ ] **Step 3: Implement**

In `src/core/tier.ts`, after the existing lock/confirm guard:

```ts
  if (input.tierLocked || !input.mainConfirmed) return null;
  // A pending account is never moved by the system except to promote a
  // confirmed alliance member. Falling through to the desired-tier rule below
  // would hand it green — the automatic grant this state exists to withhold.
  if (input.tier === "pending" && !input.mainInAlliance) return null;
  const desired = input.mainInAlliance ? "flygd" : "green";
  return input.tier === desired ? null : desired;
```

Update the function's doc comment to state the pending rule.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/tier.test.ts && npm run format:check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/tier.ts tests/tier.test.ts
git commit -m "feat(tier): decideTier never auto-greens a pending account"
```

---

### Task 3: `diffRoles` grants a pending account no role

**Files:**
- Modify: `src/core/role-diff.ts`
- Test: `tests/role-diff.test.ts`

**Interfaces:**
- Consumes: widened `tier` union from Task 1.
- Produces: `diffRoles({tier: "pending", ...})` returns `{add: [], remove: <every managed role held>}`. `ManagedRoleIds` stays three entries — no fourth Discord role, no new secret.

- [ ] **Step 1: Write the failing tests**

Add to the `describe("diffRoles")` block in `tests/role-diff.test.ts`:

```ts
  it("grants a pending account nothing and strips what it has", () => {
    expect(
      diffRoles({ tier: "pending", managed, memberRoleIds: ["12", "999"] }),
    ).toEqual({ add: [], remove: ["12"] });
  });
  it("is a no-op for a pending account with no managed role", () => {
    expect(diffRoles({ tier: "pending", managed, memberRoleIds: ["999"] })).toEqual({
      add: [],
      remove: [],
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/role-diff.test.ts`

Expected: FAIL — `managed["pending"]` is `undefined`, so `add` is `[undefined]`.

- [ ] **Step 3: Implement**

Replace the body of `diffRoles` in `src/core/role-diff.ts`:

```ts
export function diffRoles(input: {
  tier: "pending" | "flygd" | "blue" | "green";
  managed: ManagedRoleIds;
  memberRoleIds: string[];
}): { add: string[]; remove: string[] } {
  const managedAll = [input.managed.flygd, input.managed.blue, input.managed.green];
  const have = new Set(input.memberRoleIds);
  // Pending is the state of an account nobody has approved, so the guild owes
  // it nothing: strip whatever it carries and add none. Returning early also
  // narrows the tier for the managed[] lookup below, which has no pending key
  // by design — a pending Discord role would be a fourth required secret.
  if (input.tier === "pending") {
    return { add: [], remove: managedAll.filter((r) => have.has(r)) };
  }
  const want = input.managed[input.tier];
  return {
    add: have.has(want) ? [] : [want],
    remove: managedAll.filter((r) => r !== want && have.has(r)),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/role-diff.test.ts && npm run typecheck && npm run format:check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/role-diff.ts tests/role-diff.test.ts
git commit -m "feat(discord): a pending account carries no managed role"
```

---

### Task 4: Losing your main does not promote a pending account

`applyNoMainRule` demotes to green unless the tier is already green. Without this fix, unlinking your main *promotes* pending to green.

**Files:**
- Modify: `src/services/accounts.ts:144`
- Test: `tests/accounts.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

Add to `tests/accounts.test.ts`. Follow the file's existing idiom (`ctx.db`, `cfg`, `seedAccount`, `seedCharacter` are already imported and set up):

```ts
it("unlinking the main of a pending account leaves it pending", async () => {
  const acc = await seedAccount(ctx.db, { tier: "pending" });
  await seedCharacter(ctx.db, cfg, { id: 90000101, accountId: acc.id, main: true });
  await seedCharacter(ctx.db, cfg, { id: 90000102, accountId: acc.id });

  const res = await ctx.db.transaction((tx) =>
    unlinkCharacter(tx, cfg, acc.id, 90000101),
  );

  expect(res).toEqual({ ok: true });
  const [after] = await ctx.db.select().from(account).where(eq(account.id, acc.id));
  expect(after.tier).toBe("pending");
  expect(after.mainCharacterId).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/accounts.test.ts -t "leaves it pending"`

Expected: FAIL — received `"green"`.

- [ ] **Step 3: Implement**

In `src/services/accounts.ts`, inside `applyNoMainRule`:

```ts
  // Demote only from an earned tier. Green is already the floor, and pending
  // is BELOW it — demoting a pending account to green would turn losing your
  // main into an automatic approval.
  const demote = !acc.tierLocked && acc.tier !== "green" && acc.tier !== "pending";
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/accounts.test.ts && npm run format:check`

Expected: PASS, whole file green.

- [ ] **Step 5: Commit**

```bash
git add src/services/accounts.ts tests/accounts.test.ts
git commit -m "fix(account): the no-main rule never promotes a pending account"
```

---

### Task 5: `approveAccount` service

**Files:**
- Modify: `src/services/admin-accounts.ts`
- Test: `tests/admin-accounts.test.ts`

**Interfaces:**
- Consumes: `isAuthorized`, `lockTarget` (module-private, already in the file).
- Produces:
  ```ts
  export type ApproveResult =
    | { ok: true }
    | { ok: false; error: "not_authorized" | "not_found" | "not_pending" };

  export async function approveAccount(
    dbx: DbTx,
    actor: string,
    accountId: string,
    tier: "green" | "blue",
  ): Promise<ApproveResult>;
  ```
  Audit action: `tier.approved`, details `{ to, locked }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/admin-accounts.test.ts`, following the file's existing setup idiom:

```ts
describe("approveAccount", () => {
  it("approves to green WITHOUT locking, so the member can still auto-promote", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    const target = await seedAccount(ctx.db, { tier: "pending" });

    const res = await ctx.db.transaction((tx) =>
      approveAccount(tx, admin.id, target.id, "green"),
    );

    expect(res).toEqual({ ok: true });
    const [after] = await ctx.db.select().from(account).where(eq(account.id, target.id));
    expect(after.tier).toBe("green");
    expect(after.tierLocked).toBe(false);
    expect(after.tierChangedBy).toBe(admin.id);
  });

  it("approves to blue WITH a lock, since an unlocked blue converges to green", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    const target = await seedAccount(ctx.db, { tier: "pending" });

    await ctx.db.transaction((tx) => approveAccount(tx, admin.id, target.id, "blue"));

    const [after] = await ctx.db.select().from(account).where(eq(account.id, target.id));
    expect(after.tier).toBe("blue");
    expect(after.tierLocked).toBe(true);
  });

  it("refuses an account that is not pending", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    const target = await seedAccount(ctx.db, { tier: "flygd" });

    const res = await ctx.db.transaction((tx) =>
      approveAccount(tx, admin.id, target.id, "green"),
    );

    expect(res).toEqual({ ok: false, error: "not_pending" });
    const [after] = await ctx.db.select().from(account).where(eq(account.id, target.id));
    expect(after.tier).toBe("flygd");
  });

  it("refuses a non-admin actor", async () => {
    const nobody = await seedAccount(ctx.db, {});
    const target = await seedAccount(ctx.db, { tier: "pending" });

    const res = await ctx.db.transaction((tx) =>
      approveAccount(tx, nobody.id, target.id, "green"),
    );

    expect(res).toEqual({ ok: false, error: "not_authorized" });
  });

  it("audits the approval and enqueues a sync", async () => {
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    const target = await seedAccount(ctx.db, { tier: "pending" });

    await ctx.db.transaction((tx) => approveAccount(tx, admin.id, target.id, "green"));

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "tier.approved"));
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(admin.id);
    expect(rows[0].target).toBe(target.id);
    expect(rows[0].details).toEqual({ to: "green", locked: false });
    expect(await ctx.db.select().from(outbox)).toHaveLength(1);
  });
});
```

Add `approveAccount` to the file's import from `@/services/admin-accounts`, and `auditLog`/`outbox` to its `@/db/schema` import if not already present.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/admin-accounts.test.ts`

Expected: FAIL — `approveAccount is not a function`.

- [ ] **Step 3: Implement**

Append to `src/services/admin-accounts.ts`:

```ts
export type ApproveResult =
  | { ok: true }
  | { ok: false; error: "not_authorized" | "not_found" | "not_pending" };

/**
 * Approve a pending account onto green or blue. Separate from setTierManual
 * because the lock differs and the guard differs.
 *
 * Green is left UNLOCKED so the account rejoins the automatic state machine:
 * if the member later joins the alliance, the membership job promotes them to
 * flygd with no admin involved. An unlocked green is stable, because
 * decideTier already wants green for a confirmed non-alliance main.
 *
 * Blue MUST lock. An unlocked blue is converged straight back to green on the
 * next membership run, which is why blue is inherently a locked tier.
 *
 * flygd is not an approval target — it is the system's to grant, or an admin's
 * via setTierManual.
 */
export async function approveAccount(
  dbx: DbTx,
  actor: string,
  accountId: string,
  tier: "green" | "blue",
): Promise<ApproveResult> {
  if (!(await isAuthorized(dbx, actor))) return { ok: false, error: "not_authorized" };
  const acc = await lockTarget(dbx, accountId);
  if (!acc) return { ok: false, error: "not_found" };
  // Re-checked under the lock: two admins approving the same account race here,
  // and the second must not re-stamp a tier the first already granted.
  if (acc.tier !== "pending") return { ok: false, error: "not_pending" };
  const locked = tier === "blue";
  await dbx
    .update(account)
    .set({ tier, tierLocked: locked, tierChangedAt: new Date(), tierChangedBy: actor })
    .where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor,
    action: "tier.approved",
    target: accountId,
    details: { to: tier, locked },
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/admin-accounts.test.ts && npm run typecheck && npm run format:check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/admin-accounts.ts tests/admin-accounts.test.ts
git commit -m "feat(admin): approveAccount moves a pending account to green or blue

Green stays unlocked so a later alliance join still auto-promotes; blue locks
because an unlocked blue converges back to green on the next membership run."
```

---

### Task 6: Admin queue — filter, badge, approve controls

The accounts table defaults to name sort (`page.tsx:89`), so `TIER_RANK` alone leaves pending accounts scattered alphabetically. The queue gets its own entry point instead of hijacking everyone's default sort.

**Files:**
- Modify: `src/app/admin/accounts/page.tsx`, `src/app/admin/accounts/actions.ts`, `src/app/globals.css`
- Test: `tests/account-view.test.ts`, `tests/admin-accounts.test.ts`

**Interfaces:**
- Consumes: `approveAccount` (Task 5), `TIER_RANK` (Task 1).
- Produces: server action `approveAction(accountId: string, tier: "green" | "blue"): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

The `TIERS` array is a plain `as const` list, so a missing `pending` entry is **not** a type error — the filter silently falls through to "no filter" and the queue link returns the whole table. That path needs a runtime test. Add to `tests/account-view.test.ts`:

```ts
it("filters the admin list down to pending accounts", async () => {
  await seedAccount(ctx.db, { tier: "pending" });
  await seedAccount(ctx.db, { tier: "green" });
  await seedAccount(ctx.db, { tier: "flygd" });

  const rows = await getAdminAccountsList(ctx.db, cfg, { tier: "pending" });

  expect(rows).toHaveLength(1);
  expect(rows[0].tier).toBe("pending");
});

it("sorts pending accounts ahead of every other tier when sorting by tier", async () => {
  await seedAccount(ctx.db, { tier: "green" });
  await seedAccount(ctx.db, { tier: "pending" });
  await seedAccount(ctx.db, { tier: "flygd" });

  const rows = await getAdminAccountsList(ctx.db, cfg, { sort: "tier" });

  expect(rows.map((r) => r.tier)).toEqual(["pending", "flygd", "green"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/account-view.test.ts`

Expected: the sort test FAILS if Task 1's `TIER_RANK` was missed; the filter test passes at the service layer (the whitelist gap is in the page). Both must be green before moving on.

- [ ] **Step 3: Add the server action**

In `src/app/admin/accounts/actions.ts`, following the shape of the existing `setTierAction` (same admin guard, same `revalidatePath`, same error redirect):

```ts
export async function approveAction(
  accountId: string,
  tier: "green" | "blue",
): Promise<void> {
  const actor = await requireAdminAction();
  const res = await getDb().transaction((tx) =>
    approveAccount(tx, actor, accountId, tier),
  );
  if (!res.ok) redirect(`/admin/accounts?error=${res.error}`);
  revalidatePath("/admin/accounts");
}
```

Match the surrounding functions exactly — read `setTierAction` at `actions.ts:28` and mirror its guard call and redirect style rather than inventing one.

- [ ] **Step 4: Wire the page**

In `src/app/admin/accounts/page.tsx`:

```ts
const TIERS = ["pending", "flygd", "blue", "green"] as const;
```

Add to the `ERRORS` map:

```ts
  not_pending: "That account was already approved by someone else. Refresh to see its current tier.",
```

Above the table, render a queue link shown only when there is something to do:

```tsx
{pendingCount > 0 && (
  <Notice>
    <a href="/admin/accounts?tier=pending">
      {pendingCount} account{pendingCount === 1 ? "" : "s"} awaiting approval
    </a>
  </Notice>
)}
```

Derive `pendingCount` from the rows the page already fetches when no tier filter is applied; when a filter *is* applied, count with a separate `getAdminAccountsList(db, cfg, { tier: "pending" })` call so the banner does not vanish while you are inside a different filter.

For a row whose `tier` is `pending`, render two `Submit` buttons bound to `approveAction` — "Approve as Green" and "Approve as Blue" — in place of the tier `<select>`. Leave every non-pending row exactly as it is today.

- [ ] **Step 5: Style the badge**

In `src/app/globals.css`, after the `.tier--unknown` block:

```css
/* Pending is deliberately achromatic rather than a fourth hue: DESIGN.md tunes
   the three tier colours as a set against deuteranopia and protanopia, and
   "not yet approved" reads better as an absence of colour than as a new one.
   Shares --ink-dim with .tier--unknown, already measured at 5.67:1 on the
   badge's own tint over a hovered row. */
.tier--pending {
  --tone: var(--ink-dim);
}
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run lint && npm run format:check`

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(admin): a pending approval queue on the accounts table

Default sort stays name; the queue gets its own count link rather than
reordering every admin's table."
```

---

### Task 7: The member sees that approval is pending

**Files:**
- Modify: `src/app/account/page.tsx`
- Test: `tests/account-page.test.ts`

**Interfaces:**
- Consumes: `tier` on the account view (Task 1).
- Produces: no exported signature change.

- [ ] **Step 1: Write the failing test**

Add to `tests/account-page.test.ts`, following the file's existing render idiom:

```ts
it("tells a pending member their access is awaiting approval", async () => {
  const acc = await seedAccount(ctx.db, { tier: "pending" });
  await seedCharacter(ctx.db, cfg, { id: 90000201, accountId: acc.id, main: true });

  const html = await renderAccountPage(acc.id);

  expect(html).toContain("awaiting approval");
  // Not a tier badge: pending is the absence of a granted tier, and showing a
  // badge would imply they hold one.
  expect(html).not.toContain("tier--lead");
});
```

Use whatever render helper the file already defines rather than adding one.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/account-page.test.ts -t "awaiting approval"`

Expected: FAIL.

- [ ] **Step 3: Implement**

In `src/app/account/page.tsx`, where the tier badge renders, branch on pending:

```tsx
{acc.tier === "pending" ? (
  <Notice>
    Your access is awaiting approval from an admin. Nothing is wrong — someone
    on the team will review your account.
  </Notice>
) : (
  <Tier tier={acc.tier} />
)}
```

Use the page's existing `Notice` and `Tier` imports and its own variable name
for the account row. No error styling and no red: nothing here reads as
punishment (PRODUCT.md), and a pending account has done nothing wrong.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/account-page.test.ts && npm run format:check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/account/page.tsx tests/account-page.test.ts
git commit -m "feat(account): show a pending member that approval is in progress"
```

---

### Task 8: Absorb an accidentally-created account

**Files:**
- Modify: `src/services/accounts.ts`, `src/app/account/page.tsx:54`
- Test: `tests/accounts.test.ts`

**Interfaces:**
- Consumes: `findCharacterForUpdate`, `lockAccounts`, `reauthCharacter`, `logAudit` (all already in `accounts.ts`).
- Produces: `linkCharacter`'s signature is unchanged — `{ ok: true } | { ok: false; error: "already_linked" }`. The merge happens inside `ok: true`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/accounts.test.ts`. Import `session`, `discordLink`, `auditLog` from `@/db/schema` and `createSession` from `@/services/session` as needed.

```ts
describe("linkCharacter absorbing an accidental account", () => {
  it("folds a bare single-character account into the caller's account", async () => {
    const main = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 90000301, accountId: main.id, main: true });
    // The accident: a fresh SSO login created its own account for this char.
    const stray = await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, ch({ characterId: 90000302, ownerHash: "oh-302" })),
    );
    const strayId = stray.accountId;

    const res = await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, main.id, ch({ characterId: 90000302, ownerHash: "oh-302" })),
    );

    expect(res).toEqual({ ok: true });
    const [moved] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, 90000302));
    expect(moved.accountId).toBe(main.id);
    const gone = await ctx.db.select().from(account).where(eq(account.id, strayId));
    expect(gone).toHaveLength(0);
  });

  it("deletes the absorbed account's sessions", async () => {
    const main = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 90000311, accountId: main.id, main: true });
    const stray = await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, ch({ characterId: 90000312, ownerHash: "oh-312" })),
    );
    await createSession(ctx.db, stray.accountId);

    await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, main.id, ch({ characterId: 90000312, ownerHash: "oh-312" })),
    );

    const sessions = await ctx.db
      .select()
      .from(session)
      .where(eq(session.accountId, stray.accountId));
    expect(sessions).toHaveLength(0);
  });

  it("adopts the character as main when the target has none", async () => {
    const main = await seedAccount(ctx.db, { tier: "green" });
    await seedCharacter(ctx.db, cfg, { id: 90000321, accountId: main.id });
    await ctx.db
      .update(account)
      .set({ mainCharacterId: null })
      .where(eq(account.id, main.id));
    await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, ch({ characterId: 90000322, ownerHash: "oh-322" })),
    );

    await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, main.id, ch({ characterId: 90000322, ownerHash: "oh-322" })),
    );

    const [after] = await ctx.db.select().from(account).where(eq(account.id, main.id));
    expect(after.mainCharacterId).toBe(90000322);
  });

  it("audits the merge and leaves the source's own audit rows unresolved", async () => {
    const main = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 90000331, accountId: main.id, main: true });
    const stray = await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, ch({ characterId: 90000332, ownerHash: "oh-332" })),
    );

    await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, main.id, ch({ characterId: 90000332, ownerHash: "oh-332" })),
    );

    const merged = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "account.merged"));
    expect(merged).toHaveLength(1);
    expect(merged[0].details).toEqual({
      sourceAccountId: stray.accountId,
      characterId: 90000332,
    });
    // audit_log.actor is plain text with no FK: rows the deleted account wrote
    // survive with a uuid that resolves to nothing (actorKind "unresolved").
    const orphaned = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, stray.accountId));
    expect(orphaned.length).toBeGreaterThan(0);
  });
});

describe("linkCharacter refusing a real account", () => {
  // One case per absorbability check. Each seeds an otherwise-absorbable
  // account and flips exactly one attribute, so a loosened predicate fails
  // exactly one test and names itself.
  const refuses = async (mutate: (accountId: string) => Promise<void>) => {
    const main = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, { id: 90000401, accountId: main.id, main: true });
    const stray = await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, ch({ characterId: 90000402, ownerHash: "oh-402" })),
    );
    await mutate(stray.accountId);

    const res = await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, main.id, ch({ characterId: 90000402, ownerHash: "oh-402" })),
    );

    expect(res).toEqual({ ok: false, error: "already_linked" });
    const [still] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, 90000402));
    expect(still.accountId).toBe(stray.accountId);
  };

  it("refuses an admin account", () =>
    refuses((id) =>
      ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, id)),
    ));

  it("refuses a tier-locked account", () =>
    refuses((id) =>
      ctx.db.update(account).set({ tierLocked: true }).where(eq(account.id, id)),
    ));

  it("refuses a cryo account", () =>
    refuses((id) =>
      ctx.db.update(account).set({ status: "cryo" }).where(eq(account.id, id)),
    ));

  it("refuses an account carrying an admin's status note", () =>
    refuses((id) =>
      ctx.db
        .update(account)
        .set({ statusNote: "inactive since March, keep the tier" })
        .where(eq(account.id, id)),
    ));

  it("refuses an account with a Discord link", () =>
    refuses(async (id) => {
      await ctx.db.insert(discordLink).values({ accountId: id, discordUserId: "d-1" });
    }));

  it("refuses an account holding a second character", () =>
    refuses(async (id) => {
      await seedCharacter(ctx.db, cfg, { id: 90000403, accountId: id });
    }));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/accounts.test.ts -t "absorbing"`

Expected: FAIL — every absorb test returns `{ ok: false, error: "already_linked" }`. The refusal tests already pass, which is correct: they are the regression net for the behaviour you must not break.

- [ ] **Step 3: Implement the predicate**

Add to `src/services/accounts.ts`, above `linkCharacter`. Import `discordLink`, `payoutOperation`, `payoutParticipant`, `session` from `@/db/schema`.

```ts
/**
 * Is this account nothing but the character being moved?
 *
 * An account created by an accidental SSO login holds exactly one character
 * and no other trace: no admin bit, no Discord link, no payout history, no
 * admin-set tier, and no status or note an admin curated. Cryo and a status
 * note are each reachable on their own (setAccountStatus / setStatusNote), so
 * both are checked — an established account must never be dissolved, and its
 * note destroyed, by someone clicking "link character".
 *
 * Callers must already hold the source account row FOR UPDATE.
 */
async function isAbsorbable(
  dbx: DbTx,
  acc: typeof account.$inferSelect,
  characterId: number,
): Promise<boolean> {
  if (acc.isAdmin || acc.tierLocked) return false;
  if (acc.status !== "active" || acc.statusNote !== null) return false;
  const chars = await dbx
    .select()
    .from(character)
    .where(eq(character.accountId, acc.id));
  if (chars.length !== 1 || chars[0].id !== characterId) return false;
  const [linked] = await dbx
    .select()
    .from(discordLink)
    .where(eq(discordLink.accountId, acc.id));
  if (linked) return false;
  const [participant] = await dbx
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.accountId, acc.id));
  if (participant) return false;
  const [operation] = await dbx
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.createdBy, acc.id));
  if (operation) return false;
  return true;
}

/**
 * Fold `sourceId` into `targetId`: the character moves, the source account and
 * its sessions are deleted. Callers must hold the advisory character lock and
 * BOTH account rows FOR UPDATE in sorted id order.
 *
 * The source's main is cleared first for clarity only — account's composite
 * main-character FK is DEFERRABLE INITIALLY DEFERRED
 * (drizzle/0001_main_character_fk.sql), so the reassignment is validated at
 * COMMIT rather than statement by statement.
 *
 * Deleting the sessions is mandatory, not tidiness: session.account_id has no
 * ON DELETE clause (schema.ts:89), so it defaults to NO ACTION and the account
 * DELETE below raises a foreign key violation if any session survives. The
 * stray account's browser session is exactly the one the operator used to make
 * the accident, so it is very likely to exist.
 *
 * Two deletion side effects, both intended. audit_log.actor is plain text with
 * no FK, so rows the source wrote survive with an id that resolves to nothing
 * (actorKind "unresolved"); they are NOT rewritten to the target, because
 * falsifying history to make it read better is worse than an unresolved id,
 * and the account.merged row records the mapping. bootstrap_admin_grant
 * .account_id IS a nulling FK and nulls — correct, since the grant must stay
 * permanently consumed and unearnable through a merge.
 */
async function mergeAccountInto(
  dbx: DbTx,
  sourceId: string,
  targetId: string,
  characterId: number,
): Promise<void> {
  await dbx
    .update(account)
    .set({ mainCharacterId: null })
    .where(eq(account.id, sourceId));
  await dbx
    .update(character)
    .set({ accountId: targetId })
    .where(eq(character.id, characterId));
  await dbx.delete(session).where(eq(session.accountId, sourceId));
  await dbx.delete(account).where(eq(account.id, sourceId));
  await logAudit(dbx, {
    actor: targetId,
    action: "account.merged",
    target: targetId,
    details: { sourceAccountId: sourceId, characterId },
  });
}
```

- [ ] **Step 4: Replace the refusal in `linkCharacter`**

Swap the `already_linked` early return (`accounts.ts:244`) for:

```ts
    if (existing.ownerHash === ch.ownerHash) {
      // Same character, same owner hash, a different account. EVE rotates the
      // owner hash on every transfer and handleEveLogin reclaims on mismatch,
      // so this state is reachable ONLY when the same owner authenticated
      // twice — an accidental second login, provably the same person as the
      // caller. Absorb that account if it holds nothing but this character;
      // anything richer is a real account and still refuses.
      await lockAccounts(dbx, [existing.accountId, accountId]);
      const [source] = await dbx
        .select()
        .from(account)
        .where(eq(account.id, existing.accountId));
      if (!source || !(await isAbsorbable(dbx, source, ch.characterId))) {
        return { ok: false, error: "already_linked" };
      }
      await mergeAccountInto(dbx, existing.accountId, accountId, ch.characterId);
      // Store the credentials this SSO round just produced, audit the re-auth
      // and enqueue the target's sync — all three are reauthCharacter's job.
      await reauthCharacter(dbx, cfg, accountId, ch);
      // Plain select, no FOR UPDATE: lockAccounts above already holds this row.
      const [target] = await dbx
        .select()
        .from(account)
        .where(eq(account.id, accountId));
      if (target && target.mainCharacterId === null) {
        await dbx
          .update(account)
          .set({ mainCharacterId: ch.characterId })
          .where(eq(account.id, accountId));
      }
      // maybeGrantBootstrapAdmin is deliberately NOT called: the grant for this
      // character was already consumed when the source account was created, and
      // the grant row survives that account's deletion precisely so it cannot
      // be re-earned.
      return { ok: true };
    }
```

- [ ] **Step 5: Update the member-facing copy**

`src/app/account/page.tsx:54` — this message now fires only for accounts that failed the absorbability test:

```ts
  already_linked:
    "That character belongs to an account with its own history, so it can't be merged automatically. Ask an admin.",
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run format:check`

Expected: all pass, including the pre-existing sold-character reclaim tests — the owner-hash-mismatch branch must be untouched.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(account): absorb an accidentally-created single-character account

Linking a character whose owner hash matches but whose account is otherwise
empty now folds that account in instead of refusing. Anything with an admin
bit, a lock, cryo, a note, a Discord link, payout history, or a second
character still refuses."
```

---

### Task 9: End-to-end coverage

**Files:**
- Modify: `e2e/account.spec.ts`, `e2e/admin.spec.ts`

**Interfaces:**
- Consumes: `seedMember`, `sessionCookieFor`, `resetDb`, `testDb` from `e2e/helpers.ts`; the widened `tier` option from Task 1.

- [ ] **Step 1: Write the specs**

In `e2e/account.spec.ts`:

```ts
test("a pending member is told their access is awaiting approval", async ({ page, context }) => {
  const { account: acc } = await seedMember(db, { name: "Pending Pilot", tier: "pending" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);

  await page.goto("/account");

  await expect(page.getByText(/awaiting approval/i)).toBeVisible();
});
```

In `e2e/admin.spec.ts`:

```ts
test("an admin reaches the queue from the count link and approves", async ({ page, context }) => {
  const { account: admin } = await seedMember(db, { name: "Admin One", isAdmin: true, tier: "flygd" });
  await seedMember(db, { name: "Waiting Pilot", tier: "pending" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/admin/accounts");
  await page.getByRole("link", { name: /awaiting approval/i }).click();
  await expect(page).toHaveURL(/tier=pending/);

  await page.getByRole("button", { name: "Approve as Green" }).click();

  await expect(page.getByRole("link", { name: /awaiting approval/i })).toHaveCount(0);
});
```

Match each file's existing setup preamble (`const { db, pool } = testDb()` etc.) instead of duplicating it.

- [ ] **Step 2: Run**

Run: `npm run test:e2e`

Expected: PASS.

- [ ] **Step 3: Recover mutated tracked files**

`next dev` rewrites `tsconfig.json` and `AGENTS.md` during an e2e run. Both are tracked — restore, never delete:

```bash
git checkout -- tsconfig.json AGENTS.md
```

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): pending notice and the admin approval queue"
```

---

### Task 10: Deploy 1 gate

- [ ] **Step 1: Full verification**

Run each and quote the output:

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run test:e2e
git checkout -- tsconfig.json AGENTS.md
```

- [ ] **Step 2: Confirm nothing creates pending yet**

Run: `grep -rn 'tier: "pending"' src/`

Expected: **no match**. If `createAccountWithCharacter` already writes pending, Task 11 leaked into deploy 1 — move it to its own commit before merging.

- [ ] **Step 3: Confirm no existing account moves**

Inspect the generated migration:

Run: `git diff main --stat drizzle/ && cat drizzle/*pending*.sql 2>/dev/null || git diff main -- drizzle/`

Expected: exactly one new `.sql` file containing only `ALTER TYPE "public"."tier" ADD VALUE 'pending';`. No `UPDATE`, no `SET DEFAULT`, no backfill. The spec guarantees accounts that are green when this ships stay green — a migration that touches rows breaks that guarantee and would strip a genuine deroled ex-member's Discord access on deploy.

- [ ] **Step 4: Open the deploy-1 PR**

Every change lands via GitHub PR; never `git merge` into local main. The PR description must state that a second PR follows and must not be merged until deploy 1 is live.

---

### Task 11: Deploy 2 — new accounts start pending

**Do not start this until deploy 1 is live in production.** Every running worker must already understand `pending` before any row carries it.

**Files:**
- Modify: `src/services/accounts.ts:194`
- Test: `tests/accounts.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

```ts
it("a first-time login creates a pending account, not a green one", async () => {
  const { accountId } = await ctx.db.transaction((tx) =>
    handleEveLogin(tx, cfg, ch({ characterId: 90000501, ownerHash: "oh-501" })),
  );

  const [acc] = await ctx.db.select().from(account).where(eq(account.id, accountId));
  expect(acc.tier).toBe("pending");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/accounts.test.ts -t "not a green one"`

Expected: FAIL — received `"green"`.

- [ ] **Step 3: Implement**

In `createAccountWithCharacter` (`src/services/accounts.ts:194`):

```ts
  const [acc] = await dbx
    .insert(account)
    // Explicit, not the column default: the default stays green because a
    // migration cannot use a newly added enum value in the transaction that
    // adds it. Deploy 1 taught every reader about pending; this line is
    // deploy 2, and must never ship in the same release as deploy 1.
    .values({ tier: "pending", mainCharacterId: ch.characterId })
    .returning();
```

- [ ] **Step 4: Fix the fallout**

Other tests assert a fresh login lands on green. Each is now asserting the old behaviour — update them to `pending`, and read each one before changing it: a test that meant "a new account gets no Discord role" is now *more* true, but one that meant "green is the floor" may need rethinking rather than a find-and-replace.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck && npm run format:check && npm run test:e2e && git checkout -- tsconfig.json AGENTS.md`

Expected: all pass.

- [ ] **Step 6: Commit and open the deploy-2 PR**

```bash
git add -A
git commit -m "feat(account): new accounts start pending

Deploy 2 of 2. Every reader learned pending in the previous release, so no
worker can misread these rows during the rolling replacement."
```

---

## Verification summary

| Gate | Command |
|---|---|
| Unit | `npm test` |
| Types | `npm run typecheck` |
| Lint | `npm run lint` |
| Format | `npm run format:check` |
| E2E | `npm run test:e2e`, then `git checkout -- tsconfig.json AGENTS.md` |
| Deploy ordering | `grep -rn 'tier: "pending"' src/` returns nothing before deploy 1 ships |

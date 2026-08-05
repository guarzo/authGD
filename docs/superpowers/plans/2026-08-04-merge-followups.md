# Account-Merge Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Discord unlink path (member + admin), surface the pending-approval count in the admin nav, and give three audit actions curated summary lines.

**Architecture:** Three independent changes off one spec. Item 3 is a pure function with no I/O and lands first. Item 1 adds one service export consumed by two server actions. Item 2 threads a count from the admin layout through a shared server component. Nothing touches the schema, so there is no migration.

**Tech Stack:** Next.js 16.3 App Router (server components, server actions), React 19, Drizzle ORM on Postgres, pg-boss worker via an outbox table, Vitest, Playwright.

Spec: `docs/superpowers/specs/2026-08-04-merge-followups-design.md`.

## Global Constraints

- **Never claim a command passed without running it.** Quote real output for `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:e2e`.
- **`npm run format:check` runs per task**, not only at the final gate. It is cheap and a diff cannot substitute for it.
- **`src/app/admin/audit/summarize.ts` stays a pure function of its arguments.** No new imports, no env, no db. `roleNames` remains its only injected dependency.
- **`src/lib/error-redirects.ts` imports nothing.** Item 1's copy change adds no import.
- **No schema change and no migration.** If a task appears to need one, stop and ask.
- **Stay in scope.** Do not rename, restructure, or clean up files these tasks do not name.
- Test DB is Postgres on port 5433: `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test`.
- Commit after each task. Do not merge to `main` locally; the branch lands via PR.

---

### Task 1: Audit summarizer renderers

Pure function, no I/O, no dependency on other tasks. Lands first so the rest of the work rebases onto a green tree.

**Files:**
- Modify: `src/app/admin/audit/summarize.ts` (add two combinators near the others at :74-119; add three `PARTS` entries at :131-153)
- Test: `tests/audit-summarize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks use. `summarizeDetails(action, details, roleNames?)` keeps its exact existing signature.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("summarizeDetails", …)` block in `tests/audit-summarize.test.ts`:

```ts
it("renders an approval as a transition into the granted tier", () => {
  expect(summarizeDetails("tier.approved", { to: "green", locked: false })).toBe(
    "→ green",
  );
});

it("renders an approval that locked the tier", () => {
  expect(summarizeDetails("tier.approved", { to: "blue", locked: true })).toBe(
    "→ blue, locked",
  );
});

it("renders a merge with a shortened source account and its character", () => {
  expect(
    summarizeDetails("account.merged", {
      sourceAccountId: "7f3a2b1c-0000-4000-8000-000000000001",
      characterId: 90000001,
    }),
  ).toBe("absorbed 7f3a2b…, character 90000001");
});

it("renders a reprice with the name and price the fallback used to truncate", () => {
  // unitPrice is what payout-loot.ts:218 actually writes: centsToIsk(), which
  // is always a 2dp STRING. Kept verbatim rather than normalised to 5.5 — the
  // trailing zeros are the money shape, and stripping them would render a
  // 1000.00 ISK reprice as "1000".
  expect(
    summarizeDetails("payout.item_repriced", {
      itemId: "i-1",
      poolId: "p-1",
      name: "Tritanium",
      unitPrice: "5.50",
    }),
  ).toBe("Tritanium → 5.50");
});

// The sub-object ids are declared-and-silent, not unread: a `+2 more` here
// would tell an admin something was hidden from them when nothing was.
it("does not report the reprice sub-object ids as hidden keys", () => {
  expect(
    summarizeDetails("payout.item_repriced", {
      itemId: "i-1",
      poolId: "p-1",
      name: "Tritanium",
      unitPrice: "5.50",
    }),
  ).not.toContain("more");
});

// Every action emitted with no `details` at all. Derived mechanically from
// `grep -rho 'action: "…"' src/`; see the spec's "How this inventory was
// derived". A renderer for any of these would be machinery for an empty
// payload, and the em dash is already correct.
it.each([
  "character.linked",
  "character.reauthed",
  "discord.linked",
  "admin.demoted",
  "admin.promoted",
  "character.affiliation_invalid",
  "wanderer.added",
  "wanderer.unblocked",
  "sync.requested",
  "sync.recheck_requested",
  "payout.created",
  "payout.finalized",
  "payout.unlocked",
])("renders %s with no details as an em dash", (action) => {
  expect(summarizeDetails(action, {})).toBe("—");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/audit-summarize.test.ts`

Expected: the `tier.approved`, `account.merged` and `payout.item_repriced` cases FAIL (they render the generic `key=value` fallback, e.g. `to=green, locked=false`). The `it.each` block PASSES already — it is a regression guard for the fallback, not new behavior.

- [ ] **Step 3: Add the two combinators**

In `src/app/admin/audit/summarize.ts`, after `flag` (which ends at :88) and before `list`:

```ts
/** A uuid the audit page cannot resolve to a name, shortened the way an
 * unnameable role id is. `account.merged` is the case: the source account row
 * is deleted by the merge that writes the row, so there is nothing left to
 * resolve against and the full value only crowds the column. It rides along in
 * the `title` the details cell already sets. */
function shortRef(word: string, key: string): Part {
  return part([key], (d) =>
    typeof d[key] === "string" ? `${word} ${shortId(d[key] as string)}` : "",
  );
}

/** Keys the line deliberately does not show. Declaring them is the whole
 * point: `summarizeDetails` counts undeclared keys as `+N more`, so a payload
 * id that identifies a sub-object rather than describing the change would
 * otherwise be reported to an admin as something withheld. */
function silent(...keys: string[]): Part {
  return part(keys, () => "");
}
```

- [ ] **Step 4: Add the three PARTS entries**

In the `PARTS` map, after the `"tier.changed"` line for the first and grouped with their neighbours for the rest:

```ts
  // Same shape as tier.changed on purpose: an approval IS a tier transition,
  // and the payload has no `from` because a pending account has no prior tier
  // an admin would recognise. `transition` already renders `→ green` for that.
  "tier.approved": [transition("from", "to"), flag("locked", "locked")],
  "account.merged": [
    shortRef("absorbed", "sourceAccountId"),
    labelled("character", "characterId"),
  ],
  // The only action in the repo whose payload exceeds FALLBACK_KEYS, and the
  // key the fallback dropped was the price — the reason the row exists.
  "payout.item_repriced": [
    scalar("name"),
    labelled("→", "unitPrice"),
    silent("itemId", "poolId"),
  ],
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/audit-summarize.test.ts`
Expected: PASS, including every pre-existing case in the file.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run format:check
git add src/app/admin/audit/summarize.ts tests/audit-summarize.test.ts
git commit -m "feat(audit): curate summaries for tier.approved, account.merged and item_repriced"
```

---

### Task 2: `unlinkDiscord` service

**Files:**
- Modify: `src/services/discord-link.ts` (add one export; leave `linkDiscord` untouched)
- Test: `tests/discord-link.test.ts`

**Interfaces:**
- Consumes: `logAudit` and `enqueueSync`, both already imported by this module.
- Produces, relied on by Tasks 3 and 4:

```ts
export async function unlinkDiscord(
  dbx: DbTx,
  actor: string,
  accountId: string,
  reason: "self" | "admin",
): Promise<{ ok: true } | { ok: false; error: "not_found" | "not_linked" }>;
```

`actor` is who performed it (the member's own id, or the admin's), `accountId` is whose link is removed. They differ only on the admin path.

- [ ] **Step 1: Write the failing tests**

Add to `tests/discord-link.test.ts`. Put the helper next to the existing `ld` helper at :39-41:

```ts
// helper: run unlinkDiscord in a transaction (DbTx required)
const ud = (
  actor: string,
  accountId: string,
  reason: "self" | "admin" = "self",
) => ctx.db.transaction((tx) => unlinkDiscord(tx, actor, accountId, reason));
```

Extend the import at the top of the file to `import { linkDiscord, unlinkDiscord } from "@/services/discord-link";`, and add `auditLog` to the `@/db/schema` import. Extend the `TRUNCATE` in `beforeEach` to include `audit_log`:

```ts
beforeEach(() =>
  ctx.db.execute(
    sql`TRUNCATE account, discord_link, outbox, audit_log RESTART IDENTITY CASCADE`,
  ),
);
```

Then a new describe block:

```ts
describe("unlinkDiscord", () => {
  it("deletes the link and enqueues the deprovision", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-1");
    await ctx.db.delete(outbox);

    expect(await ud(a.id, a.id)).toEqual({ ok: true });
    expect(await ctx.db.select().from(discordLink)).toHaveLength(0);

    const payloads = (await ctx.db.select().from(outbox)).map((b) => b.payload);
    expect(payloads).toContainEqual({ kind: "discord-user", discordUserId: "duid-1" });
    // No new Discord user to provision, and contacts/wanderer do not depend on
    // Discord state, so an {kind:"account"} row here would be work for nothing.
    expect(payloads).toHaveLength(1);
  });

  it("writes an audit row naming who unlinked and why", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    const [admin] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-1");

    expect(await ud(admin.id, a.id, "admin")).toEqual({ ok: true });

    const rows = (await ctx.db.select().from(auditLog)).filter(
      (r) => r.action === "discord.unlinked",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(admin.id);
    // The freed discord user, not the account: matches the replacement path.
    expect(rows[0].target).toBe("duid-1");
    expect(rows[0].details).toEqual({ reason: "admin" });
  });

  it("reports an account that has no link", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    expect(await ud(a.id, a.id)).toEqual({ ok: false, error: "not_linked" });
    expect(await ctx.db.select().from(outbox)).toHaveLength(0);
  });

  it("reports an account that no longer exists", async () => {
    const gone = "00000000-0000-4000-8000-000000000000";
    expect(await ud(gone, gone)).toEqual({ ok: false, error: "not_found" });
  });

  // The account-row FOR UPDATE lock is the basis of the whole design, and the
  // sequential cases above never exercise it. Both operations lock the SAME
  // account row, so unlike the cross-account link race above they serialize
  // rather than conflict: neither is allowed to throw, and neither is allowed
  // to return an error. Promise.all, not allSettled — a rejection here is a
  // failure of the design, not an outcome to tolerate.
  it("concurrent link and unlink leave a consistent link and deprovision set", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-1");
    await ctx.db.delete(outbox);

    const [linked, unlinked] = await Promise.all([ld(a.id, "duid-2"), ud(a.id, a.id)]);
    // Whichever order the lock granted, both operations had work to do:
    // unlink-then-link finds duid-1 to free and then links duid-2;
    // link-then-unlink replaces duid-1 with duid-2 and then frees duid-2.
    expect(linked).toEqual({ ok: true });
    expect(unlinked).toEqual({ ok: true });

    const links = await ctx.db.select().from(discordLink);
    const deprovisioned = (await ctx.db.select().from(outbox))
      .map((b) => b.payload)
      .filter((p) => p.kind === "discord-user")
      .map((p) => (p as { discordUserId: string }).discordUserId);

    if (links.length === 0) {
      // unlink ran last: whatever it freed must be deprovisioned.
      expect(deprovisioned).toContain("duid-2");
    } else {
      // link ran last: it survives, and it must NOT be deprovisioned.
      expect(links[0].discordUserId).toBe("duid-2");
      expect(deprovisioned).not.toContain("duid-2");
    }
    // duid-1 is freed in either ordering.
    expect(deprovisioned).toContain("duid-1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/discord-link.test.ts`
Expected: FAIL at import — `unlinkDiscord` is not exported from `@/services/discord-link`.

- [ ] **Step 3: Implement**

Append to `src/services/discord-link.ts`:

```ts
/**
 * Remove an account's Discord link and leave it with none.
 *
 * The counterpart `linkDiscord` never had: its only `discord.unlinked` row is
 * the implicit one for a REPLACEMENT, so until now no path could end at zero
 * links. That gap is also why `merge_discord` had no remedy to name.
 *
 * Locks the account row first for the same reason `linkDiscord` does — a
 * concurrent link and unlink must serialize rather than interleave, or the
 * loser's deprovision can be written against a link the winner still owns.
 *
 * `enqueueSync` is not optional: the row deletion alone leaves the member
 * holding every managed Discord role. The deprovision handler
 * (src/jobs/discord-roles.ts) is written for exactly this payload and
 * re-checks for a link before stripping, so a re-link that lands mid-flight is
 * handled there rather than here.
 *
 * Deliberately does NOT enqueue `{kind:"account"}`. The replacement path does,
 * because it has a new Discord user to provision; an unlink has none, and
 * contacts and wanderer sync do not depend on Discord state.
 */
export async function unlinkDiscord(
  dbx: DbTx,
  actor: string,
  accountId: string,
  reason: "self" | "admin",
): Promise<{ ok: true } | { ok: false; error: "not_found" | "not_linked" }> {
  const locked = await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  // The merge deletes accounts outright, so an admin's control can outlive the
  // row it targets. Same race ADMIN_ACCOUNTS_ERRORS.not_found already explains.
  if (locked.length === 0) return { ok: false, error: "not_found" };

  const [removed] = await dbx
    .delete(discordLink)
    .where(eq(discordLink.accountId, accountId))
    .returning();
  if (!removed) return { ok: false, error: "not_linked" };

  await logAudit(dbx, {
    actor,
    action: "discord.unlinked",
    target: removed.discordUserId,
    details: { reason },
  });
  await enqueueSync(dbx, {
    kind: "discord-user",
    discordUserId: removed.discordUserId,
  });
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/discord-link.test.ts`
Expected: PASS, including the five pre-existing `linkDiscord` cases.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run format:check
git add src/services/discord-link.ts tests/discord-link.test.ts
git commit -m "feat(discord): add unlinkDiscord, the counterpart linkDiscord never had"
```

---

### Task 3: Member unlink on `/account`

**Files:**
- Modify: `src/app/account/actions.ts` (add one action)
- Modify: `src/app/account/page.tsx:252-268` (the Discord row)
- Test: `e2e/account.spec.ts`

**Interfaces:**
- Consumes: `unlinkDiscord` from Task 2, and the existing `requireAccount()` helper in `actions.ts:16-24`.
- Produces: `unlinkDiscordAction(): Promise<void>`, bound with no arguments — it only ever acts on the caller's own account.

- [ ] **Step 1: Add the server action**

In `src/app/account/actions.ts`, extend the service import to `import { setMainCharacter, unlinkCharacter, wakeSelf } from "@/services/accounts";` plus a new line `import { unlinkDiscord } from "@/services/discord-link";`, then append:

```ts
/** Member self-serve: disconnect Discord. Only ever the caller's own account,
 *  so `actor` and the target are the same id.
 *
 *  Both failures are a silent no-op. The control renders only when the account
 *  IS linked, so `not_linked` means a second submit or another tab got there
 *  first, and `not_found` cannot be reached by a member holding a live session
 *  for that very account. Same reasoning as `unlinkAction`'s rejections. */
export async function unlinkDiscordAction(): Promise<void> {
  const accountId = await requireAccount();
  await getDb().transaction((dbtx) =>
    unlinkDiscord(dbtx, accountId, accountId, "self"),
  );
  revalidatePath("/account");
}
```

- [ ] **Step 2: Render the control**

In `src/app/account/page.tsx`, extend the actions import to include `unlinkDiscordAction`. Replace the Discord `<dd>` (currently `:253-267`) with:

```tsx
<dd>
  {view.discordLinked ? (
    // Its own arm scope, not the manifest's: ConfirmSubmit throws outside
    // one (confirm-submit.tsx:113-116), and a scope of one is right here —
    // arming this must not disarm a character row three sections down.
    <ConfirmArmScope>
      <span className="inline-pair">
        <Status>linked</Status>
        <form action={unlinkDiscordAction} className="inline-form">
          <ConfirmSubmit
            className="btn btn--micro"
            armedClassName="btn btn--micro btn--danger"
            label="unlink"
            restName="unlink Discord"
            confirmName="confirm unlink Discord"
          />
        </form>
      </span>
    </ConfirmArmScope>
  ) : (
    // Raised to the default button grade: high-value but was the
    // weakest affordance on the page. Not gold — DESIGN.md rations
    // that to one primary action per view, "Add character" below.
    <a className="btn" href="/auth/discord/link">
      Link Discord
    </a>
  )}
</dd>
```

If `.inline-pair` does not already exist in `src/app/globals.css`, add it adjacent to the other inline helpers:

```css
/* A settled status token and the control that changes it, on one line. */
.inline-pair {
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
}
```

- [ ] **Step 3: Write the e2e test**

Add to `e2e/account.spec.ts`. Extend its `../src/db/schema` import to include `discordLink`:

```ts
test("a member can unlink their own Discord", async ({ page, context }) => {
  const member = await seedMember(db, { name: "Pilot", tier: "green" });
  await db.insert(discordLink).values({
    accountId: member.id,
    discordUserId: "duid-e2e",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await page.goto("/account");
  // Two clicks by design: ConfirmSubmit arms first, submits second.
  await page.getByRole("button", { name: "unlink Discord", exact: true }).click();
  await page
    .getByRole("button", { name: "confirm unlink Discord", exact: true })
    .click();

  await expect(page.getByRole("link", { name: "Link Discord" })).toBeVisible();
  expect(await db.select().from(discordLink)).toHaveLength(0);
});
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/account-page.test.ts
npx playwright test e2e/account.spec.ts
```

Expected: PASS. If the unit suite for the account page asserts on the Discord row's markup, update those assertions to match the new structure — do not weaken them.

- [ ] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run format:check
git add src/app/account/ src/app/globals.css e2e/account.spec.ts
git commit -m "feat(account): let a member disconnect their own Discord"
```

---

### Task 4: Admin unlink on `/admin/accounts`, and the `merge_discord` copy

The copy change ships here rather than on its own: it promises an admin control, so it must not land before one exists.

**Files:**
- Modify: `src/app/admin/accounts/actions.ts` (add one action)
- Modify: `src/app/admin/accounts/page.tsx:420-426` (the Discord cell)
- Modify: `src/lib/error-redirects.ts` (the `merge_discord` copy and the module doc)
- Test: `e2e/admin.spec.ts`

**Interfaces:**
- Consumes: `unlinkDiscord` from Task 2, plus the existing `requireAdminAction()` and `redirectOnMutationError()` in this file.
- Produces: `unlinkDiscordAction(accountId: string): Promise<void>`. Note this shares a name with Task 3's action but lives in a different module and takes an argument; they are not interchangeable.

- [ ] **Step 1: Add the server action**

In `src/app/admin/accounts/actions.ts`, add `import { unlinkDiscord } from "@/services/discord-link";` and append:

```ts
/** Admin control: disconnect a member's Discord.
 *
 *  This is what `ACCOUNT_ERRORS.merge_discord` now names. A member blocked
 *  from linking a character because the SOURCE account holds a Discord link
 *  cannot clear it themselves — they are signed in as the target — so without
 *  this the only remedy was signing out and back in as the accidental account.
 *
 *  `not_found` is the merge race every control here shares. `not_linked` is a
 *  stale tab: the cell renders the control only when the row says linked, and
 *  a second admin clearing it first is not an error worth a notice. */
export async function unlinkDiscordAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    unlinkDiscord(tx, actor, accountId, "admin"),
  );
  if (!result.ok && result.error === "not_found") {
    redirectOnMutationError("not_found");
  }
  revalidatePath("/admin/accounts");
}
```

Note the narrowing: `redirectOnMutationError` is exhaustive over `"not_authorized" | "not_found" | "not_pending"` and must not be widened to accept `not_linked`. Passing the literal keeps both of its exhaustiveness axes intact.

- [ ] **Step 2: Render the control**

In `src/app/admin/accounts/page.tsx`, extend the actions import to include `unlinkDiscordAction`, then replace the Discord `<td>` (currently `:420-426`) with:

```tsx
<td>
  {r.discordLinked ? (
    // Already inside the tbody-wide ConfirmArmScope (:253), like every
    // other confirm in this row. Names its row for the same reason the
    // Actions cell does: "unlink" read out of context says whose Discord
    // is about to be disconnected to nobody.
    <span className="inline-pair">
      <Status tone="ok">linked</Status>
      <form action={unlinkDiscordAction.bind(null, r.accountId)}>
        <ConfirmSubmit
          className="btn btn--micro"
          armedClassName="btn btn--micro btn--danger"
          label="unlink"
          restName={`unlink Discord for ${identity}`}
          confirmName={`confirm unlink Discord for ${identity}`}
        />
      </form>
    </span>
  ) : (
    <Status tone="off">none</Status>
  )}
</td>
```

`identity` is the row-naming variable the sibling controls in this component already use.

- [ ] **Step 3: Update the copy**

In `src/lib/error-redirects.ts`, move `merge_discord` up so it sits with the four admin-clearable codes rather than the three dead ends, and change its text to:

```ts
  merge_discord:
    "That character sits on an account with its own Discord link. An admin can remove it, then link it again.",
```

Then update the module doc: the sentence reading "the first four name a field an admin clears from /admin/accounts in seconds, and the last three have no cheap fix" becomes **five** and **two**. Add no import.

- [ ] **Step 4: Write the e2e test**

Add to `e2e/admin.spec.ts`, extending its `../src/db/schema` import to include `discordLink`:

```ts
test("an admin can unlink a member's Discord", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const member = await seedMember(db, { name: "Pilot", tier: "green" });
  await db.insert(discordLink).values({
    accountId: member.id,
    discordUserId: "duid-e2e",
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/admin/accounts");
  await page
    .getByRole("button", { name: "unlink Discord for Pilot", exact: true })
    .click();
  await page
    .getByRole("button", { name: "confirm unlink Discord for Pilot", exact: true })
    .click();

  await expect(
    page.getByRole("button", { name: "unlink Discord for Pilot", exact: true }),
  ).toHaveCount(0);
  expect(await db.select().from(discordLink)).toHaveLength(0);
});
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run tests/errors.test.ts tests/admin-accounts.test.ts
npx playwright test e2e/admin.spec.ts
```

Expected: PASS. `tests/errors.test.ts` covers the error-code maps; if it asserts the exact `merge_discord` string, update it to the new copy.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run format:check
git add src/app/admin/accounts/ src/lib/error-redirects.ts e2e/admin.spec.ts
git commit -m "feat(admin): unlink a member's Discord, and let merge_discord name it"
```

---

### Task 5: Pending-approval badge in the admin nav

**Files:**
- Modify: `src/app/_components/ui.tsx` (`NavItem` at :24, `SiteHeader` at :79-130)
- Modify: `src/app/_components/admin-nav.tsx`
- Modify: `src/app/admin/layout.tsx`
- Create: `src/app/admin/pending-count.ts`
- Modify: `src/app/globals.css` (two rules)
- Test: `e2e/shell.spec.ts`

**Interfaces:**
- Consumes: `countAccountsByTier(dbx, tier)` at `account-view.ts:367`.
- Produces:
  - `NavItem` gains `badge?: { count: number; description: string }`.
  - `AdminNav` gains a required prop: `AdminNav({ pendingCount }: { pendingCount: number })`.
  - `countPendingCached(): Promise<number>` exported from `src/app/admin/pending-count.ts`.

- [ ] **Step 1: Add the request-scoped count**

`/admin/accounts` would otherwise run this twice — once in the layout, once at `page.tsx:120` for the banner. `account.tier` is not indexed, so both are sequential scans.

It gets its own module rather than joining `src/services/account-view.ts`: every export there takes a `Dbx` parameter and the file never imports `getDb`. This helper must reach for the ambient db to be cacheable across a layout and its page, so putting it there would be the first exception to that file's convention, for a caller that is not a service.

Create `src/app/admin/pending-count.ts`:

```ts
import { cache } from "react";
import { getDb } from "@/db";
import { countAccountsByTier } from "@/services/account-view";

/**
 * `countAccountsByTier(db, "pending")` deduplicated per request. The admin
 * LAYOUT needs it for the nav badge and /admin/accounts needs it again for its
 * banner; a layout and its page render in one request, so `cache` collapses
 * them to a single query. Same idiom as src/app/payouts/[id]/page.tsx.
 *
 * No index is added for it. `tier` is a four-value enum on a table holding one
 * row per corp member, and Postgres scans a table that small either way.
 */
export const countPendingCached = cache(
  async (): Promise<number> => countAccountsByTier(getDb(), "pending"),
);
```

- [ ] **Step 2: Widen `NavItem` and render the badge**

In `src/app/_components/ui.tsx`, change the type at :24:

```ts
export type NavItem = {
  href: string;
  label: string;
  /** A count rendered beside the item. `description` is the visually-hidden
   *  text naming what the number counts; it lives on the item rather than in
   *  SiteHeader because this component is shared with the member nav. */
  badge?: { count: number; description: string };
};
```

In `SiteHeader`, replace the `items.map(…)` body (:107-115) with:

```tsx
{items.map((i) => {
  // Derived from href, not useId: SiteHeader is a server component and
  // cannot use hooks, and href is already the nav's identity key.
  const badgeId = `nav-badge-${i.href}`;
  const showBadge = i.badge !== undefined && i.badge.count > 0;
  return (
    // The pair is ONE flex child. .shell__nav wraps, so a bare sibling
    // span can land on the next line away from the link it belongs to.
    <span key={i.href} className="shell__navitem">
      <a
        href={i.href}
        aria-current={i.href === current ? (section ? "true" : "page") : undefined}
        // Described-by rather than inside the link: inside, the accessible
        // NAME becomes "Members 3 awaiting approval" on one load and
        // "Members" on the next — the same destination named two ways,
        // which is what WCAG 3.2.4 Consistent Identification forbids and
        // what the ITEMS comment in admin-nav.tsx exists to protect. A bare
        // sibling would keep the name but associate nothing: screen-reader
        // link navigation jumps link to link and would skip it entirely.
        aria-describedby={showBadge ? badgeId : undefined}
      >
        {i.label}
      </a>
      {showBadge && (
        <span id={badgeId} className="shell__badge">
          {i.badge!.count}
          <span className="visually-hidden"> {i.badge!.description}</span>
        </span>
      )}
    </span>
  );
})}
```

- [ ] **Step 3: Add the style**

In `src/app/globals.css`, beside the other `.shell__*` rules (near :360-376). One scoped rule; do not touch shared tokens.

```css
/* The pair a nav item and its badge form, so .shell__nav's flex-wrap moves
   them together rather than stranding the count on the next line. */
.shell__navitem {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--s-1) / 2);
}

/* A count, not an alert: the admin register label beside it is already quiet,
   and a filled pill here would outweigh the nav it sits in. */
.shell__badge {
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--track-control);
  color: var(--ink-faint);
}
```

- [ ] **Step 4: Thread the count through**

`src/app/_components/admin-nav.tsx` — keep `ITEMS` static and apply the badge at render:

```tsx
export function AdminNav({ pendingCount }: { pendingCount: number }) {
  const pathname = usePathname();
  // ITEMS stays static: the badge is derived per render, so the array is
  // still a module constant and the label text still cannot drift.
  const items = ITEMS.map((i) =>
    i.href === "/admin/accounts" && pendingCount > 0
      ? { ...i, badge: { count: pendingCount, description: "awaiting approval" } }
      : i,
  );
  return <SiteHeader items={items} current={pathname} admin />;
}
```

`src/app/admin/layout.tsx`:

```tsx
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage();
  const pendingCount = await countPendingCached();
  return (
    <>
      <AdminNav pendingCount={pendingCount} />
      {children}
    </>
  );
}
```

Add `import { countPendingCached } from "./pending-count";`.

Then in `src/app/admin/accounts/page.tsx:120`, replace `await countAccountsByTier(getDb(), "pending")` with `await countPendingCached()` (imported from `../pending-count`) so the page shares the layout's call, and drop the now-unused `countAccountsByTier` import if nothing else in the file uses it.

- [ ] **Step 5: Write the e2e test**

Add to `e2e/shell.spec.ts`. Three assertions, on a page that does NOT carry the banner — asserting only the link name would pass with no badge rendered at all, which is the likeliest way this ships broken.

```ts
test("the pending count reaches the admin nav, without renaming the tab", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await seedMember(db, { name: "Waiting One", tier: "pending" });
  await seedMember(db, { name: "Waiting Two", tier: "pending" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // /admin/audit, not /admin/accounts: there the badge is the only source of
  // the count, so a passing assertion cannot be the banner in disguise.
  await page.goto("/admin/audit");
  const members = page.getByRole("link", { name: "Members", exact: true });
  // The name is EXACTLY "Members" — the WCAG 3.2.4 invariant the
  // outside-the-link placement exists to hold.
  await expect(members).toBeVisible();
  await expect(page.locator(".shell__badge")).toHaveText("2awaiting approval");
  // ...and it is associated with the link, not merely next to it.
  const describedBy = await members.getAttribute("aria-describedby");
  expect(describedBy).toBe("nav-badge-/admin/accounts");

  await resetDb(db);
  const solo = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await context.clearCookies();
  await context.addCookies([await sessionCookieFor(db, solo.id)]);
  await page.goto("/admin/audit");
  await expect(page.locator(".shell__badge")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Members", exact: true }),
  ).not.toHaveAttribute("aria-describedby");
});
```

- [ ] **Step 6: Run the tests**

```bash
npx playwright test e2e/shell.spec.ts
npx vitest run tests/admin-accounts.test.ts
```

Expected: PASS, including the pre-existing `aria-current` test in `e2e/shell.spec.ts` — the markup changed around the links, and that test asserts exactly one `[aria-current]` inside `.shell__nav`, which the wrapper span must not disturb.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run format:check
git add src/app/_components/ src/app/admin/ src/app/globals.css e2e/shell.spec.ts
git commit -m "feat(admin): show the approval queue count on the Members tab"
```

---

### Task 6: Full gate and PR

**Files:** none modified unless a check fails.

- [ ] **Step 1: Run the whole suite**

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run test:e2e
```

Quote the real output of each. If `next dev` rewrote `tsconfig.json` or `AGENTS.md` during the e2e run, recover them with `git checkout --` — both are tracked; never delete them.

- [ ] **Step 2: Review the diff against the spec**

```bash
git diff origin/main --stat
git diff origin/main
```

Confirm every "Out of scope" item in the spec is genuinely untouched: audit target resolution for freed Discord ids, `admin.promoted`'s absence, the accounts-page banner, and any renderer for an action the spec left on the fallback.

- [ ] **Step 3: Re-derive the audit inventory**

The spec's completeness claim is only as good as its last check:

```bash
grep -rhno 'action: "[a-z_]*\.[a-z_]*"' src/ | sed 's/.*action: "//; s/"//' | sort -u > /tmp/all.txt
grep -o '"[a-z_]*\.[a-z_]*":' src/app/admin/audit/summarize.ts | sed 's/"//g; s/://' | sort -u > /tmp/mapped.txt
comm -23 /tmp/all.txt /tmp/mapped.txt | wc -l
```

Expected: `22` — the 25 unmapped actions at 782bf9c minus the 3 this plan maps.

- [ ] **Step 4: Open the PR**

```bash
gh auth status   # must be guarzo; gh auth switch -u guarzo if not
git push -u origin worktree-merge-followups
gh pr create --fill
```

Do not merge locally.

---

## Notes for the implementer

- **Two different `unlinkDiscordAction`s** exist by the end: one in `src/app/account/actions.ts` (no arguments, self only) and one in `src/app/admin/accounts/actions.ts` (takes an `accountId`). This is deliberate — each lives behind its own guard — but do not import one where the other is meant.
- **`discord.unlinked` needs no summarizer entry.** It is already in `PARTS` with `scalar("reason")`, and Task 2 writes the same `{reason}` payload shape the replacement path does. That is why Task 1 and Task 2 do not interact.
- **The audit row's target will render unresolved.** `discord.unlinked` targets the freed Discord id whose `discord_link` row was just deleted, so the audit page shows a raw snowflake. This is pre-existing behavior for the replacement path and is explicitly out of scope.

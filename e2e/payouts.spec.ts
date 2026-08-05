import { expect, test, type Locator, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import {
  auditLog,
  character,
  lootItem,
  lootPool,
  payoutOperation,
  payoutParticipant,
  payoutPayment,
} from "../src/db/schema";
import { centsToIsk, iskToCents } from "../src/core/payout-split";
import { OPEN_WINDOW_SCOPE } from "../src/lib/esi/client";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

test("the payouts list pages with an Older link", async ({ page, context }) => {
  const reader = await seedMember(db, { name: "List Reader", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, reader.id)]);

  // 51 operations: one more than PAYOUTS_PAGE_SIZE, newest first by date.
  await db.insert(payoutOperation).values(
    Array.from({ length: 51 }, (_, i) => ({
      name: `Op ${String(i).padStart(2, "0")}`,
      occurredAt: new Date(Date.UTC(2026, 6, 1) - i * 86_400_000),
    })),
  );

  await page.goto("/payouts");
  // The count is a page count now, so the heading must not claim a total.
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Op 00", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Op 49", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Op 50", exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Older" }).click();
  await expect(page).toHaveURL(/\/payouts\?before=/);
  await expect(page.getByRole("link", { name: "Op 50", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Op 00", exact: true })).toHaveCount(0);
  // Last page: nothing further to walk to.
  await expect(page.getByRole("link", { name: "Older" })).toHaveCount(0);
});

test("a malformed before param renders page 1 instead of failing", async ({
  page,
  context,
}) => {
  const reader = await seedMember(db, { name: "Cursor Reader", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, reader.id)]);
  await db.insert(payoutOperation).values({
    name: "Only fight",
    occurredAt: new Date("2026-07-01T00:00:00Z"),
  });

  await page.goto("/payouts?before=garbage");
  await expect(page.getByRole("link", { name: "Only fight" })).toBeVisible();
});

test("an alumni member is denied /payouts", async ({ page, context }) => {
  const acc = await seedMember(db, { name: "Alumni Pilot", tier: "alumni" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/payouts");
  await expect(page).toHaveURL(/\/account/);
});

test("a cryo member can read but not mutate", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "Active Operator",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Thursday roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);
  const opUrl = page.url();

  const cryo = await seedMember(db, {
    name: "Cryo Pilot",
    tier: "member",
    status: "cryo",
  });
  await context.clearCookies();
  await context.addCookies([await sessionCookieFor(db, cryo.id)]);

  // Read: the list and the detail both render for a cryo member.
  await page.goto("/payouts");
  await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();
  await expect(page.getByText("Thursday roam")).toBeVisible();
  // No create control for a non-operator reader.
  await expect(page.getByRole("link", { name: "New operation" })).toHaveCount(0);

  // Mutate: /payouts/new redirects a cryo member straight back out.
  await page.goto("/payouts/new");
  await expect(page).toHaveURL(/\/payouts$/);

  // The operation page itself renders (read access) with no edit forms.
  await page.goto(opUrl);
  await expect(page.getByRole("heading", { name: "Thursday roam" })).toBeVisible();
  await expect(page.getByLabel("Paste (names separated by /)")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finalize" })).toHaveCount(0);
});

test("create, add a flat pool, paste a roster, finalize, mark paid", async ({
  page,
  context,
}) => {
  // Regression guard: the operator's Finalize/Unlock controls used to sit in a
  // <p> wrapping a <form>, which is invalid HTML and React logs it as a
  // console error on every render regardless of hard vs. soft navigation.
  // Attached before the first navigation so it catches the very first paint
  // of the operation page (the create redirect).
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Thursday roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Thursday roam" })).toBeVisible();
  const opId = page.url().split("/").pop()!;

  // Every state change writes an audit row, and the row targets the operation
  // uuid — never a participant or pool id — so an auditor can find the whole
  // history of one operation under one target.
  const created = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "payout.created"), eq(auditLog.target, opId)));
  expect(created).toHaveLength(1);

  // A flat pool needs no external pricing service, which is what makes this
  // the deterministic path for e2e — the appraised path depends on triff.tools
  // being reachable and is exercised by msw-backed integration tests instead.
  await page.getByLabel("Total value (ISK)").fill("1000000");
  await page.getByLabel("Note (required — why this number)").fill("sold privately");
  await page.getByRole("button", { name: "Add flat pool" }).click();
  // Scoped to the pool row: with one pool, "1,000,000.00 ISK" also appears in
  // the operation's "Total loot" summary, so a bare getByText is ambiguous.
  // fmtIsk groups this display value with commas — the raw form no longer
  // appears on the page.
  const flatPoolRow = page.getByRole("row").filter({ hasText: "flat (manual)" });
  await expect(flatPoolRow).toContainText("1,000,000.00 ISK");

  await page
    .getByLabel("Paste (names separated by /)")
    .fill("Brain Tartare / Gustav Oswaldo");
  await page.getByRole("button", { name: "Set roster" }).click();
  await expect(page.getByText("Brain Tartare")).toBeVisible();
  await expect(page.getByText("Gustav Oswaldo")).toBeVisible();

  // 1,000,000 total, 10% corp share -> 900,000 pool, split evenly two ways
  // (both unresolved names get shares "1" and no account) -> 450,000.00 each.
  await expect(page.getByText("450,000.00 ISK")).toHaveCount(2);
  // The corp's actual cut is shown, not just the percentage — 10% of 1,000,000
  // plus whatever the per-share floor left behind (nothing, here).
  await expect(page.getByText("100,000.00 ISK")).toBeVisible();

  // Finalize is armed, not one-click: it commits every number on the page, and
  // only its creator or an admin can undo it.
  await page.getByRole("button", { name: "Finalize" }).click();
  await page.getByRole("button", { name: /^confirm finalize/ }).click();
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finalize" })).toHaveCount(0);
  // Finalizing freezes the numbers: the edit affordances go away until unlock.
  // This is the UI half of assertEditable's status check.
  await expect(page.getByLabel("Paste (names separated by /)")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add flat pool" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "delete" })).toHaveCount(0);

  const finalized = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "payout.finalized"), eq(auditLog.target, opId)));
  expect(finalized).toHaveLength(1);

  // The first payment is armed, because recording one is what makes the
  // operation permanently un-editable and un-unlockable. Every later one is a
  // click behind a door already shut, which is why the assertion below finds a
  // plain one-click button on the remaining row.
  await page.getByRole("button", { name: "mark paid" }).first().click();
  await page.getByRole("button", { name: /^confirm mark paid/ }).click();
  // exact: true — "paid" is a substring of the sibling row's "unpaid" status,
  // so a bare getByText matches both.
  await expect(page.getByText("paid", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "mark paid" })).toHaveCount(1);

  // Participants render ordered by display name, so "first" mark-paid button
  // belongs to Brain Tartare — confirm the audit row's target is the
  // *operation*, not that participant, and its details carry the participant.
  const [brainTartare] = await db
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.displayName, "Brain Tartare"));
  const paid = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "payout.paid"), eq(auditLog.target, opId)));
  expect(paid).toHaveLength(1);
  expect(paid[0].details).toMatchObject({ participantId: brainTartare.id });

  // No DOM-nesting console error anywhere in this run — the operator controls
  // (Finalize, then Unlock) rendered on every one of this test's page loads.
  expect(consoleErrors.filter((e) => e.includes("cannot be a descendant"))).toEqual([]);
});

test("pasting two alts of one account collapses them into one participant row", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await seedMember(db, {
    name: "Stealthbot",
    tier: "alumni",
    alts: ["Stealthbot Alt"],
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Roam with an alt");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();

  await page.getByLabel("Total value (ISK)").fill("200");
  await page.getByLabel("Note (required — why this number)").fill("flat test value");
  await page.getByRole("button", { name: "Add flat pool" }).click();

  // The pasted fleet has two names, one main and one of its own alts.
  await page
    .getByLabel("Paste (names separated by /)")
    .fill("Stealthbot / Stealthbot Alt");
  await page.getByRole("button", { name: "Set roster" }).click();

  // One row, not two: the alt collapses into its main's row, and the alt
  // spelling is retained alongside it rather than silently dropped.
  const rows = page.getByRole("row").filter({ hasText: "Stealthbot" });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Stealthbot Alt");
});

/**
 * An appraised pool with an item triff could not price is the one condition an
 * operator must not miss: the pool total is quietly short, so everyone is about
 * to be underpaid. The pool row is written directly here rather than through
 * the appraise form, because the form calls triff.tools and this suite must not
 * depend on an external service — `tests/appraisal.test.ts` covers the fetching.
 */
test("an unresolved loot item is named on the page, not silently priced at zero", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Short appraisal",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();
  const [poolRow] = await db
    .insert(lootPool)
    .values({
      operationId: op.id,
      valuationSource: "appraised",
      pricingMode: "sell_best",
      stationId: 60003760,
      totalValue: "100.00",
    })
    .returning();
  await db.insert(lootItem).values([
    {
      poolId: poolRow.id,
      typeId: 34,
      name: "Tritanium",
      qty: 10,
      unitPrice: "10.00",
      totalValue: "100.00",
      priceSource: "triff",
    },
    {
      poolId: poolRow.id,
      typeId: null,
      name: "Nyx",
      qty: 1,
      unitPrice: "0.00",
      totalValue: "0.00",
      priceSource: "unresolved",
    },
  ]);

  await page.goto(`/payouts/${op.id}`);
  // `generateMetadata` names the operation the tab is showing. Pinned on a
  // page that exists, opposite the 404 case in `not-found.spec.ts`: without
  // this, a loader that returned null for everything would still pass there.
  await expect(page).toHaveTitle("Short appraisal · Zoo Landers");
  await expect(page.getByText("1 item priced at 0.00")).toBeVisible();
  // The name matters — "1 item" alone doesn't tell you it's a supercarrier.
  await expect(page.getByText("Nyx ×1")).toBeVisible();
});

/**
 * appraiseLoot rounds once at the line total, so a line with a genuine
 * sub-cent per-unit price stores unitPrice "0.00" while totalValue is real and
 * already counted in the pool. This is a different condition from an
 * unresolved item (no price found at all) and must render a different notice,
 * or an operator reading "0.00" has no way to tell "free" from "rounds to
 * free but the line total is real".
 */
test("a resolved sub-cent unit price is marked as real value, distinct from unresolved", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Bulk ammo haul",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();
  const [poolRow] = await db
    .insert(lootPool)
    .values({
      operationId: op.id,
      valuationSource: "appraised",
      pricingMode: "sell_best",
      stationId: 60003760,
      totalValue: "5.00",
    })
    .returning();
  await db.insert(lootItem).values({
    poolId: poolRow.id,
    typeId: 34,
    name: "Tritanium",
    qty: 1000,
    // 1000 units at well under 0.01 ISK each round the *line* total to a real
    // 5.00 ISK, while the stored per-unit price rounds to 0.00 for display.
    unitPrice: "0.00",
    totalValue: "5.00",
    priceSource: "triff",
  });

  await page.goto(`/payouts/${op.id}`);
  await expect(page.getByText("1 item priced under 0.01 ISK each")).toBeVisible();
  await expect(page.getByText("Tritanium ×1000 (5.00 ISK)")).toBeVisible();
  // The unresolved-item notice is a different warning and must not fire here —
  // this line has a real price source, not "unresolved".
  await expect(page.getByText("priced at 0.00", { exact: false })).toHaveCount(0);
});

/**
 * Two payout_participant rows sharing an unresolved display name is
 * unreachable through the UI in this PR — parseRosterPaste dedupes
 * case-insensitively and setRoster fully replaces the roster on every submit,
 * so no single paste can produce it. The warning stays wired up because the
 * next PR's manual participant entry is exactly what makes this reachable,
 * and two rows silently drawing a full share each under one name is the
 * failure the warning exists to prevent. Seeded directly since the UI cannot
 * produce the condition it guards against.
 */
test("two participant rows sharing an unresolved name trigger the duplicate-name warning", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Double-counted roster",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();
  await db.insert(payoutParticipant).values([
    { operationId: op.id, displayName: "Ghost Pilot", accountId: null, shares: "1" },
    { operationId: op.id, displayName: "Ghost Pilot", accountId: null, shares: "1" },
  ]);

  await page.goto(`/payouts/${op.id}`);
  await expect(page.getByText("1 unresolved name appears more than once")).toBeVisible();
  await expect(page.getByText("Ghost Pilot", { exact: true }).first()).toBeVisible();
});

/**
 * The service allows a resolved row and an unresolved row to share a display
 * name (see `addParticipant`'s guard, which only ever compares unresolved
 * rows against each other) — the resolved row's own accountId makes it
 * unambiguous downstream regardless of what an unresolved row is also
 * called. This is the direction reachable through the real UI: a roster
 * pasted before a pilot's ESI link existed leaves them unresolved, and adding
 * that now-linked pilot by name must not be refused, just warned about.
 *
 * The other direction — a resolved row whose underlying character has since
 * been renamed or removed, so it now happens to share a name with an
 * unresolved row already on the roster — cannot be produced by driving the
 * UI, because nothing in this app renames or deletes a character out from
 * under a roster row. It is covered directly against `deriveRosterWarnings`
 * in tests/payout-roster-warnings.test.ts instead.
 */
test("adding a linked pilot under a name already on the roster unresolved warns instead of refusing", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await seedMember(db, { name: "Echo Pilot", tier: "alumni" });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Late link",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();
  // The night-of roster: "Echo Pilot" pasted before their ESI link existed.
  await db.insert(payoutParticipant).values({
    operationId: op.id,
    displayName: "Echo Pilot",
    accountId: null,
    shares: "1",
  });

  await page.goto(`/payouts/${op.id}`);
  // The roster is already populated here, so the edit disclosure starts closed —
  // unlike every other test on this page, which builds an operation up from empty.
  await page.locator("summary", { hasText: "Edit roster" }).click();
  await page.getByLabel("Character name").fill("Echo Pilot");
  await page.getByRole("button", { name: "Add participant" }).click();

  // Not refused: both rows are on the roster now.
  await expect(page.getByRole("row").filter({ hasText: "Echo Pilot" })).toHaveCount(2);
  await expect(page.locator("p.notice--bad")).toHaveCount(0);
  await expect(
    page.getByText("both linked and unlinked", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Echo Pilot", { exact: true }).first()).toBeVisible();
});

/**
 * The corp cut is derived, not stored (see payout-view's getPayoutOperationDetail):
 * total loot minus every participant's amount. This asserts that identity holds
 * against the database directly after each mutation, not just that the page
 * renders *some* number — a bug that stored a stale corp amount, or that left an
 * excluded/removed participant's share unaccounted for, would still render a
 * plausible-looking figure without this check.
 */
async function assertReconciles(page: Page, operationId: string): Promise<void> {
  const [pools, participants] = await Promise.all([
    db.select().from(lootPool).where(eq(lootPool.operationId, operationId)),
    db
      .select()
      .from(payoutParticipant)
      .where(eq(payoutParticipant.operationId, operationId)),
  ]);
  const totalCents = pools.reduce((sum, p) => sum + iskToCents(p.totalValue), 0n);
  const assignedCents = participants.reduce((sum, p) => sum + iskToCents(p.amount), 0n);
  const corpDd = page.locator("dd.mono", { hasText: "remainder" });
  await expect(corpDd).toContainText(`${centsToIsk(totalCents - assignedCents)} ISK`);
}

test("setting shares, excluding, and removing a participant each recompute exact ISK amounts and reconcile against the total", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Split adjustments");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Split adjustments" })).toBeVisible();
  const opId = page.url().split("/").pop()!;

  // The create form no longer collects corp share (it defaults to 10%) — set
  // it to 0 here through the detail page's own editor so the even-split math
  // below stays exact.
  await page.getByLabel("Corp share %").fill("0");
  await page.getByRole("button", { name: "save corp share" }).click();

  await page.getByLabel("Total value (ISK)").fill("300");
  await page.getByLabel("Note (required — why this number)").fill("even split test");
  await page.getByRole("button", { name: "Add flat pool" }).click();

  await page
    .getByLabel("Paste (names separated by /)")
    .fill("Alice Pilot / Bob Pilot / Carol Pilot");
  await page.getByRole("button", { name: "Set roster" }).click();

  const rowFor = (name: string) => page.getByRole("row").filter({ hasText: name });

  // Baseline: 300 ISK, 0% corp share, three equal shares -> 100.00 each.
  await expect(rowFor("Alice Pilot")).toContainText("100.00 ISK");
  await expect(rowFor("Bob Pilot")).toContainText("100.00 ISK");
  await expect(rowFor("Carol Pilot")).toContainText("100.00 ISK");
  await assertReconciles(page, opId);

  // setParticipantSharesAction: Carol takes 2 shares -> 4 total shares over
  // the same 300 pool -> 75.00 / 75.00 / 150.00.
  await page.getByLabel("Shares for Carol Pilot").fill("2");
  await rowFor("Carol Pilot").getByRole("button", { name: "save" }).click();
  await expect(rowFor("Alice Pilot")).toContainText("75.00 ISK");
  await expect(rowFor("Bob Pilot")).toContainText("75.00 ISK");
  await expect(rowFor("Carol Pilot")).toContainText("150.00 ISK");
  await assertReconciles(page, opId);

  // setParticipantExcludedAction: excluding Bob moves his share to the rest
  // (Alice 1 share, Carol 2 shares, 3 total) -> 100.00 / 200.00. Bob's own
  // amount goes to 0.00 — a stale 75.00 would still "look" excluded in the
  // State column while quietly holding money back from the pool.
  await rowFor("Bob Pilot").getByRole("button", { name: "exclude" }).click();
  await expect(rowFor("Bob Pilot")).toContainText("excluded");
  await expect(rowFor("Bob Pilot")).toContainText("0.00 ISK");
  await expect(rowFor("Alice Pilot")).toContainText("100.00 ISK");
  await expect(rowFor("Carol Pilot")).toContainText("200.00 ISK");
  await assertReconciles(page, opId);

  // removeParticipantAction: removing Carol leaves Alice as the only included
  // participant, so she draws the whole pool. Remove is armed — it drops the
  // row outright, unlike the `exclude` sitting beside it, which is reversible
  // and stays one-click.
  await rowFor("Carol Pilot").getByRole("button", { name: "remove" }).click();
  await rowFor("Carol Pilot")
    .getByRole("button", { name: /^confirm remove/ })
    .click();
  await expect(rowFor("Carol Pilot")).toHaveCount(0);
  await expect(rowFor("Alice Pilot")).toContainText("300.00 ISK");
  await assertReconciles(page, opId);
});

/**
 * Puts a value into a field the form's own markup would refuse to submit.
 * The client guards are the first line and they work — which is exactly why
 * the server-side check standing behind them can only be reached by going
 * around them, the way a scripted or non-conforming client would. Without
 * this, the server checks look covered and are not: the browser silently
 * blocks the submit and the test passes on the wrong page.
 */
async function bypassClientGuard(input: Locator, value: string): Promise<void> {
  await input.evaluate((el, v) => {
    const field = el as HTMLInputElement;
    field.removeAttribute("min");
    field.removeAttribute("max");
    field.removeAttribute("pattern");
    field.type = "text";
    field.value = v;
  }, value);
}

/*
 * Operator input used to `throw`, which landed on error.tsx — "Something broke…
 * that's a fault on this end, not something you did." For a mistyped share
 * percentage that copy is a lie, and the form's contents went with it. Same
 * conversion `requireAdminAction` already went through (see e2e/admin.spec.ts).
 *
 * A code with no entry in either error map (NEW_OPERATION_ERRORS /
 * OPERATION_ERRORS) renders nothing at all, which is the one failure these
 * pages cannot show the operator, so each is checked by name. `p.notice--bad`,
 * never getByRole("alert"): arriving here from a server
 * action is a soft navigation, so Next's route announcer is populated and also
 * carries role="alert".
 */
for (const [code, phrase] of [
  ["name_required", "needs a name"],
  ["date_invalid", "real calendar date"],
] as const) {
  test(`/payouts/new explains ?error=${code}`, async ({ page, context }) => {
    const operator = await seedMember(db, {
      name: "FC Codes",
      tier: "member",
      status: "active",
    });
    await context.addCookies([await sessionCookieFor(db, operator.id)]);
    await page.goto(`/payouts/new?error=${code}`);
    await expect(page.locator("p.notice--bad")).toContainText(phrase);
    await expect(page.getByText("Something broke")).toHaveCount(0);
  });
}

for (const [code, phrase] of [
  ["appraisal_failed", "did not answer"],
  ["pricing_mode", "four pricing modes"],
  ["location_kind", "exactly one"],
  ["station_invalid", "60003760"],
  ["region_invalid", "Region ID must be digits"],
  ["note_required", "where the number came from"],
  ["total_invalid", "no commas"],
  ["shares_required", "cannot be blank"],
  ["shares_invalid", "plain number like 1"],
  ["shares_positive", "greater than zero"],
  ["shares_range", "cannot exceed 9999.99"],
  ["share_format", "plain percentage"],
  ["share_range", "cannot exceed 100%"],
  ["participant_name_required", "Type a character name"],
  ["participant_duplicate", "already on this roster"],
  ["open_info_reauth", "permission your login does not carry"],
  ["open_info_target", "cannot be opened"],
  ["open_info_offline", "not logged in"],
  ["open_info_busy", "rate-limiting"],
  ["open_info_timeout", "took too long"],
  ["open_info_failed", "Could not open that window"],
  ["open_info_dry_run", "dry-run mode"],
  ["delete_has_paid", "Revert every payment first"],
] as const) {
  test(`the operation page explains ?error=${code}`, async ({ page, context }) => {
    const operator = await seedMember(db, {
      name: "FC Codes",
      tier: "member",
      status: "active",
    });
    await context.addCookies([await sessionCookieFor(db, operator.id)]);
    const [op] = await db
      .insert(payoutOperation)
      .values({
        name: "Error code coverage",
        occurredAt: new Date("2026-08-01"),
        corpSharePct: "0",
        createdBy: operator.id,
      })
      .returning();
    await page.goto(`/payouts/${op.id}?error=${code}`);
    await expect(page.locator("p.notice--bad")).toContainText(phrase);
    await expect(page.getByText("Something broke")).toHaveCount(0);
  });
}

// An unknown code must degrade to the plain page, never an empty notice box.
test("payout pages ignore an unrecognised error code", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "FC Unknown",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  await page.goto("/payouts/new?error=not_a_real_code");
  await expect(page.locator("p.notice--bad")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create operation" })).toBeVisible();
});

/*
 * The round trip the redirect exists for: a rejected create form comes back
 * with the other field still filled in. Retyping the name because the date
 * was bad (or vice versa) is the actual cost of the old throw, and the only
 * way to catch a regression in it is to submit a bad value and read the good
 * one back off the form.
 */
test("a rejected create form comes back filled in", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "FC Roundtrip",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Hard-won roam");
  // type="date" stops free text in the browser, so reaching the server check
  // at all means going around the client guard.
  await bypassClientGuard(page.getByLabel("Date"), "not-a-date");
  await page.getByRole("button", { name: "Create operation" }).click();

  await expect(page).toHaveURL(/\/payouts\/new\?/);
  await expect(page.locator("p.notice--bad")).toContainText("real calendar date");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // The rejected value never survives here: a genuinely invalid date cannot
  // be displayed by a `type="date"` input regardless of what the query string
  // carries, so the round trip this test actually pins is Name's.
  await expect(page.getByLabel("Name")).toHaveValue("Hard-won roam");

  // And the corrected submit goes through, so the echoed name is real form
  // state and not just decoration on an error page.
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Hard-won roam" })).toBeVisible();
});

/*
 * corpSharePct used to be write-once: an operator who accepted the create
 * form's default committed the whole roster to 0% with no way back short of
 * deleting the operation. This is the correction path, and the recalculation
 * that has to follow it — changing the percentage moves every participant's
 * amount, so a version that only wrote the column would look right on this
 * page and pay out wrong.
 */
test("corp share can be corrected after creation, and the split follows", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Corpshare",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Corp share fix");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);
  const opId = page.url().split("/").pop()!;

  // The create form defaults corp share to 10% — drop it to 0% through the
  // detail page's own editor so the baseline below is the even split this
  // test's math depends on, before the correction to 20% under test.
  await page.getByLabel("Corp share %").fill("0");
  await page.getByRole("button", { name: "save corp share" }).click();

  await page.getByLabel("Total value (ISK)").fill("1000");
  await page.getByLabel("Note (required — why this number)").fill("flat");
  await page.getByRole("button", { name: "Add flat pool" }).click();
  await page
    .getByLabel("Paste (names separated by /)")
    .fill("Alice Pilot / Brain Tartare");
  await page.getByRole("button", { name: "Set roster" }).click();
  await expect(page.getByText("500.00 ISK").first()).toBeVisible();

  await page.getByLabel("Corp share %").fill("20");
  await page.getByRole("button", { name: "save corp share" }).click();

  await expect(page.getByText("20.00% + remainder")).toBeVisible();
  // 20% of 1000 off the top, then an even split of the 800 that remains.
  await expect(page.getByText("200.00 ISK").first()).toBeVisible();
  await expect(page.getByText("400.00 ISK").first()).toBeVisible();
  await assertReconciles(page, opId);

  const changed = await db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.action, "payout.corp_share_changed"), eq(auditLog.target, opId)),
    );
  // Two rows: dropping the create form's 10% default to 0% above, then this
  // correction to 20% — both are edits through the same action, audited alike.
  expect(changed).toHaveLength(2);
  expect(changed[1].details).toMatchObject({ corpSharePct: "20" });

  // Out-of-range comes back as a message on the page, not error.tsx, and the
  // stored value is untouched.
  await bypassClientGuard(page.getByLabel("Corp share %"), "150");
  await page.getByRole("button", { name: "save corp share" }).click();
  await expect(page.locator("p.notice--bad")).toContainText("cannot exceed 100%");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  await expect(page.getByText("20.00% + remainder")).toBeVisible();
});

/*
 * The shares control is the one an operator touches most, so it gets the
 * end-to-end version of the check: text and zero both land back on the page
 * with a specific message rather than on error.tsx. Text is the important one
 * — iskToCents *throws* on it, so a naive positivity guard would escape past
 * the redirect it was meant to trigger.
 */
test("bad shares land on the page, not the error boundary", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "FC Shares",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Shares guard");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);

  await page.getByLabel("Total value (ISK)").fill("100");
  await page.getByLabel("Note (required — why this number)").fill("flat");
  await page.getByRole("button", { name: "Add flat pool" }).click();
  await page.getByLabel("Paste (names separated by /)").fill("Alice Pilot");
  await page.getByRole("button", { name: "Set roster" }).click();

  // type=number, so the browser refuses to submit text at all.
  await bypassClientGuard(page.getByLabel("Shares for Alice Pilot"), "abc");
  await page.getByRole("button", { name: "save Alice Pilot shares" }).click();
  await expect(page.locator("p.notice--bad")).toContainText("plain number like 1");
  await expect(page.getByText("Something broke")).toHaveCount(0);

  await bypassClientGuard(page.getByLabel("Shares for Alice Pilot"), "0");
  await page.getByRole("button", { name: "save Alice Pilot shares" }).click();
  await expect(page.locator("p.notice--bad")).toContainText("greater than zero");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // The stored value survived both rejections.
  await expect(page.getByLabel("Shares for Alice Pilot")).toHaveValue("1.00");
});

/**
 * The whole phase-2 money loop in one pass: override an item price, finalize,
 * pay, revert, pay again.
 *
 * The pool and its item are written directly rather than through the appraise
 * form, for the same reason the unresolved-item test above does it: the form
 * calls triff.tools, and this suite must not depend on an external service.
 * The override itself goes through the UI, because that is what is under test.
 */
test("override an item price, finalize, pay, revert, and pay again", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Repriced haul",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();
  const [poolRow] = await db
    .insert(lootPool)
    .values({
      operationId: op.id,
      valuationSource: "appraised",
      pricingMode: "sell_best",
      stationId: 60003760,
      totalValue: "100.00",
    })
    .returning();
  await db.insert(lootItem).values({
    poolId: poolRow.id,
    typeId: 34,
    name: "Tritanium",
    qty: 10,
    unitPrice: "10.00",
    totalValue: "100.00",
    priceSource: "triff",
  });

  await page.goto(`/payouts/${op.id}`);
  // The item table is behind the disclosure, so a 200-line paste cannot bury
  // the roster — nothing inside it is reachable until it is opened.
  // exact: true — the save button beside this field is named "save unit
  // price for Tritanium", which is this label's text with a prefix, and
  // getByLabel's default substring match would count both.
  //
  // not.toBeVisible(), not toHaveCount(0): Disclosure is built on native
  // <details> precisely so a browser can still find text in a collapsed
  // section (see disclosure.tsx), so the field stays in the DOM while
  // closed — only its visibility (and reachability) changes.
  await expect(
    page.getByLabel("Unit price for Tritanium", { exact: true }),
  ).not.toBeVisible();
  await page.locator("summary", { hasText: "Pool 1 items (1)" }).click();

  await page.getByLabel("Unit price for Tritanium", { exact: true }).fill("25.00");
  await page.getByRole("button", { name: "save unit price for Tritanium" }).click();

  // 25.00 x 10, exactly — the line total, the pool total and the operation
  // total all re-derive from the override.
  //
  // No second click here: Disclosure's open state is React state that
  // survives the server action's revalidatePath re-render (see
  // e2e/admin.spec.ts's row-drawer tests), so the pool section is still open
  // from the click above — a second click here would close it again.
  const itemRow = page.getByRole("row").filter({ hasText: "Tritanium" });
  await expect(itemRow).toContainText("250.00 ISK");
  await expect(itemRow).toContainText("manual");
  const poolRowLocator = page.getByRole("row").filter({ hasText: "appraised" });
  await expect(poolRowLocator).toContainText("250.00 ISK");

  await page
    .getByLabel("Paste (names separated by /)")
    .fill("Brain Tartare / Gustav Oswaldo");
  await page.getByRole("button", { name: "Set roster" }).click();
  const rowFor = (name: string) => page.getByRole("row").filter({ hasText: name });
  await expect(rowFor("Brain Tartare")).toContainText("125.00 ISK");

  // Finalize and the FIRST mark-paid are both armed (#74): one click arms, the
  // second submits. The first payment is what freezes the operation for good,
  // which is what the arm step is guarding.
  await page.getByRole("button", { name: "Finalize" }).click();
  await page.getByRole("button", { name: /^confirm finalize/ }).click();
  await rowFor("Brain Tartare").getByRole("button", { name: "mark paid" }).click();
  await page.getByRole("button", { name: /^confirm mark paid/ }).click();
  // exact: true — "unpaid" contains "paid" as a substring, so a plain
  // toContainText("paid") is satisfied by the row's PRIOR "unpaid" status and
  // never actually waits for the update this click causes. Scoped to the
  // Status badge's own exact text, same as line ~199 above.
  await expect(rowFor("Brain Tartare").getByText("paid", { exact: true })).toBeVisible();

  // The freeze is permanent, and the page has to say so where the operator is
  // about to reach for revert — an operator who reverts expecting to fix the
  // roster has been misled.
  await expect(page.getByText("This operation is frozen")).toBeVisible();
  await expect(
    page.getByText("Reverting a payment does not reopen editing"),
  ).toBeVisible();

  // Revert arms on the first click and only fires on the second.
  const revert = rowFor("Brain Tartare").getByRole("button", { name: /^revert/ });
  await revert.click();
  await rowFor("Brain Tartare")
    .getByRole("button", { name: /^confirm revert/ })
    .click();
  await expect(rowFor("Brain Tartare")).toContainText("unpaid");

  // Paying again is the whole point of clearing paidAmount — without it a
  // reverted participant could never be paid, which defeats the feature.
  //
  // ONE click, not two: the arm step is keyed on `firstPayment` (`!locked`),
  // and the operation is still frozen — `hasPayments` counts payment rows, and
  // reverting appended a row rather than deleting one. This assertion is what
  // pins that: if the arm were keyed on "somebody is currently paid" instead,
  // this click would only arm the control and the row would still read unpaid.
  await rowFor("Brain Tartare").getByRole("button", { name: "mark paid" }).click();
  // Same exact-text scoping as the first mark-paid above, and it matters more
  // here: without it, this assertion is satisfied by the row's own prior
  // "unpaid" text and returns before the server action's insert has even
  // committed, so the DB read just below races an in-flight transaction.
  await expect(rowFor("Brain Tartare").getByText("paid", { exact: true })).toBeVisible();

  // Three events, in the order they happened, oldest first.
  const [brainTartare] = await db
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.displayName, "Brain Tartare"));
  const events = await db
    .select()
    .from(payoutPayment)
    .where(eq(payoutPayment.participantId, brainTartare.id));
  expect(events).toHaveLength(3);

  await rowFor("Brain Tartare").locator("summary", { hasText: "payments (3)" }).click();
  const history = rowFor("Brain Tartare").locator("li");
  await expect(history).toHaveCount(3);
  await expect(history.nth(0)).toContainText("paid");
  await expect(history.nth(1)).toContainText("reverted");
  await expect(history.nth(2)).toContainText("paid");

  // The revert is audited like every other state change, and targets the
  // OPERATION uuid so one operation's history stays under one target.
  const reverted = await db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.action, "payout.payment_reverted"), eq(auditLog.target, op.id)),
    );
  expect(reverted).toHaveLength(1);
});

/*
 * The unit-price control is the other money input on the page, alongside
 * shares (see "bad shares land on the page, not the error boundary" above) —
 * a malformed value must land back on the page with a specific message
 * rather than on error.tsx, and the stored price must survive the rejection.
 */
test("bad unit price lands on the page, not the error boundary", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Price",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Price guard",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();
  const [poolRow] = await db
    .insert(lootPool)
    .values({
      operationId: op.id,
      valuationSource: "appraised",
      pricingMode: "sell_best",
      stationId: 60003760,
      totalValue: "100.00",
    })
    .returning();
  await db.insert(lootItem).values({
    poolId: poolRow.id,
    typeId: 34,
    name: "Tritanium",
    qty: 10,
    unitPrice: "10.00",
    totalValue: "100.00",
    priceSource: "triff",
  });

  await page.goto(`/payouts/${op.id}`);
  await page.locator("summary", { hasText: "Pool 1 items (1)" }).click();

  // type=number, so the browser refuses to submit text or a comma-grouped
  // value at all — bypassClientGuard drives it the way a scripted client
  // (or EVE's own comma-grouped paste) would.
  await bypassClientGuard(
    page.getByLabel("Unit price for Tritanium", { exact: true }),
    "1,234.00",
  );
  await page.getByRole("button", { name: "save unit price for Tritanium" }).click();
  await expect(page.locator("p.notice--bad")).toContainText("plain number like 12.34");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // The stored value survived the rejection.
  await expect(page.getByLabel("Unit price for Tritanium", { exact: true })).toHaveValue(
    "10.00",
  );
});

/**
 * The datalist is inert HTML, not a type-ahead: it ships with the page, the
 * browser filters it, and the form submits without JavaScript. This asserts
 * the options are in the document — the browser's own popup is not something
 * Playwright can or should drive.
 */
test("manual participant entry offers known character names and adds one", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await seedMember(db, { name: "Latecomer Pilot", tier: "alumni" });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Late arrival",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();

  await page.goto(`/payouts/${op.id}`);
  await expect(page.locator("datalist option[value='Latecomer Pilot']")).toHaveCount(1);

  await page.getByLabel("Character name").fill("Latecomer Pilot");
  await page.getByRole("button", { name: "Add participant" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Latecomer Pilot" })).toHaveCount(
    1,
  );
});

/**
 * The one new rejection an operator can actually reach by using the form
 * normally, so it gets the round trip rather than only a rendered `?error=`
 * case: nothing in the markup stops a name being typed twice, and two rows
 * under one name pay two full shares to whoever answers to it.
 *
 * `participant_name_required` has no round trip because it cannot have one —
 * the field is `required`, and `bypassClientGuard` deliberately does not strip
 * that. Its coverage is the table-driven case in Step 1.
 */
test("adding the same name twice is refused on the page, not on the error boundary", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Double add",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();

  await page.goto(`/payouts/${op.id}`);
  await page.getByLabel("Character name").fill("Twice Pilot");
  await page.getByRole("button", { name: "Add participant" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Twice Pilot" })).toHaveCount(1);

  await page.getByLabel("Character name").fill("Twice Pilot");
  await page.getByRole("button", { name: "Add participant" }).click();
  // p.notice--bad, never getByRole("alert"): this is a soft navigation, so
  // Next's route announcer carries role="alert" too.
  await expect(page.locator("p.notice--bad")).toContainText("already on this roster");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // And the roster is unchanged — the rejection added nothing.
  await expect(page.getByRole("row").filter({ hasText: "Twice Pilot" })).toHaveCount(1);
});

/**
 * The open-info control is gated on the operator's own PERSISTED scopes, and
 * is hidden rather than disabled when the grant is absent.
 *
 * The scope is written straight onto the seeded character row. Widening the
 * scope list in `tests/helpers/config.ts` or `playwright.config.ts` would be
 * the wrong lever twice over: it flips unrelated assertions in
 * `tests/account-view.test.ts:73-81` and `tests/accounts.test.ts:289`, and it
 * would test config rather than the gate — the whole point of the gate is that
 * a persisted grant, not a configured request, decides.
 *
 * Nothing here clicks the control. Doing so would call EVE SSO and ESI for
 * real; the four `open_info_*` outcomes are covered as units in
 * `tests/tokens.test.ts` and `tests/esi-client.test.ts`.
 */
test("open info appears only for an operator whose character granted the scope", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  const recipient = await seedMember(db, { name: "Paid Pilot", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  // The control also needs a resolved recipient — it is the ESI target_id, and
  // an unresolved participant name has none. seedMember allocates the character
  // id internally, so read it back rather than guessing.
  const [recipientChar] = await db
    .select()
    .from(character)
    .where(eq(character.accountId, recipient.id));

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Scope check",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      status: "finalized",
      createdBy: operator.id,
    })
    .returning();
  await db.insert(payoutParticipant).values({
    operationId: op.id,
    accountId: recipient.id,
    recipientCharacterId: recipientChar.id,
    displayName: "Paid Pilot",
    shares: "1",
    amount: "100.00",
  });

  // seedMember writes `scopes: []`, so this is the no-grant case.
  await page.goto(`/payouts/${op.id}`);
  const row = page.getByRole("row").filter({ hasText: "Paid Pilot" });
  await expect(row.getByRole("button", { name: "open info for Paid Pilot" })).toHaveCount(
    0,
  );
  // The scope-free controls are unaffected — an operator without the grant
  // loses nothing phase 1 gave them.
  await expect(row.getByRole("button", { name: "copy amount" })).toHaveCount(1);

  await db
    .update(character)
    .set({ scopes: [OPEN_WINDOW_SCOPE] })
    .where(eq(character.accountId, operator.id));

  await page.reload();
  await expect(row.getByRole("button", { name: "open info for Paid Pilot" })).toHaveCount(
    1,
  );
});

/*
 * The destructive path, end to end and through the arming control. The service
 * rules are covered exhaustively in tests/payouts-service.test.ts; what only a
 * browser can show is that the admin-only section renders, that the two-press
 * arm actually reaches the action, and that the delete leaves the page it just
 * destroyed instead of revalidating a row that no longer exists.
 */
test("an admin deletes an operation, and the audit row outlives it", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, {
    name: "Admin Prime",
    tier: "member",
    status: "active",
    isAdmin: true,
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Mistaken op");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  // The heading first: `page.url()` is read synchronously and would otherwise
  // catch the pre-redirect `/payouts/new`, handing every later query the
  // literal id "new".
  await expect(page.getByRole("heading", { name: "Mistaken op" })).toBeVisible();
  const opId = page.url().split("/").pop()!;

  await page.getByLabel("Total value (ISK)").fill("1000000");
  await page.getByLabel("Note (required — why this number)").fill("sold privately");
  await page.getByRole("button", { name: "Add flat pool" }).click();
  await page
    .getByLabel("Paste (names separated by /)")
    .fill("Brain Tartare / Gustav Oswaldo");
  await page.getByRole("button", { name: "Set roster" }).click();
  await expect(page.getByText("Gustav Oswaldo")).toBeVisible();

  // The cost line states what is about to go, from the live counts — an admin
  // reading "2 roster rows" is the only warning this flow gives.
  await expect(page.getByText("Permanently deletes this operation")).toContainText(
    "2 roster rows",
  );

  // Armed, like Finalize: the accessible name stays whole ("Delete operation")
  // while the visible label is the single word under the heading that already
  // said the rest.
  await page.getByRole("button", { name: "Delete operation" }).click();
  await page.getByRole("button", { name: /^confirm delete operation/ }).click();

  // Leaves for the list rather than revalidating a page whose row is gone.
  await expect(page).toHaveURL(/\/payouts$/);
  await expect(page.getByRole("link", { name: "Mistaken op" })).toHaveCount(0);

  const rows = await db
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.id, opId));
  expect(rows).toHaveLength(0);
  // Cascade took the roster with it; nothing is left pointing at a dead parent.
  const orphans = await db
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.operationId, opId));
  expect(orphans).toHaveLength(0);

  // audit_log has no FK to the operation, which is the point: the row survives
  // the delete, and it carries denormalised detail because the join that would
  // have supplied it can no longer resolve.
  const deleted = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "payout.deleted"), eq(auditLog.target, opId)));
  expect(deleted).toHaveLength(1);
  expect(deleted[0].details).toMatchObject({
    name: "Mistaken op",
    occurredAt: "2026-08-01",
    participantCount: 2,
    payableCount: 2,
    totalValue: "1000000.00",
  });
});

/*
 * The gate, exercised the way an admin would hit it rather than by calling the
 * service. `delete_has_paid` is the one rejection this flow has, and its notice
 * is browser-only: the action redirects back to the operation with the code,
 * and the operation has to still be there to read it on.
 */
test("deleting an operation with a paid participant is refused on the page", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, {
    name: "Admin Paid",
    tier: "member",
    status: "active",
    isAdmin: true,
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Already paid op");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Already paid op" })).toBeVisible();
  const opId = page.url().split("/").pop()!;

  await page.getByLabel("Total value (ISK)").fill("1000000");
  await page.getByLabel("Note (required — why this number)").fill("sold privately");
  await page.getByRole("button", { name: "Add flat pool" }).click();
  await page.getByLabel("Paste (names separated by /)").fill("Brain Tartare");
  await page.getByRole("button", { name: "Set roster" }).click();

  await page.getByRole("button", { name: "Finalize" }).click();
  await page.getByRole("button", { name: /^confirm finalize/ }).click();
  await page.getByRole("button", { name: "mark paid" }).click();
  await page.getByRole("button", { name: /^confirm mark paid/ }).click();
  await expect(page.getByText("paid", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Delete operation" }).click();
  await page.getByRole("button", { name: /^confirm delete operation/ }).click();

  await expect(page.locator("p.notice--bad")).toContainText("Revert every payment first");
  // Refused, not partially applied: the operation and its roster are intact,
  // and no audit row claims otherwise.
  await expect(page).toHaveURL(new RegExp(`/payouts/${opId}`));
  const rows = await db
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.id, opId));
  expect(rows).toHaveLength(1);
  const deleted = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "payout.deleted"), eq(auditLog.target, opId)));
  expect(deleted).toHaveLength(0);
});

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

/**
 * Regression guard: the operator's Finalize/Unlock controls used to sit in a
 * <p> wrapping a <form>, which is invalid HTML (commit da8c7d0).
 *
 * This replaced a `page.on("console")` listener watching for React's
 * "cannot be a descendant" warning. That warning only exists in React's
 * development build, so once CI began serving a production build the console
 * form of the check became vacuously true — passing whether or not the bug
 * had come back.
 *
 * It takes two assertions rather than one because neither alone is sufficient,
 * and the reason is the HTML parser: a `<form>` start tag implicitly closes an
 * open `<p>` ("in body" insertion mode). So server-rendered `<p><form>` is
 * parsed into *siblings*, and a DOM query for `p form` finds nothing — with
 * the bug fully present.
 *
 *   - The raw-HTML check reads what the server actually emitted, before the
 *     parser flattens it. This is the one that catches a hard navigation.
 *   - The DOM check catches the client-rendered case, where React builds the
 *     subtree through DOM APIs and the invalid nesting really does persist.
 *     That is the shape the original bug took — it surfaced as a hydration
 *     warning, i.e. server and client disagreeing on exactly this.
 *
 * Call it in each state that renders the controls; the DOM only shows one.
 */
async function expectNoFormInParagraph(page: Page, url: string): Promise<void> {
  const html = await (await page.request.get(url)).text();
  // A `<p ...>` with a `<form` after it and no intervening `</p>` — the markup
  // the parser is about to rewrite, and the only place it is still visible.
  expect(html).not.toMatch(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?<form\b/);
  await expect(page.locator("p form")).toHaveCount(0);
}

/**
 * Seeds a finalized operation with a flat pool and the given roster, straight
 * through the database. The UI path for this (create → pool → paste → finalize →
 * mark paid) is already covered by "create, add a flat pool, paste a roster,
 * finalize, mark paid"; re-driving it in every pay-flow test would test the
 * setup rather than the flow. Returns the operation id.
 *
 * Column names follow `src/db/schema.ts:233-323`, which is the authority here.
 * The operation and pool shapes also appear in the existing direct-insert block
 * at `e2e/payouts.spec.ts:305-323` (`occurredAt` is a Date, `corpSharePct` a
 * numeric string, the creator is `createdBy`); that block seeds no participants,
 * so `shares`, `excluded` and `amount` come from the schema alone —
 * `amount` is `numeric(20, 2)`, i.e. a string, not cents.
 *
 * `excluded` names are seeded excluded, which is how the pay flow's
 * skip-the-excluded-row behaviour gets a fixture. They get amount 0 and are
 * left out of the split, matching what the service would have produced.
 */
async function seedFinalizedRoster(
  database: typeof db,
  createdBy: string,
  names: string[],
  excluded: string[] = [],
): Promise<string> {
  const owed = names.filter((n) => !excluded.includes(n));
  const each = (1_000_000 / owed.length).toFixed(2);
  const [op] = await database
    .insert(payoutOperation)
    .values({
      name: "Payout run",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy,
      status: "finalized",
    })
    .returning();
  await database.insert(lootPool).values({
    operationId: op.id,
    valuationSource: "flat",
    totalValue: "1000000.00",
    notes: "seeded",
  });
  await database.insert(payoutParticipant).values(
    names.map((displayName) => ({
      operationId: op.id,
      displayName,
      shares: "1",
      excluded: excluded.includes(displayName),
      amount: excluded.includes(displayName) ? "0.00" : each,
    })),
  );
  return op.id;
}

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
  const opUrl = `/payouts/${opId}`;
  // Pre-finalize: the Finalize control is the one rendered here.
  await expectNoFormInParagraph(page, opUrl);

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
  // It is the exception outside the main "paste loot" flow, so its own fields
  // sit behind their own collapsed panel — open that first.
  await openFlatPoolPanel(page);
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
  // Post-finalize: Unlock has replaced Finalize, so the nesting is re-checked.
  await expectNoFormInParagraph(page, opUrl);
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

  await openFlatPoolPanel(page);
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
  await expect(page).toHaveTitle("Short appraisal · Test Corp");
  await expect(page.getByText("1 item priced at 0.00")).toBeVisible();
  // The name matters — "1 item" alone doesn't tell you it's a supercarrier.
  await expect(page.getByText("Nyx ×1")).toBeVisible();
});

/**
 * appraiseLoot rounds once at the line total, so a line with a genuine
 * sub-cent per-unit price stores unitPrice "0.00" while totalValue is real and
 * already counted in the pool. This used to also fire its own "priced under
 * 0.01 ISK each" Notice — removed entirely, because that notice's own copy
 * ("the line total is real and already counted") states that nothing is
 * wrong, which is not something worth an alarm block for. The unit price and
 * line total columns in the item table carry the same information without
 * announcing it as a fault, so this test now reads the table row instead of a
 * Notice: the row must show both a 0.00 unit price and a real 5.00 line total
 * on the same line, distinct from an unresolved item (no price at all, still
 * a page-level warning — see the test above).
 */
test("a resolved sub-cent unit price shows a real line total beside a 0.00 unit price", async ({
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
  // The item table is at the top level now, not behind a disclosure — see the
  // "override an item price" test below for the regression that used to hide
  // it behind "Pool 1 items (1)".
  const itemRow = page.getByRole("row").filter({ hasText: "Tritanium" });
  // The unit-price cell is an InlineEdit now: its view mode is the value plus
  // an "edit" trigger sharing the same `<td>`, so the cell's full text is
  // "0.00 edit" rather than the bare number.
  await expect(itemRow.getByRole("cell").nth(2)).toHaveText(/^0\.00/);
  await expect(itemRow.getByRole("cell").nth(3)).toHaveText("5.00 ISK");
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
  // The roster table is always visible once it's non-empty; adding a single
  // participant without discarding existing share edits stays its own small
  // disclosure, closed by default.
  await page.locator("summary", { hasText: "Add one participant" }).click();
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

  // Corp share does have an inline editor now (see the composer test for it),
  // but seeding it directly at 0% keeps the even-split math below exact
  // without an extra round trip — the same pattern the other tests in this
  // file use to fix a percentage without going through the page.
  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Split adjustments",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();
  const opId = op.id;
  await page.goto(`/payouts/${opId}`);
  await expect(page.getByRole("heading", { name: "Split adjustments" })).toBeVisible();

  await openFlatPoolPanel(page);
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
  await rowFor("Carol Pilot")
    .getByRole("button", { name: "edit shares for Carol Pilot" })
    .click();
  await page.getByLabel(/^shares for carol pilot$/i).fill("2");
  await rowFor("Carol Pilot")
    .getByRole("button", { name: "save shares for Carol Pilot" })
    .click();
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

/**
 * The flat pool is a rare exception, not the main loot path (triff paste is),
 * so its fields sit inside their own `Disclosure` ("Or enter a flat value"),
 * never open by default — opening it is the one extra step every flat-pool
 * test needs before `Total value (ISK)` is reachable at all. It sits directly
 * under Loot before any pool exists, and nested under "Add another paste"
 * once one does — the summary text is the same in both places.
 */
async function openFlatPoolPanel(page: Page): Promise<void> {
  await page.locator("summary", { hasText: "Or enter a flat value" }).click();
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
/*
 * `/payouts/new` no longer takes a `?error=` query string at all —
 * `createOperationAction` returns `{ ok: false, code }` through
 * `useActionState` instead of redirecting (see `new-operation-form.tsx`), so
 * these two codes are exercised the same way every other rejection on this
 * page is: a real submit with the bad value, read back off the live notice.
 */
test("an empty name is refused with a specific message", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "FC Codes",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  await page.goto("/payouts/new");
  await page.getByLabel("Date").fill("2026-08-01");
  // The Name field is `required`, so the browser's own validation blocks a
  // truly empty submit before it ever reaches the server — reaching this
  // rejection at all means going around the client guard, same as the date
  // and shares/price tests above.
  await page.getByLabel("Name").evaluate((el) => el.removeAttribute("required"));
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.locator("p.notice--bad")).toContainText("needs a name");
  await expect(page.getByText("Something broke")).toHaveCount(0);
});

test("an invalid date is refused with a specific message", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "FC Codes",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Bad date roam");
  // type="date" stops free text in the browser, so reaching the server check
  // at all means going around the client guard.
  await bypassClientGuard(page.getByLabel("Date"), "not-a-date");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.locator("p.notice--bad")).toContainText("real calendar date");
  await expect(page.getByText("Something broke")).toHaveCount(0);
});

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
 * The round trip `useActionState` exists for: a rejected create form comes
 * back with the other field still filled in, with no navigation at all — the
 * whole point of returning `{ ok: false, code }` from `createOperationAction`
 * instead of redirecting is that the component never unmounts. Retyping the
 * name because the date was bad (or vice versa) is the actual cost a redirect
 * would reintroduce, and the only way to catch a regression is to submit a
 * bad value and read the good one back off the still-mounted form.
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

  // No navigation at all — this stays exactly `/payouts/new`, never
  // `?error=...` or anything else.
  await expect(page).toHaveURL(/\/payouts\/new$/);
  await expect(page.locator("p.notice--bad")).toContainText("real calendar date");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // The rejected value never survives here: a genuinely invalid date cannot
  // be displayed by a `type="date"` input regardless of what the component
  // state carries, so the round trip this test actually pins is Name's.
  await expect(page.getByLabel("Name")).toHaveValue("Hard-won roam");

  // And the corrected submit goes through, so the echoed name is real form
  // state and not just decoration on an error page.
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "Hard-won roam" })).toBeVisible();
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

  await openFlatPoolPanel(page);
  await page.getByLabel("Total value (ISK)").fill("100");
  await page.getByLabel("Note (required — why this number)").fill("flat");
  await page.getByRole("button", { name: "Add flat pool" }).click();
  await page.getByLabel("Paste (names separated by /)").fill("Alice Pilot");
  await page.getByRole("button", { name: "Set roster" }).click();

  // type=number, so the browser refuses to submit text at all.
  await page.getByRole("button", { name: "edit shares for Alice Pilot" }).click();
  await bypassClientGuard(page.getByLabel(/^shares for alice pilot$/i), "abc");
  await page.getByRole("button", { name: "save shares for Alice Pilot" }).click();
  await expect(page.locator("p.notice--bad")).toContainText("plain number like 1");
  await expect(page.getByText("Something broke")).toHaveCount(0);

  // The rejection redirect is a hard navigation, so InlineEdit remounts
  // closed — reopen it for the second bad value.
  await page.getByRole("button", { name: "edit shares for Alice Pilot" }).click();
  await bypassClientGuard(page.getByLabel(/^shares for alice pilot$/i), "0");
  await page.getByRole("button", { name: "save shares for Alice Pilot" }).click();
  await expect(page.locator("p.notice--bad")).toContainText("greater than zero");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // The stored value survived both rejections.
  await page.getByRole("button", { name: "edit shares for Alice Pilot" }).click();
  await expect(page.getByLabel(/^shares for alice pilot$/i)).toHaveValue("1.00");
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
  // The item table is at the top level now, always visible — no disclosure to
  // open. The price itself is an InlineEdit (inline-edit.tsx): it renders as
  // plain text plus an "edit" trigger until activated, so the labelled input
  // itself doesn't exist in the DOM until that trigger is clicked.
  // exact: true — the save button beside this field is named "save unit
  // price for Tritanium", which is this label's text with a prefix, and
  // getByLabel's default substring match would count both.
  await expect(page.getByLabel(/^unit price for tritanium$/i)).toHaveCount(0);
  await page.getByRole("button", { name: "edit unit price for Tritanium" }).click();

  await page.getByLabel(/^unit price for tritanium$/i).fill("25.00");
  await page.getByRole("button", { name: "save unit price for Tritanium" }).click();

  // 25.00 x 10, exactly — the line total, the pool total and the operation
  // total all re-derive from the override.
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

  // The freeze is permanent. It is a Status token in the facts grid now, not
  // an alarm Notice — but the editing-rules prose an operator needs where they
  // are about to reach for revert still has to say so, or a revert here reads
  // as "fix the roster" instead of "correct who was paid".
  await expect(page.getByText("frozen", { exact: true })).toBeVisible();
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
  await page.getByRole("button", { name: "edit unit price for Tritanium" }).click();

  // type=number, so the browser refuses to submit text or a comma-grouped
  // value at all — bypassClientGuard drives it the way a scripted client
  // (or EVE's own comma-grouped paste) would.
  await bypassClientGuard(page.getByLabel(/^unit price for tritanium$/i), "1,234.00");
  await page.getByRole("button", { name: "save unit price for Tritanium" }).click();
  await expect(page.locator("p.notice--bad")).toContainText("plain number like 12.34");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // The stored value survived the rejection — `setItemPriceAction`'s redirect
  // is a hard navigation, so InlineEdit remounts closed; reopen it to read the
  // field back.
  await page.getByRole("button", { name: "edit unit price for Tritanium" }).click();
  await expect(page.getByLabel(/^unit price for tritanium$/i)).toHaveValue("10.00");
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

  await openFlatPoolPanel(page);
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

  await openFlatPoolPanel(page);
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

/*
 * The composer's whole reason for existing: name, date and a roster paste in
 * one submit, landing on a fully-populated operation with no separate
 * "Set roster" step after. Loot is left out here — a loot paste calls
 * triff.tools for real (see `openFlatPoolPanel`'s own comment), and this
 * suite must not depend on that being reachable; the roster-only path is
 * still enough to prove one submit does the whole job.
 */
test("the composer creates a populated operation in one submit", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Composer",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("One-shot roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Roster paste").fill("Brain Tartare / Gustav Oswaldo");
  await page.getByRole("button", { name: "Create operation" }).click();

  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { name: "One-shot roam" })).toBeVisible();
  // Both names landed straight on the roster table — no second step.
  await expect(page.getByRole("row").filter({ hasText: "Brain Tartare" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Gustav Oswaldo" })).toBeVisible();
});

/*
 * The round trip the composer exists to protect: a paste that can run
 * hundreds of lines must not be lost to a rejected submit. `createOperationAction`
 * returns `{ ok: false, code }` through `useActionState` for this rejection
 * rather than redirecting through `?error=`, precisely so the component never
 * unmounts and the textarea is still holding what was typed.
 */
test("a rejected composer submit keeps the loot paste", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "FC Composer Reject",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Big paste roam");
  const paste = Array.from({ length: 60 }, (_, i) => `Tritanium\t${i + 1}`).join("\n");
  await page.getByLabel("Loot paste").fill(paste);
  // type="date" stops free text client-side, so reaching the server check at
  // all means going around the client guard, same as the plain create test.
  await bypassClientGuard(page.getByLabel("Date"), "not-a-date");
  await page.getByRole("button", { name: "Create operation" }).click();

  await expect(page.locator("p.notice--bad")).toContainText("real calendar date");
  await expect(page.getByLabel("Loot paste")).toHaveValue(paste);
});

/*
 * The proof that a save through InlineEdit is a client update and not a page
 * reload: a second field is left open and uncommitted while the first one
 * saves, and it has to survive untouched — the same technique
 * e2e/admin.spec.ts uses for a drawer surviving a server action's
 * `revalidatePath` (a hard navigation would remount the whole page and close
 * every open edit box along with it, not just the one that saved).
 */
test("an inline share edit saves without a page navigation", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Inline",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Inline edit roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Roster paste").fill("Alice Pilot / Bob Pilot");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Inline edit roam" })).toBeVisible();

  const rowFor = (name: string) => page.getByRole("row").filter({ hasText: name });
  await rowFor("Bob Pilot")
    .getByRole("button", { name: "edit shares for Bob Pilot" })
    .click();
  await page.getByLabel(/^shares for bob pilot$/i).fill("3");

  await rowFor("Alice Pilot")
    .getByRole("button", { name: "edit shares for Alice Pilot" })
    .click();
  await page.getByLabel(/^shares for alice pilot$/i).fill("2");
  await rowFor("Alice Pilot")
    .getByRole("button", { name: "save shares for Alice Pilot" })
    .click();

  // Alice's edit closed on save...
  await expect(
    rowFor("Alice Pilot").getByRole("button", { name: "edit shares for Alice Pilot" }),
  ).toBeVisible();
  // ...and Bob's, left open with an unsaved "3", is still open and still
  // holding it.
  await expect(page.getByLabel(/^shares for bob pilot$/i)).toHaveValue("3");
});

/*
 * `setRosterAction` deletes and reinserts the whole roster (services/payouts.ts:435-467),
 * which is why the *replace* path is armed while the *first* roster paste (an
 * empty roster, nothing to lose) is a plain one-click submit.
 */
test("replacing the roster from a paste requires confirmation", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Replace",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Replace roster test");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Roster paste").fill("Alice Pilot");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Replace roster test" })).toBeVisible();

  await page.locator("summary", { hasText: "Replace roster from a paste" }).click();
  await page.getByLabel("Paste (names separated by /)").fill("Zoe Pilot");
  // First click only arms the control — nothing has changed yet.
  await page.getByRole("button", { name: "Replace roster" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Alice Pilot" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Zoe Pilot" })).toHaveCount(0);

  await page.getByRole("button", { name: /^confirm replace roster/ }).click();
  await expect(page.getByRole("row").filter({ hasText: "Zoe Pilot" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Alice Pilot" })).toHaveCount(0);
});

/*
 * One gold `.btn--primary` at a time, and which control it is tracks how far
 * along the operation is (see `[id]/page.tsx`'s `primaryStage`): Appraise
 * with no loot yet, Set roster once loot exists but no roster does, Finalize
 * once both do.
 */
test("exactly one gold primary control renders in each draft state", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Primary",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Primary control check");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(
    page.getByRole("heading", { name: "Primary control check" }),
  ).toBeVisible();

  // Stage 1: no loot yet — Appraise is the one gold control.
  await expect(page.locator(".btn--primary")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Appraise" })).toHaveClass(
    /btn--primary/,
  );

  await openFlatPoolPanel(page);
  await page.getByLabel("Total value (ISK)").fill("100");
  await page.getByLabel("Note (required — why this number)").fill("flat test");
  await page.getByRole("button", { name: "Add flat pool" }).click();

  // Stage 2: loot exists, no roster yet — Set roster is the one gold control.
  await expect(page.locator(".btn--primary")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Set roster" })).toHaveClass(
    /btn--primary/,
  );

  await page.getByLabel("Roster paste").fill("Alice Pilot");
  await page.getByRole("button", { name: "Set roster" }).click();

  // Stage 3: both present — Finalize is the one gold control.
  await expect(page.locator(".btn--primary")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Finalize" })).toHaveClass(
    /btn--primary/,
  );
});

test("the roster heading and each owed row's copy button are addressable", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Anchor FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const opId = await seedFinalizedRoster(db, operator.id, ["Ada Anchor", "Bo Anchor"]);
  await page.goto(`/payouts/${opId}`);

  // The heading is focusable programmatically but never lands in the tab
  // order: it is a destination for the all-paid announcement, not a stop on
  // the way to the controls.
  const heading = page.locator("#roster-heading");
  await expect(heading).toHaveAttribute("tabindex", "-1");
  await expect(heading).toHaveText("Split / Roster");

  // One addressable copy button per owed row, id keyed by participant uuid.
  const ids = await page
    .locator('[id^="pay-copy-"]')
    .evaluateAll((els) => els.map((el) => el.id));
  expect(ids).toHaveLength(2);
  for (const id of ids) {
    await expect(page.locator(`#${id}`)).toHaveAccessibleName(/^copy amount for /);
  }
});

test("paying a row moves focus to the next unpaid row and announces who is next", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Relay FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  // Alphabetical, because the roster renders asc(displayName): Ada, Bo, Cy.
  const opId = await seedFinalizedRoster(db, operator.id, [
    "Ada Relay",
    "Bo Relay",
    "Cy Relay",
  ]);
  await page.goto(`/payouts/${opId}`);

  // The first payment arms — it is the one that freezes the operation.
  await page.getByRole("button", { name: "mark paid Ada Relay" }).click();
  await page.getByRole("button", { name: "confirm mark paid Ada Relay" }).click();

  // Focus lands on the next unpaid row's copy button, so the operator's next
  // action needs no re-scan of the table.
  await expect(
    page.getByRole("button", { name: "copy amount for Bo Relay" }),
  ).toBeFocused();
  // ...and the same fact is available to someone who cannot see the focus ring.
  await expect(page.locator("#pay-flow-status")).toContainText(
    "Paid Ada Relay. 1 of 3 paid. Next: Bo Relay,",
  );
});

test("the second payment advances again, on one click", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "Second FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedFinalizedRoster(db, operator.id, [
    "Ada Second",
    "Bo Second",
    "Cy Second",
  ]);
  await page.goto(`/payouts/${opId}`);

  await page.getByRole("button", { name: "mark paid Ada Second" }).click();
  await page.getByRole("button", { name: "confirm mark paid Ada Second" }).click();
  await expect(
    page.getByRole("button", { name: "copy amount for Bo Second" }),
  ).toBeFocused();

  // No arming this time: the door the first payment shut is already shut, so
  // every later payment is a single click. This is the existing rule (see
  // "override an item price, finalize, pay, revert, and pay again"), asserted
  // here because the advance must not have re-introduced a confirm step.
  await page.getByRole("button", { name: "mark paid Bo Second" }).click();
  await expect(
    page.getByRole("button", { name: "copy amount for Cy Second" }),
  ).toBeFocused();
  await expect(page.locator("#pay-flow-status")).toContainText(
    "Paid Bo Second. 2 of 3 paid. Next: Cy Second,",
  );
});

test("paying the last row focuses the roster heading and says all are paid", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Last FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedFinalizedRoster(db, operator.id, ["Ada Last", "Bo Last"]);
  await page.goto(`/payouts/${opId}`);

  await page.getByRole("button", { name: "mark paid Ada Last" }).click();
  await page.getByRole("button", { name: "confirm mark paid Ada Last" }).click();

  // Unlike the "next row" tests above, there's no next row's copy button to
  // assert focus on here, so wait for Ada's own row to settle to "paid"
  // before clicking Bo's row. Without this, Bo's "mark paid" button is still
  // mid-transition (its arm state flips from armed to unarmed once Ada's
  // payment lands, which swaps the underlying control), and a click that
  // lands during that swap can be lost.
  await expect(
    page.getByRole("row", { name: /Ada Last/ }).getByText("paid", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "mark paid Bo Last" }).click();

  // There is no next row, so focus goes somewhere meaningful rather than to
  // <body> — the section heading, which is where the n/m progress lives.
  await expect(page.locator("#roster-heading")).toBeFocused();
  await expect(page.locator("#pay-flow-status")).toContainText(
    "Paid Bo Last. All 2 paid.",
  );
});

test("an excluded participant is never a focus target", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "Skip FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedFinalizedRoster(
    db,
    operator.id,
    ["Ada Skip", "Bo Skip", "Cy Skip"],
    ["Bo Skip"],
  );
  await page.goto(`/payouts/${opId}`);

  await page.getByRole("button", { name: "mark paid Ada Skip" }).click();
  await page.getByRole("button", { name: "confirm mark paid Ada Skip" }).click();

  // Bo is excluded, so the flow steps straight over to Cy, and the counts are
  // out of 2 — the excluded row is not owed anything and is not part of the
  // denominator.
  await expect(
    page.getByRole("button", { name: "copy amount for Cy Skip" }),
  ).toBeFocused();
  await expect(page.locator("#pay-flow-status")).toContainText(
    "Paid Ada Skip. 1 of 2 paid. Next: Cy Skip,",
  );
  // And the excluded row still has no way to be paid at all.
  await expect(page.getByRole("button", { name: /mark paid Bo Skip/ })).toHaveCount(0);
});

test("reverting a payment keeps focus on that row and announces the new count", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Undo FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedFinalizedRoster(db, operator.id, ["Ada Undo", "Bo Undo"]);
  await page.goto(`/payouts/${opId}`);

  await page.getByRole("button", { name: "mark paid Ada Undo" }).click();
  await page.getByRole("button", { name: "confirm mark paid Ada Undo" }).click();
  await expect(
    page.getByRole("button", { name: "copy amount for Bo Undo" }),
  ).toBeFocused();

  // Revert arms: it rewrites recorded financial state.
  await page.getByRole("button", { name: "revert payment for Ada Undo" }).click();
  await page.getByRole("button", { name: "confirm revert payment for Ada Undo" }).click();

  // Focus stays with Ada — the row the operator is dealing with — rather than
  // jumping to whoever is next. Reverting is a correction, not progress.
  await expect(
    page.getByRole("button", { name: "copy amount for Ada Undo" }),
  ).toBeFocused();
  await expect(page.locator("#pay-flow-status")).toContainText(
    "Reverted Ada Undo. 0 of 2 paid.",
  );
});

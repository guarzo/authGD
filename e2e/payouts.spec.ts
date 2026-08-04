import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import {
  auditLog,
  lootItem,
  lootPool,
  payoutOperation,
  payoutParticipant,
} from "../src/db/schema";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

test("a green member is denied /payouts", async ({ page, context }) => {
  const acc = await seedMember(db, { name: "Green Pilot", tier: "green" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/payouts");
  await expect(page).toHaveURL(/\/account/);
});

test("a cryo flygd member can read but not mutate", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "Active Operator",
    tier: "flygd",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Thursday roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Corp share %").fill("10");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);
  const opUrl = page.url();

  const cryo = await seedMember(db, {
    name: "Cryo Pilot",
    tier: "flygd",
    status: "cryo",
  });
  await context.clearCookies();
  await context.addCookies([await sessionCookieFor(db, cryo.id)]);

  // Read: the list and the detail both render for a cryo flygd member.
  await page.goto("/payouts");
  await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();
  await expect(page.getByText("Thursday roam")).toBeVisible();
  // No create control for a non-operator reader.
  await expect(page.getByRole("link", { name: "New operation" })).toHaveCount(0);

  // Mutate: /payouts/new redirects a cryo flygd member straight back out.
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
    tier: "flygd",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Thursday roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Corp share %").fill("10");
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
  // Scoped to the pool row: with one pool, "1000000.00 ISK" also appears in
  // the operation's "Total loot" summary, so a bare getByText is ambiguous.
  const flatPoolRow = page.getByRole("row").filter({ hasText: "flat (manual)" });
  await expect(flatPoolRow).toContainText("1000000.00 ISK");

  await page
    .getByLabel("Paste (names separated by /)")
    .fill("Brain Tartare / Gustav Oswaldo");
  await page.getByRole("button", { name: "Set roster" }).click();
  await expect(page.getByText("Brain Tartare")).toBeVisible();
  await expect(page.getByText("Gustav Oswaldo")).toBeVisible();

  // 1,000,000 total, 10% corp share -> 900,000 pool, split evenly two ways
  // (both unresolved names get shares "1" and no account) -> 450,000.00 each.
  await expect(page.getByText("450000.00 ISK")).toHaveCount(2);
  // The corp's actual cut is shown, not just the percentage — 10% of 1,000,000
  // plus whatever the per-share floor left behind (nothing, here).
  await expect(page.getByText("100000.00 ISK")).toBeVisible();

  await page.getByRole("button", { name: "Finalize" }).click();
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

  await page
    .getByRole("button", { name: "mark paid" })
    .first()
    .click();
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
    tier: "flygd",
    status: "active",
  });
  await seedMember(db, {
    name: "Stealthbot",
    tier: "green",
    alts: ["Stealthbot Alt"],
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Roam with an alt");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Corp share %").fill("0");
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
    tier: "flygd",
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
    tier: "flygd",
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
    tier: "flygd",
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

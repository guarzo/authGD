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
import { pinGeometry } from "./geometry";

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
  await expect(page.getByRole("heading", { name: "Operations", level: 1 })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Operations", level: 1 })).toBeVisible();
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
  await page.getByLabel("Note (required): why this number").fill("sold privately");
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

/**
 * `defaultValue` compiles to the `value` *attribute*, which a browser ignores
 * once an input's dirty value flag is set — which it is, the operator having
 * typed in it — so an uncontrolled field here left the total and note on
 * screen after a successful add and let a second press of "Add flat pool"
 * bank the same numbers twice, inflating a payout total real people get paid
 * from. `flat-pool-form.tsx` is controlled now and clears in a success
 * effect; this pins that against a regression back to `defaultValue`.
 */
test("a successful flat pool add clears the form", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Clears after add",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();

  await page.goto(`/payouts/${op.id}`);
  await openFlatPoolPanel(page);
  await page.getByLabel("Total value (ISK)").fill("1000000");
  await page.getByLabel("Note (required): why this number").fill("sold privately");
  await page.getByLabel("What was in it (optional)").fill("a stack of PLEX");
  await page.getByRole("button", { name: "Add flat pool" }).click();

  const flatPoolRow = page.getByRole("row").filter({ hasText: "flat (manual)" });
  await expect(flatPoolRow).toContainText("1,000,000.00 ISK");
  await expect(flatPoolRow).toHaveCount(1);

  // All three fields are back to empty, not still holding what was just
  // banked — the exact hazard the docblock names: a second press with the
  // same numbers still visible would have created a second pool.
  await expect(page.getByLabel("Total value (ISK)")).toHaveValue("");
  await expect(page.getByLabel("Note (required): why this number")).toHaveValue("");
  await expect(page.getByLabel("What was in it (optional)")).toHaveValue("");
});

/**
 * The other half of the same conversion, and the more important one: moving
 * `flat-pool-form.tsx`'s fields from `defaultValue` to controlled `useState`
 * fixed the duplicate-bank hazard above, but the whole risk in doing that was
 * trading it for a lost-input regression on rejection — a mistyped total that
 * also cost the operator their note, the exact loss `FlatPoolEditState`
 * exists to prevent (see `actions.ts`'s docblock). No `bypassClientGuard`
 * needed here: `<input type="number">` accepts scientific notation like
 * "1e5" client-side, and `total_invalid`'s own copy calls that out by name —
 * a real rejection reachable by typing normally, not a hand-built request.
 */
test("a rejected flat pool submission keeps what was typed in all three fields", async ({
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
      name: "Rejected flat pool",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();

  await page.goto(`/payouts/${op.id}`);
  await openFlatPoolPanel(page);
  await page.getByLabel("Total value (ISK)").fill("1e5");
  await page.getByLabel("Note (required): why this number").fill("sold privately");
  await page.getByLabel("What was in it (optional)").fill("a stack of PLEX");
  await page.getByRole("button", { name: "Add flat pool" }).click();

  await expect(page.locator("p.notice--bad")).toContainText("no shorthand like 1e5");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // Nothing was banked — the rejection added no pool row.
  await expect(page.getByRole("row").filter({ hasText: "flat (manual)" })).toHaveCount(0);

  // All three fields still hold exactly what was typed — this is the fix the
  // conversion to controlled state must not have traded away.
  await expect(page.getByLabel("Total value (ISK)")).toHaveValue("1e5");
  await expect(page.getByLabel("Note (required): why this number")).toHaveValue(
    "sold privately",
  );
  await expect(page.getByLabel("What was in it (optional)")).toHaveValue(
    "a stack of PLEX",
  );
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
  await page.getByLabel("Note (required): why this number").fill("flat test value");
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
 * Regression guard for a defect that survived the design sweep's own audit of
 * `addAppraisedPoolAction`: a SUCCESSFUL paste that drops at least one line
 * used to `redirect()` to this same page with `?dropped=<payload>`, and a
 * `redirect()` back to the page already on screen is still a route
 * transition. Every `Disclosure` on this page holds its open/closed state in
 * a plain `useState` (`disclosure.tsx`) with nowhere else to live, so that
 * transition silently closed whatever else the operator had open — exactly
 * the class of bug the sweep already fixed twice elsewhere
 * (`admin/accounts/actions.ts`, `admin/sync/actions.ts`), just missed here
 * because the sweep's own audit of this action only exercised the rejection
 * path (the "bad shares"-style tests below), never the success-with-drops one.
 *
 * "42" alone is `QTY_ONLY` (`core/loot-paste.ts`) — a bare number with no item
 * name is dropped as "quantity-only" rather than parsed as an item. Every line
 * here drops, so `appraiseLoot` never resolves a type id and never calls
 * triff (`esi.resolveIds` / `triff.quote` are both no-ops on an empty list) —
 * which is what lets this go through the real form, unlike the two tests
 * above that seed an appraised pool directly because the priced path depends
 * on triff.tools.
 *
 * "Replace roster from a paste" is the control this pins the regression
 * against, not "Add loot" or "Add one participant": both of those default
 * OPEN while there are no pools / no roster yet, so a remount would reopen
 * them anyway and the assertion would pass whether or not the bug were
 * present. "Replace roster from a paste" has no `defaultOpen`, and it lives in
 * the roster section rather than the loot section, so appraising a paste does
 * not restructure the subtree it sits in — it only reads expanded here if it
 * was never remounted.
 */
test("a dropped-lines paste does not collapse an unrelated disclosure the operator left open", async ({
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
  await page.getByLabel("Name").fill("Dropped-line regression");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(
    page.getByRole("heading", { name: "Dropped-line regression" }),
  ).toBeVisible();

  // A roster of one, so the "Replace roster from a paste" disclosure below
  // exists at all — it only renders once there is a roster to replace.
  await page.getByLabel("Character name").fill("FC Prime");
  await page.getByRole("button", { name: "Add participant" }).click();
  await expect(page.getByRole("cell", { name: "FC Prime" }).first()).toBeVisible();

  const replaceRosterToggle = page.locator("summary", {
    hasText: "Replace roster from a paste",
  });
  await replaceRosterToggle.click();
  await expect(replaceRosterToggle).toHaveAttribute("aria-expanded", "true");

  // "Add loot" is already open (defaultOpen while pools.length === 0) — no
  // click needed, and clicking its own summary here would only close it.
  await page.getByLabel("Loot paste").fill("42");
  await page.getByRole("button", { name: "Appraise" }).click();

  await expect(page.getByText("1 item ignored")).toBeVisible();
  await expect(page.getByText("42 (just a number, with no item name)")).toBeVisible();

  // The regression: this used to fail here, because the redirect above
  // remounted every Disclosure on the page and reset this one to closed.
  await expect(replaceRosterToggle).toHaveAttribute("aria-expanded", "true");
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
  await page.getByLabel("Note (required): why this number").fill("even split test");
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
  // Kept as a belt-and-braces removal rather than relied on: the form carries
  // `noValidate` now, so an empty submit reaches the server on its own and the
  // attribute is inert. It used to be the only way in — native validation ran
  // ahead of the `submit` event React's `<form action>` fires from, so this
  // message was a scripted-request backstop. The test below
  // ("...through the form, with no client guard removed") is the one that pins
  // the new route; this one keeps covering the server check itself.
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
  // `type="date"` still refuses to hold free text whatever the form says about
  // validation, so this one genuinely does need the bypass — `noValidate`
  // switches off constraint *reporting*, not the input's own value sanitising.
  await bypassClientGuard(page.getByLabel("Date"), "not-a-date");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.locator("p.notice--bad")).toContainText("real calendar date");
  await expect(page.getByText("Something broke")).toHaveCount(0);
});

/*
 * The nastier half of the same check, and the one `new Date()` alone gets
 * wrong: February 30th is not rejected by the platform parser, it is rolled
 * forward to March 2nd. Without the strict parse the operation would be
 * created — silently dated three days off what the operator submitted, on the
 * record they reconcile against their own logs. The message promises a "real
 * calendar date"; this is the test that the promise is kept.
 */
test("a date that does not exist is refused rather than rolled forward", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Rollover",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Impossible date roam");
  await bypassClientGuard(page.getByLabel("Date"), "2026-02-30");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page).toHaveURL(/\/payouts\/new$/);
  await expect(page.locator("p.notice--bad")).toContainText("real calendar date");
  await expect(page.getByText("Something broke")).toHaveCount(0);
});

/*
 * The point of `noValidate`, stated as a test: an operator typing a plausible
 * wrong thing gets the app's own sentence, in the page, where it stays.
 *
 * Every other rejection test on this form removes an attribute or writes the
 * value past the input first. This one touches nothing — it fills the field the
 * way a person does and presses the button. Before `noValidate` it could not
 * have passed: the browser blocked the submit with a transient "Please enter a
 * URL." bubble that never named the scheme, and the sentence asserted below was
 * unreachable through the form at all.
 *
 * Measured, not assumed: a scheme-less paste lands on `url_invalid`, NOT
 * `url_scheme`. `zkillboard.com/related/…` fails `new URL()` outright, so it
 * never reaches the scheme check — `url_scheme` fires only for something that
 * already parses and is the wrong kind, like `javascript:`. That makes
 * `url_invalid` the message an operator actually meets, which is why its copy
 * (errors.ts) names the missing `https://` rather than stopping at "not a URL",
 * and why this asserts the remedy half specifically instead of just checking
 * that some notice appeared.
 */
test("a bare-hostname battle report is refused through the form, with no client guard removed", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC NoValidate",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Scheme-less roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page
    .getByLabel("Battle report (optional)")
    .fill("zkillboard.com/related/30000142/");
  await page.getByRole("button", { name: "Create operation" }).click();

  await expect(page).toHaveURL(/\/payouts\/new$/);
  await expect(page.locator("p.notice--bad")).toContainText(
    "needs an https:// on the front",
  );
  // The other half of what the message promises, and the reason the composer
  // returns state instead of redirecting: nothing the operator typed is gone.
  await expect(page.getByLabel("Name")).toHaveValue("Scheme-less roam");
  await expect(page.getByLabel("Battle report (optional)")).toHaveValue(
    "zkillboard.com/related/30000142/",
  );
  await expect(page.getByText("Something broke")).toHaveCount(0);
});

/*
 * `max={today}` was enforced by the browser and nothing else. Switching off
 * native validation would have turned that attribute into decoration and let a
 * future-dated operation through, so `createOperationAction` now checks it —
 * this is the test that says so, and the one that fails if either half is
 * removed without the other.
 *
 * The date is built from the run's own clock rather than hard-coded, so this
 * does not quietly stop testing anything when a fixed "future" date becomes
 * the past.
 */
test("an operation cannot be dated into the future", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "FC Tomorrow",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Tomorrow's roam");
  await page.getByLabel("Date").fill(tomorrow);
  await page.getByRole("button", { name: "Create operation" }).click();

  await expect(page).toHaveURL(/\/payouts\/new$/);
  await expect(page.locator("p.notice--bad")).toContainText(
    "cannot be dated in the future",
  );
  await expect(page.getByText("Something broke")).toHaveCount(0);
});

test("a battle report link is stored, and a bad scheme is refused without losing the rest of the form", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Codes",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  // The rejected-scheme half first, on its own operation: `createOperationAction`
  // runs this check before any network call, alongside name/date, so a bad
  // scheme never triggers an appraisal only to be thrown away (actions.ts).
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Roam with a link");
  await page.getByLabel("Date").fill("2026-08-01");
  await page
    .getByLabel("Roster paste (optional: one per line, or separated by /)")
    .fill("Brain Tartare");
  // type="url" only checks URL syntax, not scheme, so `javascript:` alone
  // would pass the browser's own constraint validation — bypassClientGuard
  // isn't needed to reach the server check here, but the roster paste above
  // proves the rejection doesn't cost the rest of the form either way.
  await page.getByLabel("Battle report (optional)").fill("javascript:alert(1)");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.locator("p.notice--bad")).toContainText("http:// or https://");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // Everything else the operator typed is still there, per that message.
  await expect(page.getByLabel("Name")).toHaveValue("Roam with a link");
  await expect(
    page.getByLabel("Roster paste (optional: one per line, or separated by /)"),
  ).toHaveValue("Brain Tartare");

  const rejected = await db
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.name, "Roam with a link"));
  expect(rejected).toHaveLength(0);

  // Now the accepted half: an http(s) link round-trips onto the operation it
  // created and renders as a link on its own page.
  await page
    .getByLabel("Battle report (optional)")
    .fill("https://zkillboard.com/related/1/");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Roam with a link" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "https://zkillboard.com/related/1/" }),
  ).toHaveAttribute("href", "https://zkillboard.com/related/1/");

  const [created] = await db
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.name, "Roam with a link"));
  expect(created.battleReportUrl).toBe("https://zkillboard.com/related/1/");
});

/*
 * The other half of the same rule, on the other entry point. Both the create
 * form and this inline edit go through `battleReportUrlProblem`
 * (src/app/payouts/actions.ts), and both have to refuse a non-http(s) scheme,
 * because the stored value renders as a plain `<a href>` right here. Both now
 * refuse the same way too — `setBattleReportUrlAction` returns a code rather
 * than redirecting, so the rejected text stays in the field the operator is
 * still standing in, which is why the assertion below is on `InlineEdit`'s own
 * `span.inline-form__err` and not on a page-level notice.
 */
test("the inline battle report edit refuses a javascript: scheme too", async ({
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
  await page.getByLabel("Name").fill("Inline link roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Inline link roam" })).toBeVisible();

  await page.getByRole("button", { name: "edit battle report URL" }).click();
  const field = page.getByRole("textbox", { name: "battle report URL" });
  // `type="url"` refuses a bare `javascript:alert(1)` in the browser, so
  // reaching the server check at all means going around the client guard —
  // which is the only path that matters here, since a real attempt would.
  await bypassClientGuard(field, "javascript:alert(1)");
  await page.getByRole("button", { name: "save battle report URL" }).click();

  await expect(page.locator("span.inline-form__err")).toContainText(
    "http:// or https://",
  );
  // The rejected text is still in the field, which is the point of returning
  // state instead of redirecting.
  await expect(field).toHaveValue("javascript:alert(1)");
  const [op] = await db
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.name, "Inline link roam"));
  expect(op.battleReportUrl).toBeNull();
});

/*
 * Finalize deletes its own button: `canFinalize` flips on the server and the
 * re-render drops the control that fired. Focus had nowhere to go and fell to
 * `<body>`, which drops a keyboard operator back to the top of the document
 * with nothing said. `LifecycleSubmit` hands it to the page's H1 instead
 * (`src/app/payouts/[id]/lifecycle-submit.tsx`), and this is the assertion that
 * the handoff actually commits — it runs in an effect of a component the same
 * response unmounts, which is exactly the shape that silently never fires.
 */
test("finalizing hands focus to the operation heading", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "FC Focus",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Focus roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Focus roam" })).toBeVisible();

  await openFlatPoolPanel(page);
  await page.getByLabel("Total value (ISK)").fill("1000000");
  await page.getByLabel("Note (required): why this number").fill("sold privately");
  await page.getByRole("button", { name: "Add flat pool" }).click();
  await page.getByLabel("Paste (names separated by /)").fill("Brain Tartare");
  await page.getByRole("button", { name: "Set roster" }).click();

  await page.getByRole("button", { name: "Finalize" }).click();
  await page.getByRole("button", { name: /^confirm finalize/ }).click();
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();

  await expect(page.locator("#operation-name")).toBeFocused();
});

/*
 * The announcement survives the case that deletes the whole lifecycle block,
 * not just the button. Any operator can finalize any draft (`canFinalize`
 * wants operator + draft), but only the creator or an admin can unlock it
 * (`canRelease` wants `canUnlock`). So for an operator who is neither, a
 * successful finalize turns every disjunct of `showLifecycle` false at once
 * and the block goes away. While the announcer lived inside that block it was
 * unmounted by the very response it existed to describe, and this operator —
 * uniquely — heard nothing at all.
 */
test("finalizing announces to an operator who cannot unlock", async ({
  page,
  context,
}) => {
  const creator = await seedMember(db, {
    name: "FC Creator",
    tier: "member",
    status: "active",
  });
  const other = await seedMember(db, {
    name: "FC Bystander",
    tier: "member",
    status: "active",
  });

  await context.addCookies([await sessionCookieFor(db, creator.id)]);
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Someone else's roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Someone else's roam" })).toBeVisible();
  const url = page.url();

  // Hand the page to the second operator: same draft, no creator claim on it.
  await context.clearCookies();
  await context.addCookies([await sessionCookieFor(db, other.id)]);
  await page.goto(url);

  await page.getByRole("button", { name: "Finalize" }).click();
  await page.getByRole("button", { name: /^confirm finalize/ }).click();

  // The announcement is `.visually-hidden`, so attached rather than visible,
  // and it clears itself after 2s — assert before that window closes.
  await expect(page.getByText("Operation finalized.")).toBeAttached();
  // The premise of the test: this operator really has lost every lifecycle
  // control, which is what used to take the live region with it.
  await expect(page.getByRole("button", { name: "Unlock" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finalize" })).toHaveCount(0);
});

/*
 * Notes are a standing field, not a value behind an edit toggle: the textarea
 * is always open and Save writes it. The second save is the half that matters —
 * the form never unmounts, so an uncontrolled textarea would snap back to its
 * mount-time value the instant the first action settled.
 */
test("notes save from an always-open textarea, twice running", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Notes",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Noted roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Noted roam" })).toBeVisible();

  // No "edit" trigger to reach for, and no "None" placeholder: the field is
  // the affordance.
  const notes = page.getByRole("textbox", { name: "operation notes" });
  await expect(notes).toHaveValue("");

  // The client's own "this action has settled" signal, awaited after each of
  // the two saves below. The DB row is not a substitute for it; the block after
  // the first click says why.
  const saved = page.locator(".notes-form__saved");

  const stored = () =>
    db
      .select()
      .from(payoutOperation)
      .where(eq(payoutOperation.name, "Noted roam"))
      .then(([row]) => row.notes);

  await notes.fill("Third fleet, two losses.");
  await page.getByRole("button", { name: "Save notes" }).click();
  // Two waits, in this order, because they answer different questions and only
  // one of them can sequence the next step.
  //
  // `· saved` is the barrier. The row commits before the action's response even
  // reaches the browser, so `expect.poll(stored)` can return while the form is
  // still genuinely in flight — measured at 335ms and 539ms of remaining
  // in-flight time on the two runs that failed. Editing and pressing Save again
  // inside that window is a second submit over a live one, which `useSubmitGuard`
  // refuses by design (`_components/submit-guard.ts`): the click is
  // preventDefault'ed, no POST is emitted, and the second save silently never
  // happens. That is the guard doing its job on `/payouts/new`'s behalf, not a
  // defect, and it made this test fail about one run in ten. Gating on the
  // confirmation waits for `useActionState` to have resolved on the client,
  // which is the only thing that means the button is free again.
  //
  // The row check stays, after it: the confirmation proves the client thinks it
  // saved, and only the row proves the server agrees.
  await expect(saved).toHaveText("· saved");
  // Checked against the row rather than the field: the textarea is controlled,
  // so it shows what was typed whether or not the save ever landed.
  await expect.poll(stored).toBe("Third fleet, two losses.");

  // The second save is the half that matters. The form never unmounts, so an
  // uncontrolled textarea would have snapped back to its mount-time value the
  // instant the first action settled, and this would write "" or the old text.
  await notes.fill("Third fleet, two losses. Salvage split later.");
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(saved).toHaveText("· saved");
  await expect.poll(stored).toBe("Third fleet, two losses. Salvage split later.");
  await expect(notes).toHaveValue("Third fleet, two losses. Salvage split later.");
});

/*
 * The notes textarea is the one editable field that sits open on the page for
 * as long as the operation is editable, so it is the one an operator can be
 * mid-paragraph in when the operation freezes underneath them — a second tab,
 * or another operator finalizing first. `canEdit` narrows that window and
 * cannot close it. Uncaught, `assertEditable`'s throw lands on error.tsx,
 * which apologizes for a server fault we did not have and never says why the
 * text vanished. This asserts the operator is told what actually happened.
 */
test("notes saved onto a freshly finalized operation say so, not 'something broke'", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Raced",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Raced roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Raced roam" })).toBeVisible();

  const notes = page.getByRole("textbox", { name: "operation notes" });
  await notes.fill("Half-written note that is about to be lost.");

  // The freeze arrives from outside this page, which is the whole premise:
  // the operator's tab still shows an editable operation. Writing the status
  // directly is what another operator's finalize looks like from here.
  await db
    .update(payoutOperation)
    .set({ status: "finalized" })
    .where(eq(payoutOperation.name, "Raced roam"));

  await page.getByRole("button", { name: "Save notes" }).click();

  await expect(page.locator("p.notice--bad")).toContainText("no longer be edited");
  // Not the error boundary: the operator is not told we broke.
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // And the note really did not land — the copy says so, so it had better.
  const [op] = await db
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.name, "Raced roam"));
  expect(op.notes).toBeNull();
});

// The detail page's own `?error=` codes no longer have a live producer — every
// action that used to redirect through `operationFailed` with one of these now
// returns `useActionState` state instead (see actions.ts's `StringFieldEditState`
// / `FlatPoolEditState`), which is the fix for "a rejected edit discards what
// was typed". The codes and their copy stay in `OPERATION_ERRORS` as backstops
// for a direct `?error=` visit or a hand-built request — this loop is what
// still proves each renders its message rather than nothing.
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
 * the check it was meant to trigger.
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
  await page.getByLabel("Note (required): why this number").fill("flat");
  await page.getByRole("button", { name: "Add flat pool" }).click();
  await page.getByLabel("Paste (names separated by /)").fill("Alice Pilot");
  await page.getByRole("button", { name: "Set roster" }).click();

  // type=number, so the browser refuses to submit text at all.
  await page.getByRole("button", { name: "edit shares for Alice Pilot" }).click();
  await bypassClientGuard(page.getByLabel(/^shares for alice pilot$/i), "abc");
  await page.getByRole("button", { name: "save shares for Alice Pilot" }).click();
  // The message renders inside the open editor now, not as the page-level
  // `?error=` notice — `setParticipantSharesAction` returns state instead of
  // redirecting, which is the whole mechanism that keeps the typed value.
  await expect(page.locator("span.inline-form__err")).toContainText(
    "plain number like 1",
  );
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // The typed value survived the rejection — not the stored 1.00 the roster
  // paste defaulted to. Losing it here is the exact defect this guards: an
  // operator who can no longer see what they typed has to retype it blind,
  // and retyping under time pressure is where a *different* wrong number
  // gets entered.
  await expect(page.getByLabel(/^shares for alice pilot$/i)).toHaveValue("abc");
  // The rejection also refocuses the field, so a keyboard/screen-reader
  // operator lands back exactly where the correction goes rather than on
  // the Submit button they just pressed.
  await expect(page.getByLabel(/^shares for alice pilot$/i)).toBeFocused();

  // No reopen: the editor stayed open through the rejection, which is what
  // "the value is still there" means. Drive a second, different bad value
  // straight into the same field.
  await bypassClientGuard(page.getByLabel(/^shares for alice pilot$/i), "0");
  await page.getByRole("button", { name: "save shares for Alice Pilot" }).click();
  await expect(page.locator("span.inline-form__err")).toContainText("greater than zero");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // Same guard, a second time: a different rejection on the same field still
  // preserves what was just typed rather than snapping back to 1.00.
  await expect(page.getByLabel(/^shares for alice pilot$/i)).toHaveValue("0");
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
 * rather than on error.tsx, and the operator's own typed value (not the
 * stored price) must survive the rejection.
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
  await expect(page.locator("span.inline-form__err")).toContainText(
    "plain number like 12.34",
  );
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // The typed value survived the rejection — the field still shows the
  // rejected "1,234.00", not the stored 10.00. See "bad shares land on the
  // page" above for the reasoning this pins for the money screen generally.
  await expect(page.getByLabel(/^unit price for tritanium$/i)).toHaveValue("1,234.00");
  await expect(page.getByLabel(/^unit price for tritanium$/i)).toBeFocused();
});

/**
 * The datalist is inert HTML, not a type-ahead: it ships with the page, the
 * browser filters it, and the form submits without JavaScript. This asserts
 * the options are in the document — the browser's own popup is not something
 * Playwright can or should drive.
 */
test("manual participant entry suggests one name per person and adds by alt", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  await seedMember(db, {
    name: "Latecomer Pilot",
    tier: "alumni",
    alts: ["Latecomer Alt"],
  });
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
  // The alt is deliberately absent: one suggestion per person. Asserting the
  // absence is the point — a regression that "restores" the alts would leave
  // every other assertion here passing.
  await expect(page.locator("datalist option[value='Latecomer Alt']")).toHaveCount(0);

  // Not suggested is not the same as not addable. Typing the alt in full still
  // resolves through `resolveRosterNames` to the same account, and the row is
  // labelled with the MAIN — which is exactly why suggesting the alt would
  // have offered a string the operator never sees again.
  await page.getByLabel("Character name").fill("Latecomer Alt");
  await page.getByRole("button", { name: "Add participant" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Latecomer Pilot" })).toHaveCount(
    1,
  );
});

/**
 * Same hazard as the flat pool form's clear-on-success test above, on the
 * other add-form: `defaultValue` compiles to the `value` attribute, which a
 * browser ignores once the field's dirty value flag is set, so an
 * uncontrolled input here left the typed name on screen after a successful
 * add. A second press of "Add participant" then added the same person twice,
 * and each duplicate drew a full share. `add-participant-form.tsx` is
 * controlled now and clears in a success effect.
 */
test("a successful participant add clears the character name field", async ({
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
      name: "Clears after add",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();

  await page.goto(`/payouts/${op.id}`);
  await page.getByLabel("Character name").fill("Once Pilot");
  await page.getByRole("button", { name: "Add participant" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Once Pilot" })).toHaveCount(1);
  await expect(page.getByLabel("Character name")).toHaveValue("");
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
  await expect(page.locator("p.notice--bad")).toContainText("already on this roster");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // And the roster is unchanged — the rejection added nothing.
  await expect(page.getByRole("row").filter({ hasText: "Twice Pilot" })).toHaveCount(1);
  // The typed name survived the rejection too — same fix as the shares and
  // unit-price fields above, applied to this add-form's one field.
  await expect(page.getByLabel("Character name")).toHaveValue("Twice Pilot");
  await expect(page.getByLabel("Character name")).toBeFocused();
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
  await page.getByLabel("Note (required): why this number").fill("sold privately");
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
  await page.getByLabel("Note (required): why this number").fill("sold privately");
  await page.getByRole("button", { name: "Add flat pool" }).click();
  await page.getByLabel("Paste (names separated by /)").fill("Brain Tartare");
  await page.getByRole("button", { name: "Set roster" }).click();
  // The roster row is the client-side signal that "Set roster" landed, and
  // pressing Finalize without it is a measured 7/86 failure on this machine
  // (docs/e2e-flake-triage.md). Not a lost submit: the arm press and the
  // confirm press both land, but the revalidation re-renders `ConfirmGroup`
  // between Playwright resolving "confirm finalize" and the click dispatching,
  // so the control is back at rest and the second press re-arms it instead of
  // firing. The operation stays draft with no notice, and "mark paid" — which
  // only exists once finalized — never appears.
  await expect(page.getByText("Brain Tartare")).toBeVisible();

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

  // Neither pasted name is a seeded character, so the redirect now also carries
  // the `?unresolved=` report backlog item 7 added (`payouts/unresolved.ts`) —
  // hence no `$` anchor. The names still land on the roster either way:
  // `resolveRosterNames` gives an unresolved paste entry its own row rather
  // than refusing it, and the report is a warning about those rows, not a
  // replacement for them.
  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+(\?|$)/);
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
  // ...with focus back on the trigger that opened it. The trigger does not
  // exist while the editor is open, so focusing it in the same tick that
  // closes the editor is a no-op against a null ref and drops focus to
  // `<body>` — a keyboard operator working down a roster would land back at
  // the top of the document after every save.
  await expect(
    rowFor("Alice Pilot").getByRole("button", { name: "edit shares for Alice Pilot" }),
  ).toBeFocused();
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
  await page.getByLabel("Note (required): why this number").fill("flat test");
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
  // ...and the same fact is available to someone who cannot see the focus ring,
  // including the amount: three equal shares of 1,000,000.00 ISK is
  // 333,333.33 ISK apiece (`fmtIsk`), so a wrong or unformatted amount here
  // would fail this assertion even though it never touches the focus ring.
  await expect(page.locator("#pay-flow-status")).toContainText(
    "Paid Ada Relay. 1 of 3 paid. Next: Bo Relay, 333,333.33 ISK.",
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

test("the first payment says that it freezes the operation permanently", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Freeze FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedFinalizedRoster(db, operator.id, ["Ada Freeze", "Bo Freeze"]);
  await page.goto(`/payouts/${opId}`);

  // The description is on the control before it is pressed, both at rest and
  // once armed — it has to be available ahead of the press it warns about.
  const rest = page.getByRole("button", { name: "mark paid Ada Freeze" });
  await expect(rest).toHaveAccessibleDescription(/permanently/);
  await rest.click();
  await expect(
    page.getByRole("button", { name: "confirm mark paid Ada Freeze" }),
  ).toHaveAccessibleDescription(/permanently/);

  // It is a description, never part of the name: the name has to stay short
  // enough to be spoken ahead of every press and has to keep matching the
  // visible label (WCAG 2.5.3).
  await expect(
    page.getByRole("button", { name: "confirm mark paid Ada Freeze" }),
  ).toHaveAccessibleName("confirm mark paid Ada Freeze");

  // And it is hidden from the visual layout, at rest and armed alike — unlike
  // ConfirmCost, which reveals itself on arm. Measured rather than asserted
  // with toBeHidden(): `.visually-hidden` is a 1px clip, not display:none, so
  // Playwright counts it visible by design (see the same measurement at
  // account.spec.ts:439-443).
  const costWidth = (await page.locator("#mark-paid-cost").boundingBox())?.width ?? 0;
  expect(costWidth).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "confirm mark paid Ada Freeze" }).click();

  // Once the operation is frozen, later payments are plain one-click buttons
  // and carry no description: there is no cost left to state.
  const later = page.getByRole("button", { name: "mark paid Bo Freeze" });
  await expect(later).toHaveAccessibleDescription("");
  // And the attribute is gone, not merely pointing at nothing. `#mark-paid-cost`
  // unmounts in the same render the button loses its arm step, so a
  // `describedBy` left on would be a dangling IDREF — which computes to an empty
  // accessible description and would slip past the assertion above while audit
  // tooling and some AT report a broken reference.
  await expect(later).not.toHaveAttribute("aria-describedby");
});

test("a second row's mark paid button survives the first payment's arm-to-plain transition", async ({
  page,
  context,
}) => {
  // Regression guard for #146: `arm ? <ConfirmSubmit /> : <Submit />` used to
  // put two different component types in the same JSX slot. React reconciles
  // by type at a position, so the render where `firstPayment` flips false
  // unmounted every still-unpaid row's `ConfirmSubmit` and mounted a fresh
  // `Submit` in its place — the `<button>` DOM node was replaced, not updated,
  // and a press that began on the old node during that swap produced no click
  // on the new one.
  //
  // The probe below is a DOM-identity check rather than a race: React only
  // patches the props it manages, so an attribute set from outside the
  // framework survives an update and is destroyed by a remount. Tagging Bo's
  // button before Ada's payment lands and asserting the tag is still there
  // afterward proves the node itself was never replaced — which is the whole
  // bug, asserted directly instead of raced for.
  const operator = await seedMember(db, {
    name: "Remount FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedFinalizedRoster(db, operator.id, ["Ada Remount", "Bo Remount"]);
  await page.goto(`/payouts/${opId}`);

  const bo = page.getByRole("button", { name: "mark paid Bo Remount" });
  await bo.evaluate((el) => el.setAttribute("data-remount-probe", "1"));
  // Bo starts out on the armed grade — the cost description is the one thing
  // that tells the two grades apart from the outside, since at rest they share
  // a label, a class, a width and an accessible name.
  await expect(bo).toHaveAccessibleDescription(/permanently/);

  await page.getByRole("button", { name: "mark paid Ada Remount" }).click();
  await page.getByRole("button", { name: "confirm mark paid Ada Remount" }).click();
  await expect(
    page.getByRole("row", { name: /Ada Remount/ }).getByText("paid", { exact: true }),
  ).toBeVisible();

  // The transition really happened — without this the test would still pass if
  // `confirm={arm}` regressed to a constant, since nothing would remount and
  // the probe would survive for the wrong reason. An operator on a permanently
  // armed row is back to "I pressed mark paid and nothing happened", which is
  // indistinguishable from the dropped click this test exists to catch.
  await expect(bo).toHaveAccessibleDescription("");
  // And the node itself was never replaced.
  await expect(bo).toHaveAttribute("data-remount-probe", "1");
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
  // assert focus on here, so wait for Ada's own row to settle to "paid" before
  // clicking Bo's row. Do not delete this: the single click below only PAYS Bo
  // once `locked` has come back from the server and dropped Bo's arm step. Land
  // it earlier and Bo is still on the armed grade, so the click arms instead of
  // submitting and every assertion after it fails.
  //
  // #146 removed the other half of what this used to guard — Bo's control no
  // longer swaps component type across that flip, so a click landing mid-render
  // is no longer silently dropped (see the regression test above) — but the
  // grade transition itself is server state and still has to be waited for.
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

test("skipping a row advances past it, not back to it", async ({ page, context }) => {
  const operator = await seedMember(db, {
    name: "Fwd FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedFinalizedRoster(db, operator.id, [
    "Ada Fwd",
    "Bo Fwd",
    "Cy Fwd",
  ]);
  await page.goto(`/payouts/${opId}`);

  // Ada is skipped — offline, disputed, paid out of band. The operator starts
  // at Bo. This is the case the old code got wrong: it resumed from the first
  // unpaid row in the operation, which is Ada, dragging focus and the scroll
  // region back up to the skipped row after every remaining payment.
  await page.getByRole("button", { name: "mark paid Bo Fwd" }).click();
  await page.getByRole("button", { name: "confirm mark paid Bo Fwd" }).click();

  await expect(
    page.getByRole("button", { name: "copy amount for Cy Fwd" }),
  ).toBeFocused();
  await expect(page.locator("#pay-flow-status")).toContainText(
    "Paid Bo Fwd. 1 of 3 paid. Next: Cy Fwd,",
  );
  // Still forward-only: no wrap has happened yet, so nothing announces one.
  await expect(page.locator("#pay-flow-status")).not.toContainText("Back to the first");
});

test("running off the end wraps back to the skipped row and says so", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Wrap FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedFinalizedRoster(db, operator.id, [
    "Ada Wrap",
    "Bo Wrap",
    "Cy Wrap",
  ]);
  await page.goto(`/payouts/${opId}`);

  await page.getByRole("button", { name: "mark paid Bo Wrap" }).click();
  await page.getByRole("button", { name: "confirm mark paid Bo Wrap" }).click();
  await expect(
    page.getByRole("button", { name: "copy amount for Cy Wrap" }),
  ).toBeFocused();

  // Cy is the last row, and Ada above is still owed. Falling off the end has to
  // come back for her rather than jumping to the heading — she is still unpaid
  // and the operator still has to reach her.
  await page.getByRole("button", { name: "mark paid Cy Wrap" }).click();

  await expect(
    page.getByRole("button", { name: "copy amount for Ada Wrap" }),
  ).toBeFocused();
  // The one move that still goes upward announces itself: a silent jump back up
  // the roster is the same disorientation the forward fix exists to remove.
  await expect(page.locator("#pay-flow-status")).toContainText(
    "Paid Cy Wrap. 2 of 3 paid. Back to the first unpaid. Next: Ada Wrap,",
  );
});

/**
 * The notes Save control's hit target, which nothing else on this page pins.
 *
 * It sits under the notes textarea in the operation's own panel, not in a
 * table row, so DESIGN.md's 28px in-row ration does not cover it and it
 * carries the 36px standalone grade. CodeRabbit flagged exactly this gap on
 * #149 — that PR raised this control and shipped spec coverage only for the
 * separate `/admin/accounts` note form.
 *
 * Measured against `Finalize` rather than asserted as a bare `toBe(36)`: the
 * comparison is what makes the number mean "the same grade the page's own
 * standalone controls use" instead of restating a constant. The two cannot be
 * `Save notes` and `mark paid` — the notes form renders only while the
 * operation is a draft (`page.tsx:161`) and `mark paid` only once it is
 * finalized, so no page state shows both grades at once.
 */
test("the notes Save control sits at the page's standalone hit-target grade", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Grade FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Graded roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Graded roam" })).toBeVisible();

  const save = page.getByRole("button", { name: "Save notes" });
  const finalize = page.getByRole("button", { name: "Finalize" });
  const [saveBox, finalizeBox] = await Promise.all([
    save.boundingBox(),
    finalize.boundingBox(),
  ]);
  expect(Math.round(finalizeBox!.height)).toBe(36);
  expect(Math.round(saveBox!.height)).toBe(Math.round(finalizeBox!.height));
});

/**
 * Seeds a *draft* operation — pools, participants, or both. `seedFinalizedRoster`
 * above cannot stand in for this: `canEdit` is
 * `access.isOperator && operation.status === "draft" && !locked`
 * (`src/app/payouts/[id]/page.tsx`), so neither `remove` nor `delete pool` is
 * rendered at all on a finalized operation.
 *
 * Pools come out in `asc(lootPool.id)` order over random uuids
 * (`src/services/payout-view.ts`), which bears no relation to insertion order —
 * hence `pools` is a count and the tests read the rendered order back out of the
 * DOM. Participants order `asc(displayName)`, which is stable, so those tests
 * address rows by name.
 */
async function seedDraft(
  database: typeof db,
  createdBy: string,
  { pools = 0, names = [] }: { pools?: number; names?: string[] },
): Promise<string> {
  const [op] = await database
    .insert(payoutOperation)
    .values({
      name: "Draft run",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy,
      status: "draft",
    })
    .returning();
  if (pools > 0) {
    await database.insert(lootPool).values(
      Array.from({ length: pools }, (_, i) => ({
        operationId: op.id,
        valuationSource: "flat" as const,
        totalValue: "1000000.00",
        // `loot_pool_flat_note_ck` requires one on a flat pool: a manual total
        // with no explanation is exactly what that constraint exists to reject.
        notes: `seeded ${i + 1}`,
      })),
    );
  }
  if (names.length > 0) {
    await database.insert(payoutParticipant).values(
      names.map((displayName) => ({
        operationId: op.id,
        displayName,
        shares: "1",
        excluded: false,
        amount: (1_000_000 / names.length).toFixed(2),
      })),
    );
  }
  return op.id;
}

/**
 * The per-pool delete forms in rendered table order. `deletePoolFormId` carries
 * the pool's uuid, so this is position → identity: the only way to assert that
 * focus landed on *the pool that used to be below the deleted one* rather than
 * on whichever row happens to be numbered 1 after the renumbering.
 */
function deletePoolFormIds(page: Page): Promise<string[]> {
  return page
    .locator('[id^="delete-pool-"]')
    .evaluateAll((els) => els.map((el) => el.id));
}

test("removing a participant moves focus to the row below and announces the count", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Roster Editor",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedDraft(db, operator.id, {
    names: ["Ada Draft", "Bo Draft", "Cy Draft"],
  });
  await page.goto(`/payouts/${opId}`);

  await page.getByRole("button", { name: "remove Bo Draft", exact: true }).click();
  await page
    .getByRole("button", { name: "confirm remove Bo Draft", exact: true })
    .click();

  // The row below, not the top of the table and not <body>: an operator
  // pruning a paste of twenty names keeps their place in the list.
  await expect(
    page.getByRole("button", { name: "remove Cy Draft", exact: true }),
  ).toBeFocused();
  await expect(page.locator("#pay-flow-status")).toHaveText(
    "Removed Bo Draft. 2 participants remain.",
  );
});

test("removing the bottom participant falls back to the row above", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Tail Editor",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedDraft(db, operator.id, {
    names: ["Ada Tail", "Bo Tail", "Cy Tail"],
  });
  await page.goto(`/payouts/${opId}`);

  await page.getByRole("button", { name: "remove Cy Tail", exact: true }).click();
  await page.getByRole("button", { name: "confirm remove Cy Tail", exact: true }).click();

  await expect(
    page.getByRole("button", { name: "remove Bo Tail", exact: true }),
  ).toBeFocused();
  await expect(page.locator("#pay-flow-status")).toHaveText(
    "Removed Cy Tail. 2 participants remain.",
  );
});

test("removing the only participant returns focus to the roster heading", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Last Editor",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedDraft(db, operator.id, { names: ["Solo Draft"] });
  await page.goto(`/payouts/${opId}`);

  await page.getByRole("button", { name: "remove Solo Draft", exact: true }).click();
  await page
    .getByRole("button", { name: "confirm remove Solo Draft", exact: true })
    .click();

  // The table is gone entirely; `PayFlow` has to outlive it to say so, which is
  // why it is mounted outside the `participants.length > 0` guard.
  await expect(page.locator("#roster-heading")).toBeFocused();
  await expect(page.locator("#pay-flow-status")).toHaveText(
    "Removed Solo Draft. 0 participants remain.",
  );
});

test("deleting a pool moves focus to the pool below and announces the count", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Pool Editor",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedDraft(db, operator.id, { pools: 3 });
  await page.goto(`/payouts/${opId}`);

  const ids = await deletePoolFormIds(page);
  expect(ids).toHaveLength(3);

  await page.getByRole("button", { name: "delete pool 1", exact: true }).click();
  await page.getByRole("button", { name: "confirm delete pool 1", exact: true }).click();

  // Addressed by the *surviving* pool's own form id: after the deletion it
  // renumbers to "delete pool 1", so asserting on the label would pass even if
  // focus had gone to the wrong row.
  await expect(page.locator(`#${ids[1]} button`)).toBeFocused();
  await expect(page.locator("#pool-flow-status")).toHaveText(
    "Removed pool 1. 2 pools remain.",
  );
});

test("deleting the bottom pool falls back to the pool above", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Pool Tail Editor",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedDraft(db, operator.id, { pools: 3 });
  await page.goto(`/payouts/${opId}`);

  const ids = await deletePoolFormIds(page);
  await page.getByRole("button", { name: "delete pool 3", exact: true }).click();
  await page.getByRole("button", { name: "confirm delete pool 3", exact: true }).click();

  await expect(page.locator(`#${ids[1]} button`)).toBeFocused();
  await expect(page.locator("#pool-flow-status")).toHaveText(
    "Removed pool 3. 2 pools remain.",
  );
});

test("deleting the only pool returns focus to the Loot heading", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Solo Pool Editor",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedDraft(db, operator.id, { pools: 1 });
  await page.goto(`/payouts/${opId}`);

  const heading = page.locator("#loot-heading");
  await expect(heading).toHaveAttribute("tabindex", "-1");

  await page.getByRole("button", { name: "delete pool 1", exact: true }).click();
  await page.getByRole("button", { name: "confirm delete pool 1", exact: true }).click();

  await expect(heading).toBeFocused();
  await expect(page.locator("#pool-flow-status")).toHaveText(
    "Removed pool 1. 0 pools remain.",
  );
});

/*
 * The `?unresolved=` report (`payouts/unresolved.ts`, `new/unresolved-roster.ts`).
 * Both halves have unit tests, but nothing until now proved the two ends are
 * actually wired to each other: the composer builds a payload, redirects, and
 * the detail page decodes it on arrival. A test that encodes the param itself
 * and navigates to it would pass with the composer wired to nothing.
 *
 * `ClearStaleQuery` is why the param survives long enough to assert on — it
 * clears `?unresolved=` on the NEXT submit, not on mount; see its docblock.
 *
 * The curly apostrophe is the page's own (`didn&rsquo;t`), not a typo.
 */
const UNRESOLVED_NOTICE = "didn’t match a linked character";

test("a paste with names no character matches reports them on arrival", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Report FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Typo roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Roster paste").fill("Report FC / Wrogn Speling / Anothr Typo");
  await page.getByRole("button", { name: "Create operation" }).click();

  await expect(page).toHaveURL(/\?unresolved=/);
  const notice = page.locator("p.notice--warn", { hasText: UNRESOLVED_NOTICE });
  await expect(notice).toContainText("2 roster names didn’t match a linked character");
  // Asserted separately rather than as one "a, b" string: the sample's order
  // is not a promise the report makes, only its membership.
  await expect(notice).toContainText("Wrogn Speling");
  await expect(notice).toContainText("Anothr Typo");
  // The operator's own linked character resolved, so it is not in the report —
  // a report that named every pasted line would say nothing.
  await expect(notice).not.toContainText("Report FC");

  // The unresolved rows are still on the roster drawing a share. The report is
  // a warning about them, not a rejection of them.
  await expect(page.getByRole("row").filter({ hasText: "Wrogn Speling" })).toBeVisible();
});

test("a single unresolved name is reported in the singular", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Solo Report FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("One typo roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Roster paste").fill("Solo Report FC / Lone Typo");
  await page.getByRole("button", { name: "Create operation" }).click();

  await expect(
    page.locator("p.notice--warn", { hasText: UNRESOLVED_NOTICE }),
  ).toContainText("1 roster name didn’t match a linked character");
});

test("an unresolved report past the sample cap counts the remainder", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Cap FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  // 25 against DROPPED_SAMPLE_LIMIT = 20. Zero-padded so no name is a
  // substring of another — "Ghost 2" would match "Ghost 20" below.
  const ghosts = Array.from(
    { length: 25 },
    (_, i) => `Ghost ${String(i + 1).padStart(2, "0")}`,
  );
  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Ghost fleet");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Roster paste").fill(ghosts.join(" / "));
  await page.getByRole("button", { name: "Create operation" }).click();

  const notice = page.locator("p.notice--warn", { hasText: UNRESOLVED_NOTICE });
  // The total is exact even though the sample is capped: it is what the
  // operator decides on, and "20 or so" would not support a re-paste.
  await expect(notice).toContainText("25 roster names didn’t match a linked character");
  await expect(notice).toContainText("Ghost 20");
  await expect(notice).not.toContainText("Ghost 21");
  await expect(notice).toContainText("…and 5 more.");
});

test("a hand-typed unresolved param renders the plain page", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Garbage Reader",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedDraft(db, operator.id, { names: ["Ada Plain"] });

  await page.goto(`/payouts/${opId}?unresolved=not-base64url-json`);

  // Degrades to the plain page, never to an empty or half-filled notice —
  // `decodeUnresolved` returns null and the notice never renders.
  await expect(page.getByRole("heading", { name: "Draft run" })).toBeVisible();
  await expect(
    page.locator("p.notice--warn", { hasText: UNRESOLVED_NOTICE }),
  ).toHaveCount(0);
});

/*
 * Owner walkthrough 2026-08-07, findings 1.1-1.8 (docs/design-walkthrough.md).
 * Each test below pins one acceptance criterion from that session, plus the
 * secondary findings folded into the same fixes.
 */

/**
 * Finding 1.1: `.btn--quiet`'s transparent, borderless rest state reads fine
 * among neighbours that already look like a control row, but an `InlineEdit`
 * trigger stands alone beside plain text — at rest it was indistinguishable
 * from the label it sits beside, and only painted a border on hover. Battle
 * report is the case the walkthrough named; this pins it there and confirms
 * the fix did NOT leak into `.btn--quiet`'s other callers (nav sign out, the
 * filter `clear`), which chose transparent-at-rest on purpose.
 */
test("an InlineEdit trigger reads as a control at rest, not only on hover", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Contrast",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Contrast roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Contrast roam" })).toBeVisible();

  const trigger = page.getByRole("button", { name: "edit battle report URL" });
  const borderColor = await trigger.evaluate((el) => getComputedStyle(el).borderColor);
  // `transparent` computes to `rgba(0, 0, 0, 0)`. A control that still reads
  // that way at rest has not been fixed — the border only exists on hover.
  expect(borderColor).not.toBe("rgba(0, 0, 0, 0)");

  // Sign out is `.btn--quiet` too, outside `.inline-edit`: it sits among the
  // nav's own control row, where transparent-at-rest was a deliberate,
  // unrelated choice this finding never touched.
  const signOut = page.getByRole("button", { name: "sign out" });
  await expect(signOut).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
});

/**
 * Finding 1.2: `ConfirmCost`'s `alwaysHidden` mode (now `visibility="hidden"`)
 * kept Finalize's cost sentence `.visually-hidden` PERMANENTLY — not merely
 * hidden until armed. No sighted operator ever read it, at any point, which is
 * an R4 violation and a worse defect than "reveal it sooner". The fix is
 * `visibility="visible"`: the sentence renders plainly at rest, and arming
 * changes nothing about its visibility.
 */
test("Finalize's cost sentence is readable before arming, not hidden from sighted operators", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Visible",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Visible cost roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Visible cost roam" })).toBeVisible();

  const cost = page.locator("#finalize-cost");
  // Measured, not `toBeVisible()`: `.visually-hidden` is a 1px clip, which
  // Playwright still counts as "visible" by design (see the boundingBox
  // measurement at `e2e/account.spec.ts:439-443` and the mark-paid case
  // above). A real width is the only thing that tells "on screen" apart from
  // "clipped to a pixel".
  const widthAtRest = (await cost.boundingBox())?.width ?? 0;
  expect(widthAtRest).toBeGreaterThan(1);
  await expect(cost).toContainText("Closes the pools, roster and shares");

  // Arming changes nothing about visibility — there is no reveal step to
  // undo, unlike `"reveal"` mode.
  await page.getByRole("button", { name: "Finalize" }).click();
  const widthArmed = (await page.locator("#finalize-cost").boundingBox())?.width ?? 0;
  expect(widthArmed).toBeGreaterThan(1);
  await expect(page.locator("#finalize-cost")).toContainText(
    "Closes the pools, roster and shares",
  );
});

/**
 * Finding 1.3: the notes save confirmation used to be `.visually-hidden`
 * permanently — a sighted operator pressing Save got no feedback at all,
 * since the controlled textarea already showed what was typed and nothing
 * else on screen changed. `"· saved"` (the `note-form.tsx` precedent) is now
 * visible AND is the same `role="status"` node AT hears, so parity runs both
 * directions rather than swapping one channel for the other.
 */
test("saving notes confirms visibly, not only to a screen reader", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Noted Visible",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Noted visibly roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByRole("button", { name: "Create operation" }).click();
  await expect(page.getByRole("heading", { name: "Noted visibly roam" })).toBeVisible();

  const saved = page.locator(".notes-form__saved");
  await expect(saved).toHaveText("");

  await page.getByRole("textbox", { name: "operation notes" }).fill("Third fleet.");
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(saved).toHaveText("· saved");
  // Still the visible node, not a separate hidden echo — one region for both
  // channels, same as `_components/note-form.tsx`.
  await expect(saved).toHaveAttribute("role", "status");

  // Editing again is a fresh, unsaved draft: the confirmation must clear so it
  // never claims a save that has not happened yet.
  await page.getByRole("textbox", { name: "operation notes" }).fill("Third fleet. More.");
  await expect(saved).toHaveText("");

  // ...and typing the acknowledged text back brings it back, because what gates
  // the confirmation is "the textarea matches what the server took", not a
  // dirty flag latched by the first keystroke. A flag cannot express this, and
  // the case it gets wrong for real is the one this stands in for: typing
  // through a save's round trip, where the flag clears for a snapshot the
  // operator has already edited past and leaves "· saved" over unsaved text.
  await page.getByRole("textbox", { name: "operation notes" }).fill("Third fleet.");
  await expect(saved).toHaveText("· saved");
});

/**
 * Finding 1.4: "Add another paste" named only the appraise path, while the
 * accessible name (`ariaLabel`) also named the flat-value escape hatch in
 * `children` — R4's failure the other way round, a sighted operator scanning
 * the collapsed summary never learned the flat-value path existed. The two
 * are now the same text, so there is no `ariaLabel` override left to diverge
 * from what a sighted operator can already read.
 */
test("the flat-value path is named in the visible summary, not only for a screen reader", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Flat Named",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedDraft(db, operator.id, { pools: 1 });

  await page.goto(`/payouts/${opId}`);
  const summary = page.locator("summary", { hasText: "Add another paste" });
  await expect(summary).toHaveText("Add another paste, or a flat value");
  // No override left to name a path the visible text doesn't: the accessible
  // name now comes from the summary's own text content. Suffix rather than
  // exact — `.disc > summary::before` (globals.css) draws the +/- toggle glyph
  // as generated content, and Chromium folds that into the computed name
  // ahead of the real text, which is a pre-existing quirk of every `.disc`
  // summary, not something this fix changed.
  await expect(summary).toHaveAccessibleName(/Add another paste, or a flat value$/);
});

/**
 * Finding 1.5's non-varying column was the items table's "Price source", not
 * the pool table's Source/Value (both of those genuinely vary). A pool is
 * appraised as a whole, so every item shared the same source down the column
 * except the rare row an operator hand-priced or Triff couldn't quote — the
 * column repeated the pool's own source on every other row for that one row's
 * benefit. The marker now lives on the row it distinguishes instead, and only
 * for the two states worth a per-row flag: `manual` and `unresolved`. `triff`
 * (the common case) gets no badge, which is the point.
 */
test("a hand-priced or unresolved item is marked on its own row, not in a page-wide column", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Row Marker",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Marked items",
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
      totalValue: "300.00",
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
      typeId: 35,
      name: "Pyerite",
      qty: 10,
      unitPrice: "10.00",
      totalValue: "100.00",
      priceSource: "manual",
    },
    {
      poolId: poolRow.id,
      typeId: null,
      name: "Nyx",
      qty: 1,
      unitPrice: "100.00",
      totalValue: "100.00",
      priceSource: "unresolved",
    },
  ]);

  await page.goto(`/payouts/${op.id}`);
  // Gone entirely — no column, no header, on a table that still shows three
  // items with three different sources.
  await expect(page.getByRole("columnheader", { name: "Price source" })).toHaveCount(0);

  const rowFor = (name: string) => page.getByRole("row").filter({ hasText: name });
  // The common case earns no badge — a marker on every row is exactly the
  // noise this finding is about.
  await expect(rowFor("Tritanium").getByText("manual", { exact: true })).toHaveCount(0);
  await expect(rowFor("Tritanium").getByText("unresolved", { exact: true })).toHaveCount(
    0,
  );
  await expect(rowFor("Pyerite").getByText("manual", { exact: true })).toBeVisible();
  await expect(rowFor("Nyx").getByText("unresolved", { exact: true })).toBeVisible();
});

/**
 * Finding 1.6: a `Disclosure` collapsed behind "payments (1)" made an operator
 * open a drawer to read the one line it would have shown anyway. Two or more
 * stays folded — `payments (3)` at line ~1572 above still passes — only the
 * single-payment case now renders inline.
 */
test("a single payment renders inline, with no disclosure to open", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Single Pay",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedFinalizedRoster(db, operator.id, ["Solo Payee"]);
  await page.goto(`/payouts/${opId}`);

  await page.getByRole("button", { name: "mark paid Solo Payee" }).click();
  await page.getByRole("button", { name: "confirm mark paid Solo Payee" }).click();

  const row = page.getByRole("row").filter({ hasText: "Solo Payee" });
  await expect(row.locator("summary")).toHaveCount(0);
  // The single event's own line, rendered directly rather than behind a
  // disclosure — "kind, amount ISK by actor" is `payment-history.tsx`'s format.
  await expect(row).toContainText("ISK by");
});

/**
 * Finding 1.8: `primaryStage` was already computed to drive which control
 * gets the gold `.btn--primary` grade, but nothing on the page ever showed
 * the word for it — the one-glance summary answered "where does this stand"
 * but not "what do I do about it". `STAGE_LABEL` surfaces the same value.
 * "none" (finalized, or a read-only viewer) stays silent on purpose: a viewer
 * who cannot edit must never be told to act on an operation they cannot
 * touch.
 */
test("the summary line names the next step for whichever stage is live", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Next Step",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const noLoot = await seedDraft(db, operator.id, {});
  await page.goto(`/payouts/${noLoot}`);
  await expect(page.getByText("next: appraise loot")).toBeVisible();

  const noRoster = await seedDraft(db, operator.id, { pools: 1 });
  await page.goto(`/payouts/${noRoster}`);
  await expect(page.getByText("next: set roster")).toBeVisible();

  const readyToFinalize = await seedDraft(db, operator.id, {
    pools: 1,
    names: ["Ada Ready"],
  });
  await page.goto(`/payouts/${readyToFinalize}`);
  await expect(page.getByText("next: finalize")).toBeVisible();
});

/**
 * Findings 1.2+1.7: the "this is frozen now" paragraph used to live in the
 * Operation section, keyed only on `locked`, explaining a roster consequence
 * (Revert doesn't reopen editing) nowhere near the roster it constrains. It
 * moved to the roster heading, as the `firstPayment`/`locked` else-branch of
 * the pre-freeze warning already there — and `showLifecycle` lost the third
 * disjunct (`locked`) that used to keep the Operation-section `.lifecycle`
 * block mounted for no control, only that paragraph. This pins all three at
 * once: the paragraph is in the roster region (not just present anywhere on
 * the page, which would pass even in the old location), the pre-freeze and
 * post-freeze halves are mutually exclusive, and `.lifecycle` is gone once
 * locked rather than surviving as an empty shell.
 */
test("the frozen-roster paragraph lives beside the roster it explains, and the lifecycle block is gone once locked", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Frozen Home",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedFinalizedRoster(db, operator.id, ["Ada Home", "Bo Home"]);
  await page.goto(`/payouts/${opId}`);

  const frozenText = "A payment has been recorded";
  const preFreezeText = "Marking any row below paid freezes";

  // Before any payment: the pre-freeze half renders, the post-freeze half does
  // not exist yet, and the lifecycle block (Unlock, in this state) is present.
  await expect(page.getByText(preFreezeText)).toBeVisible();
  await expect(page.getByText(frozenText)).toHaveCount(0);
  await expect(page.locator(".lifecycle")).toHaveCount(1);

  await page.getByRole("button", { name: "mark paid Ada Home" }).click();
  await page.getByRole("button", { name: "confirm mark paid Ada Home" }).click();
  await expect(page.getByRole("button", { name: "mark paid Bo Home" })).toBeVisible();

  // After the first payment: the halves swap, mutually exclusively.
  await expect(page.getByText(preFreezeText)).toHaveCount(0);
  const frozen = page.getByText(frozenText);
  await expect(frozen).toBeVisible();

  // Structural, not page-scope: the paragraph must sit after the roster
  // heading and before the next section (Details) in document order — the
  // same idiom `login.spec.ts`'s document-position test uses. A page-scope
  // `getByText` match alone would pass even if this paragraph were still
  // sitting in the Operation section above, which is exactly the regression
  // this test exists to catch.
  const order = await page.evaluate(() => {
    const rosterHeading = document.getElementById("roster-heading")!;
    const details = [...document.querySelectorAll("h2")].find(
      (h) => h.textContent === "Details",
    )!;
    const paragraph = [...document.querySelectorAll("p")].find((p) =>
      p.textContent?.includes("A payment has been recorded"),
    )!;
    // Node.compareDocumentPosition bitmask: 4 = "argument follows node".
    const afterRosterHeading =
      rosterHeading.compareDocumentPosition(paragraph) & Node.DOCUMENT_POSITION_FOLLOWING;
    const beforeDetails =
      paragraph.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING;
    return { afterRosterHeading, beforeDetails };
  });
  expect(order.afterRosterHeading).toBeGreaterThan(0);
  expect(order.beforeDetails).toBeGreaterThan(0);

  // And the Operation-section lifecycle block is gone entirely, not merely
  // emptied: `showLifecycle` is `canFinalize || canRelease`, both false once
  // locked, so dropping the `locked` disjunct that used to keep this div
  // mounted for the paragraph alone did not leave a stray empty wrapper.
  await expect(page.locator(".lifecycle")).toHaveCount(0);
});

/*
 * Walkthrough finding 2.1: "/payouts cannot answer 'was I paid?'". One
 * operation per `viewerState`, each seeded with a distinct `occurredAt` so
 * ordering is deterministic and each row is found by name. The viewer's
 * participant row is tied to their account by `accountId` (`payout-view.ts`'s
 * viewerState collapse matches on that column, not on display name), which is
 * what makes "paid"/"unpaid"/"excluded" resolvable at all.
 *
 * "absent" and "unresolved" differ only in whether the OTHER rows resolved:
 * a roster carrying a null `accountId` cannot prove the viewer wasn't one of
 * those names, so it must not claim they weren't there.
 */
test("the Yours column renders paid, unpaid, excluded, absent and unresolved distinctly", async ({
  page,
  context,
}) => {
  const viewer = await seedMember(db, {
    name: "Viewer Pilot",
    tier: "member",
    status: "active",
  });
  const other = await seedMember(db, {
    name: "Other Pilot",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, viewer.id)]);

  async function seedOp(opts: {
    name: string;
    occurredAt: Date;
    status: "draft" | "finalized";
    // undefined = viewer has no row; `resolved` then decides whether the
    // rest of the roster resolved, i.e. "absent" vs "unresolved".
    viewer?: { excluded?: boolean; paid?: boolean };
    resolved?: boolean;
  }): Promise<void> {
    const [op] = await db
      .insert(payoutOperation)
      .values({
        name: opts.name,
        occurredAt: opts.occurredAt,
        corpSharePct: "0",
        status: opts.status,
      })
      .returning();
    await db.insert(lootPool).values({
      operationId: op.id,
      valuationSource: "flat",
      totalValue: "100.00",
      notes: "seeded",
    });
    if (opts.viewer) {
      await db.insert(payoutParticipant).values({
        operationId: op.id,
        accountId: viewer.id,
        displayName: "Viewer Pilot",
        shares: "1",
        excluded: opts.viewer.excluded ?? false,
        amount: opts.viewer.excluded ? "0.00" : "100.00",
        paidAmount: opts.viewer.paid ? "100.00" : null,
      });
    } else {
      // Someone else's roster. Resolved to a real account, the viewer's
      // absence is a fact; left null it is only an unmatched paste.
      await db.insert(payoutParticipant).values({
        operationId: op.id,
        accountId: opts.resolved ? other.id : null,
        displayName: "Someone Else",
        shares: "1",
        amount: "100.00",
      });
    }
  }

  await seedOp({
    name: "Paid op",
    occurredAt: new Date("2026-08-05"),
    status: "finalized",
    viewer: { paid: true },
  });
  await seedOp({
    name: "Unpaid finalized op",
    occurredAt: new Date("2026-08-04"),
    status: "finalized",
    viewer: { paid: false },
  });
  await seedOp({
    name: "Unpaid draft op",
    occurredAt: new Date("2026-08-03"),
    status: "draft",
    viewer: { paid: false },
  });
  await seedOp({
    name: "Excluded op",
    occurredAt: new Date("2026-08-02"),
    status: "finalized",
    viewer: { excluded: true },
  });
  await seedOp({
    name: "Absent op",
    occurredAt: new Date("2026-08-01"),
    status: "finalized",
    resolved: true,
  });
  await seedOp({
    name: "Unresolved op",
    occurredAt: new Date("2026-07-31"),
    status: "finalized",
    resolved: false,
  });

  await page.goto("/payouts");

  const yoursCellFor = (opName: string) =>
    page.getByRole("row").filter({ hasText: opName }).getByRole("cell").last();

  // paid: tone ok, same token the roster page uses for a paid participant.
  const paidCell = yoursCellFor("Paid op");
  await expect(paidCell.locator(".st--ok")).toHaveText("paid");

  // unpaid + finalized: the stalled case, tone warn — matching the Paid
  // column's own logic for a finalized roster still owing money.
  const finalizedUnpaidCell = yoursCellFor("Unpaid finalized op");
  await expect(finalizedUnpaidCell.locator(".st--warn")).toHaveText("unpaid");

  // unpaid + draft: ordinary work in progress, tone neutral — not alarming.
  const draftUnpaidCell = yoursCellFor("Unpaid draft op");
  await expect(draftUnpaidCell.locator(".st")).toHaveText("unpaid");
  await expect(draftUnpaidCell.locator(".st--warn")).toHaveCount(0);
  await expect(draftUnpaidCell.locator(".st--ok")).toHaveCount(0);

  // excluded: distinct word and tone from "unpaid" — the roster explicitly
  // left this viewer out, rather than simply not having paid them yet.
  const excludedCell = yoursCellFor("Excluded op");
  await expect(excludedCell.locator(".st--off")).toHaveText("excluded");

  // absent: not on the roster at all, distinct from excluded. The dash idiom
  // this file already uses elsewhere — aria-hidden glyph plus visually-hidden
  // words, never an aria-label on a bare span (see the Total cell's comment).
  const absentCell = yoursCellFor("Absent op");
  await expect(absentCell.getByText("not on this roster")).toBeAttached();
  await expect(absentCell.locator(".st")).toHaveCount(0);

  // unresolved: the same dash, a different sentence. The roster carries a name
  // that matched no character, so the viewer may be on it under an unlinked
  // alt — stating "not on this roster" here would be a false claim to exactly
  // the reader this column was added for.
  const unresolvedCell = yoursCellFor("Unresolved op");
  await expect(unresolvedCell.getByText("roster has unresolved names")).toBeAttached();
  await expect(unresolvedCell.getByText("not on this roster")).toHaveCount(0);
  await expect(unresolvedCell.locator(".st")).toHaveCount(0);

  // No ISK figure in the Yours column — the read model deliberately carries
  // no amount (payout-view.ts's viewerState docblock).
  await expect(paidCell).not.toContainText("ISK");
});

test("searching the operation name narrows the list", async ({ page, context }) => {
  const reader = await seedMember(db, { name: "Search Reader", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, reader.id)]);
  await db.insert(payoutOperation).values([
    { name: "Thursday roam", occurredAt: new Date("2026-08-05") },
    { name: "Friday CTA", occurredAt: new Date("2026-08-04") },
  ]);

  await page.goto("/payouts");
  await page.getByLabel("Name").fill("thurs");
  await page.getByRole("button", { name: "Filter" }).click();

  await expect(page).toHaveURL(/[?&]q=thurs\b/);
  await expect(page.getByRole("link", { name: "Thursday roam" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Friday CTA" })).toHaveCount(0);
  // The clear control is only offered while a filter is active.
  await expect(page.getByRole("link", { name: "clear" })).toBeVisible();
});

test("the status filter narrows to draft or finalized", async ({ page, context }) => {
  const reader = await seedMember(db, { name: "Status Reader", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, reader.id)]);
  await db.insert(payoutOperation).values([
    { name: "Draft only", occurredAt: new Date("2026-08-05"), status: "draft" },
    {
      name: "Finalized only",
      occurredAt: new Date("2026-08-04"),
      status: "finalized",
    },
  ]);

  await page.goto("/payouts?status=draft");
  await expect(page.getByRole("link", { name: "Draft only" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Finalized only" })).toHaveCount(0);
  await expect(page.getByLabel("Status")).toHaveValue("draft");
});

/*
 * The correctness rule pre-written above the pager: a filter must DROP
 * `before`, because a cursor taken from a wider query pages into the middle
 * of a narrower one. 51 operations so `Older` is on screen, landing this test
 * on a page carrying `?before=`; submitting the filter form must not carry
 * that cursor forward into the newly (and differently) scoped query.
 */
test("submitting a filter drops an active cursor", async ({ page, context }) => {
  const reader = await seedMember(db, { name: "Cursor Filter Reader", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, reader.id)]);
  await db.insert(payoutOperation).values(
    Array.from({ length: 51 }, (_, i) => ({
      name: `Cursor Op ${String(i).padStart(2, "0")}`,
      occurredAt: new Date(Date.UTC(2026, 6, 1) - i * 86_400_000),
    })),
  );

  await page.goto("/payouts");
  await page.getByRole("link", { name: "Older" }).click();
  await expect(page).toHaveURL(/\/payouts\?before=/);

  await page.getByLabel("Name").fill("Cursor Op 00");
  await page.getByRole("button", { name: "Filter" }).click();

  await expect(page).toHaveURL(/[?&]q=Cursor(\+|%20)Op(\+|%20)00\b/);
  // Synchronous — `page.url()` returns a string, not a Promise, so awaiting it
  // is a no-op the lint rule correctly rejects.
  expect(page.url()).not.toContain("before=");
  await expect(
    page.getByRole("link", { name: "Cursor Op 00", exact: true }),
  ).toBeVisible();
});

/*
 * `Older` must carry the active filter forward, not just the cursor — a
 * filtered list that only grew an `Older` link because the pager forgot the
 * filter would silently widen the result set on page 2.
 */
test("the pager preserves an active filter across Older", async ({ page, context }) => {
  const reader = await seedMember(db, { name: "Pager Filter Reader", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, reader.id)]);
  // 51 matching rows plus one distractor that must never appear on either page.
  await db.insert(payoutOperation).values([
    ...Array.from({ length: 51 }, (_, i) => ({
      name: `Fleet Op ${String(i).padStart(2, "0")}`,
      occurredAt: new Date(Date.UTC(2026, 6, 1) - i * 86_400_000),
    })),
    { name: "Distractor", occurredAt: new Date("2026-05-01") },
  ]);

  await page.goto("/payouts?q=Fleet");
  await expect(
    page.getByRole("link", { name: "Fleet Op 00", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Fleet Op 49", exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Older" }).click();
  await expect(page).toHaveURL(/[?&]q=Fleet\b/);
  await expect(page).toHaveURL(/[?&]before=/);
  await expect(
    page.getByRole("link", { name: "Fleet Op 50", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Distractor" })).toHaveCount(0);

  // `← Latest` from here must return to page 1 of the SAME filter, not the
  // unfiltered list.
  await page.getByRole("link", { name: "Latest" }).click();
  await expect(page).toHaveURL(/[?&]q=Fleet\b/);
  // Synchronous — `page.url()` returns a string, not a Promise, so awaiting it
  // is a no-op the lint rule correctly rejects.
  expect(page.url()).not.toContain("before=");
  await expect(
    page.getByRole("link", { name: "Fleet Op 00", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Distractor" })).toHaveCount(0);
});

/*
 * A filter matching nothing is a THIRD empty case, distinct from both "no
 * operations recorded yet" (nothing was ever created) and the past-end
 * cursor state — reading it as either would tell an operator their data is
 * gone, which is false.
 */
test("a filter matching nothing renders its own empty state, not 'no operations'", async ({
  page,
  context,
}) => {
  const reader = await seedMember(db, { name: "No Match Reader", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, reader.id)]);
  await db.insert(payoutOperation).values({
    name: "Real operation",
    occurredAt: new Date("2026-08-01"),
  });

  await page.goto("/payouts?q=nonexistent-fleet-name");
  await expect(page.getByText("Nothing matches this filter.")).toBeVisible();
  await expect(page.getByText("No operations recorded yet.")).toHaveCount(0);

  await page.getByRole("link", { name: "Back to every operation" }).click();
  await expect(page).toHaveURL(/\/payouts$/);
  await expect(page.getByRole("link", { name: "Real operation" })).toBeVisible();
});

/**
 * Seeds three finalized operations, one of them named with an unbroken
 * 60-character token, each carrying the 12-digit total the column budget in
 * globals.css was measured against. Operation names are operator-typed `text`
 * with no cap in schema.ts, unlike the EVE-bounded character names the accounts
 * table pins, so that token is the one input that could grow the Name column
 * until it covers the region it is meant to anchor. A short name and a small
 * total would understate how far the row runs and make every width below pass
 * for the wrong reason.
 */
async function seedWidePayoutList(viewerId: string) {
  for (const [i, name] of [
    "Aaa First Operation Name",
    "B".repeat(60),
    "Ccc Third Operation",
  ].entries()) {
    const [op] = await db
      .insert(payoutOperation)
      .values({
        name,
        occurredAt: new Date(`2026-08-0${5 - i}`),
        corpSharePct: "0",
        status: "finalized",
      })
      .returning();
    await db.insert(lootPool).values({
      operationId: op.id,
      valuationSource: "flat",
      totalValue: "123456789012.00",
      notes: "seeded",
    });
    await db.insert(payoutParticipant).values({
      operationId: op.id,
      accountId: viewerId,
      displayName: "Pin Viewer",
      shares: "1",
      amount: "123456789012.00",
      paidAmount: "123456789012.00",
    });
  }
}

/**
 * The pinned Name column, at a width where the table is still a table and is
 * still forced to scroll.
 *
 * Six columns need 736px worst case (the budget is measured out in globals.css
 * beside `.log--payouts`), so scrolling is not the defect — losing the row's
 * identity while panning to Total is. Under ruling R3 /payouts is a corp-wide
 * ledger, which makes "which operation is this figure for?" the question every
 * other cell depends on, so these are correctness tests in the same sense as
 * the accounts table's pin tests, not cosmetic ones.
 *
 * 560px, not the 320px and 390px this asserted at previously. Below 30rem the
 * row now reflows to labelled blocks and there is no horizontal scroll left to
 * pin anything out of, so `maxScrollLeft > 0` cannot hold there — the guard on
 * the first assertion is doing its job, not reporting a regression. The reflow
 * is covered by its own test below. 560px is the narrowest round width above
 * the 30rem breakpoint where the 736px budget still exceeds the region, so the
 * pin is under real load rather than nominally present.
 */
test("payouts at 560px: the operation name stays put while Total is reached", async ({
  page,
  context,
}) => {
  const viewer = await seedMember(db, {
    name: "Pin Viewer",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, viewer.id)]);
  await seedWidePayoutList(viewer.id);

  await page.setViewportSize({ width: 560, height: 720 });
  await page.goto("/payouts");
  await page.waitForSelector(".scroller tbody tr");

  const pinned = await pinGeometry(
    page,
    ".scroller",
    "tbody tr:first-child td:first-child",
    "right",
  );
  // Vacuous unless there was something to scroll past in the first place.
  expect(pinned.maxScrollLeft).toBeGreaterThan(0);
  expect(pinned.scrolledLeft).toBeGreaterThanOrEqual(
    pinned.maxScrollLeft - pinned.gutterWidth,
  );
  // Fully on screen at the far right, not merely intersecting by a sliver —
  // the distinction `toBeInViewport` cannot make (see geometry.ts).
  expect(pinned.overlapX).toBeCloseTo(pinned.cellWidth, 0);
  expect(pinned.overlapY).toBeGreaterThan(0);
  expect(pinned.text).toContain("Aaa First Operation Name");

  // The corner cell rides with the column it heads: a NAME column left under
  // a heading that reads TOTAL is worse than no heading at all.
  const corner = await pinGeometry(page, ".scroller", "thead th:first-child", "right");
  expect(corner.overlapX, "the Name heading stays over the pinned column").toBeCloseTo(
    corner.cellWidth,
    0,
  );
  expect(corner.text).toContain("Name");

  // The pin has to leave most of the region for the columns it exists to let
  // you reach. The same 60% ceiling the account manifest is held to — and
  // the reason `overflow-wrap: anywhere` is on this column, since the
  // 60-character row below would otherwise set its width.
  const longRow = await pinGeometry(
    page,
    ".scroller",
    "tbody tr:nth-child(2) td:first-child",
    "right",
  );
  expect(longRow.text).toContain("B");
  expect(
    longRow.cellWidth / longRow.regionWidth,
    "an unbroken 60-character name does not turn the pin into the page",
  ).toBeLessThan(0.6);
});

/**
 * Below 30rem the row stops being a row. The pin was the previous answer at
 * these widths and it defeated itself: measured at 69px of a 286px region —
 * 24% — which is a column too narrow to read an operation name out of and
 * still the only thing kept while panning across five more. The 60% ceiling
 * above is a ceiling with no floor, so 24% passed it exactly as 55% would.
 *
 * The three assertions are the three ways the reflow can be wrong, and none of
 * them can pass while the bug they describe is present:
 *
 *   - it did not happen at all (cells still laid out in a row, table still
 *     scrolling sideways);
 *   - it happened and dropped facts, which would collapse the /payouts-vs-
 *     /account distinction ruling R3 draws;
 *   - it happened and left the columns unnamed, which is ruling R4's
 *     both-channels requirement — the `<thead>` is `display: none` down here,
 *     so a `.payouts__label` in each cell is the only thing naming them, in
 *     the visual channel and the accessibility tree alike.
 */
for (const width of [320, 390]) {
  test(`payouts at ${width}px: each row reflows to labelled blocks, nothing dropped`, async ({
    page,
    context,
  }) => {
    const viewer = await seedMember(db, {
      name: "Pin Viewer",
      tier: "member",
      status: "active",
    });
    await context.addCookies([await sessionCookieFor(db, viewer.id)]);
    await seedWidePayoutList(viewer.id);

    await page.setViewportSize({ width, height: 900 });
    await page.goto("/payouts");
    await page.waitForSelector(".scroller tbody tr");

    // The 60-character row: the widest thing this table can be asked to hold.
    const row = page.locator(".scroller tbody tr").nth(1);

    const geometry = await row.evaluate((tr) => {
      const scroller = tr.closest(".scroller") as HTMLElement;
      const cells = Array.from(tr.querySelectorAll("td"));
      return {
        maxScrollLeft: scroller.scrollWidth - scroller.clientWidth,
        // Distinct `top` values means the cells stack. One shared `top` is
        // the unreflowed table, and is what this asserts against.
        distinctTops: new Set(
          cells.map((td) => Math.round(td.getBoundingClientRect().top)),
        ).size,
        cellCount: cells.length,
        headVisible: getComputedStyle(tr.closest("table")!.querySelector("thead")!)
          .display,
        firstCellPosition: getComputedStyle(cells[0]).position,
      };
    });

    expect(geometry.cellCount, "no column is dropped on a phone").toBe(6);
    expect(geometry.distinctTops, "the six cells stack instead of running across").toBe(
      6,
    );
    expect(geometry.headVisible).toBe("none");
    // `.log--sticky-col` is still on the element; its `position: sticky` has to
    // lose to the reflow or the first cell pins against a table that no longer
    // scrolls.
    expect(geometry.firstCellPosition).toBe("static");
    expect(geometry.maxScrollLeft, "nothing left to pan sideways").toBe(0);

    // Both channels, per R4: the label is a real element, so it is in the
    // accessibility tree as well as on screen. Checked on the Total cell,
    // whose figure is the one the reader panned right for under the old
    // layout and the one most likely to end up unlabelled.
    const totalCell = row.locator("td").nth(3);
    await expect(totalCell.locator(".payouts__label")).toBeVisible();
    await expect(totalCell).toContainText("Total");
    await expect(totalCell).toContainText("123,456,789,012");
  });
}

/**
 * The roster at 390px. Measured before the fix: 253px of a 339px region spent
 * on Shares and Amount, leaving State and every row control off the right
 * edge. State is the cell answering the question a member opened the page to
 * ask, so the column a phone dropped was the most important one on the table.
 *
 * The assertion is positional rather than a visibility check, because the
 * fix's whole content is where the cells land: State has to sit on the same
 * line as the name it describes, and above the numbers rather than after them.
 * A `toBeVisible()` here would have passed before the fix too — the cell was
 * rendered and scrollable-to, just unreachable without panning.
 */
test("the roster at 390px puts state beside the name, with nothing scrolled off", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "Narrow FC",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);
  const opId = await seedFinalizedRoster(db, operator.id, ["Ada Narrow", "Bo Narrow"]);

  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/payouts/${opId}`);
  await page.waitForSelector(".log--roster tbody tr");

  const box = await page
    .locator(".log--roster tbody tr")
    .first()
    .evaluate((tr) => {
      const cells = Array.from(tr.querySelectorAll("td")).map((td) => {
        const r = td.getBoundingClientRect();
        return { top: Math.round(r.top), right: Math.round(r.right) };
      });
      const scroller = tr.closest(".scroller") as HTMLElement;
      return {
        name: cells[0],
        shares: cells[1],
        state: cells[3],
        actions: cells[4],
        regionRight: Math.round(scroller.getBoundingClientRect().right),
        maxScrollLeft: scroller.scrollWidth - scroller.clientWidth,
      };
    });

  // State shares the name's line: same question, same answer.
  expect(box.state.top, "state sits beside the name it describes").toBe(box.name.top);
  // And the numbers have moved below both.
  expect(box.shares.top).toBeGreaterThan(box.name.top);
  expect(box.actions.top).toBeGreaterThan(box.shares.top);

  // Nothing is off the right edge any more — the defect, stated directly.
  expect(box.state.right).toBeLessThanOrEqual(box.regionRight);
  expect(box.actions.right).toBeLessThanOrEqual(box.regionRight);
  // Measured at 390px: the table lays out at exactly the scroller's 356px client
  // width and every cell sits inside it, but the scroller still reports 357px of
  // scroll range. That last pixel is a scroller-level rounding artifact, not a
  // column parked off-screen, and `Scroller` already discounts it — the
  // `scrollWidth > clientWidth + 1` test at `scroller.tsx:53` leaves the region
  // at `tabIndex={-1}` with no edge fades. Assert against the same threshold the
  // component uses rather than a stricter one it was never held to.
  expect(
    box.maxScrollLeft,
    "no sideways pan left to lose a column behind",
  ).toBeLessThanOrEqual(1);
});

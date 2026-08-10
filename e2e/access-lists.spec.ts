/**
 * SEED TIMES HERE MUST BE RELATIVE TO `Date.now()`, NEVER A LITERAL DATE.
 *
 * Same discipline `sync.spec.ts` states at the top of itself, for the same
 * reason: this page renders every observation with its age, so a snapshot
 * pinned to a fixed instant reads as fresh on the day the test is written and
 * as months-stale forever after — and it fails as a stale assertion in an
 * unrelated run long after the line that caused it. Use `ago()`.
 *
 * Every row here is seeded DIRECTLY. Dry-run forbids live reads and the job
 * refuses to run without a token, so the job cannot produce fixtures; the
 * tables are the contract this page reads and the tests write them.
 */
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import {
  accessListCatalog,
  accessListEntry,
  accessListHolder,
  accessListSnapshot,
  accessListWatch,
  auditLog,
  character,
  esiEntityName,
  outbox,
} from "../src/db/schema";
import { ACCESS_LISTS_SCOPE } from "../src/lib/esi/client";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();

test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

const LIST_ID = 4001;

/**
 * An admin whose main character carries whatever scope the test needs, signed
 * in. Returns the character id so the holder row can point at it.
 */
async function asAdmin(
  context: import("@playwright/test").BrowserContext,
  opts: {
    scopes?: string[];
    tokenStatus?: "valid" | "invalid" | "needs_reauth" | "missing";
  } = {},
) {
  const acc = await seedMember(db, { name: "Vela Kaine", tier: "member", isAdmin: true });
  const [c] = await db
    .update(character)
    .set({
      scopes: opts.scopes ?? [ACCESS_LISTS_SCOPE],
      tokenStatus: opts.tokenStatus ?? "valid",
    })
    .where(eq(character.accountId, acc.id))
    .returning({ id: character.id });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  return { accountId: acc.id, characterId: c.id };
}

async function seedHolder(characterId: number) {
  await db.insert(accessListHolder).values({ id: 1, characterId, designatedBy: "e2e" });
}

async function seedCatalog(
  characterId: number,
  opts: { accessListId?: number; name?: string } = {},
) {
  await db.insert(accessListCatalog).values({
    accessListId: opts.accessListId ?? LIST_ID,
    name: opts.name ?? "Fleet staging",
    discoveredAt: ago(10 * MIN),
    observedByCharacterId: characterId,
  });
}

/** A watched list with a successful read and the membership rows behind it. */
async function seedWatched(
  characterId: number,
  opts: {
    accessListId?: number;
    name?: string;
    readStatus?: "ok" | "not_visible" | "failed";
    allowEveryone?: boolean;
    entries?: Array<{ kind: "character" | "corporation" | "alliance"; entityId: number }>;
    detail?: string | null;
  } = {},
) {
  const accessListId = opts.accessListId ?? LIST_ID;
  const name = opts.name ?? "Fleet staging";
  await db.insert(accessListWatch).values({ accessListId, addedBy: "e2e" });
  await db.insert(accessListSnapshot).values({
    accessListId,
    observedAt: ago(3 * MIN),
    lastAttemptAt: ago(3 * MIN),
    readStatus: opts.readStatus ?? "ok",
    observedByCharacterId: characterId,
    name,
    description: "",
    allowEveryone: opts.allowEveryone ?? false,
    detail: opts.detail ?? null,
  });
  for (const e of opts.entries ?? []) {
    await db.insert(accessListEntry).values({
      accessListId,
      kind: e.kind,
      entityId: e.entityId,
      access: "member",
    });
  }
}

test("state 1: no holder and no scope asks for the grant, and shows no table", async ({
  page,
  context,
}) => {
  await asAdmin(context, { scopes: [] });
  await page.goto("/admin/access-lists");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Access lists");
  await expect(page.locator(".lede")).toContainText("Nobody has granted");
  await expect(page.getByRole("link", { name: "Grant access" })).toHaveAttribute(
    "href",
    "/auth/eve/link?grant=access-lists",
  );
  // Nothing to be stale about, so no watched-list section at all — an empty
  // table here would read as "no drift".
  await expect(page.getByRole("heading", { name: "Watched lists" })).toHaveCount(0);
  // And no "Check now" either. This is the state a fresh deployment opens on,
  // and the job returns at its first branch with no holder to read as — so the
  // button could only ever have answered with a timestamped confirmation that
  // nothing observable had been arranged.
  await expect(page.getByRole("button", { name: "Check now" })).toHaveCount(0);
});

test("state 2: a granted character with no holder gets the designate button", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await page.goto("/admin/access-lists");

  await expect(page.locator(".lede")).toContainText("Designate it as the holder");
  await expect(page.getByRole("button", { name: "Designate as holder" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Grant access" })).toHaveCount(0);
});

test("state 3: a holder whose scope was dropped is offered the GRANTING link, not a plain re-auth", async ({
  page,
  context,
}) => {
  // The distinction is the whole point: the plain /auth/eve/link is what drops
  // the scope, so offering it here would send the admin round the loop that
  // caused the outage.
  const { characterId } = await asAdmin(context, { scopes: [] });
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId);
  await page.goto("/admin/access-lists");

  await expect(page.locator(".lede")).toContainText("no longer carries the access-list");
  // Lowercase mid-sentence ("...it, so no reads are happening.") — this state's
  // sentence is one clause, unlike holder-needs-reauth/holder-no-token's
  // separate "No reads are happening." sentence — so the case must match the
  // actual copy rather than the brief's shorthand.
  await expect(page.locator(".lede")).toContainText("no reads are happening");
  await expect(page.getByRole("link", { name: "Re-grant access" })).toHaveAttribute(
    "href",
    "/auth/eve/link?grant=access-lists",
  );
  // The last successful observation still renders beneath the problem.
  await expect(page.getByRole("heading", { name: "Watched lists" })).toBeVisible();
  await expect(page.locator(".acl-list__row")).toContainText("Fleet staging");
  // The table stays and the button does not, and the split is deliberate: a
  // stale answer is worth showing, but a check cannot produce a new one — the
  // job returns as soon as it reads the persisted scopes. The re-granting link
  // above is the only action here that changes anything.
  await expect(page.getByRole("button", { name: "Check now" })).toHaveCount(0);
});

test("states 4 and 5: a stale authorization and a dead token are different sentences", async ({
  page,
  context,
}) => {
  const reauth = await asAdmin(context, { tokenStatus: "needs_reauth" });
  await seedHolder(reauth.characterId);
  await seedCatalog(reauth.characterId);
  await page.goto("/admin/access-lists");
  await expect(page.locator(".lede")).toContainText("authorization has gone stale");
  await expect(page.getByRole("link", { name: "Re-authenticate" })).toBeVisible();

  await resetDb(db);
  const dead = await asAdmin(context, { tokenStatus: "missing" });
  await seedHolder(dead.characterId);
  await seedCatalog(dead.characterId);
  await page.goto("/admin/access-lists");
  await expect(page.locator(".lede")).toContainText("no stored token");
  await expect(
    page.getByRole("link", { name: "Add this character again" }),
  ).toBeVisible();
});

test("state 6: a healthy holder with an empty catalog offers Check now as the primary", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await page.goto("/admin/access-lists");

  await expect(page.locator(".lede")).toContainText("No lists have been discovered");
  await expect(page.getByRole("button", { name: "Check now" })).toHaveClass(
    /btn--primary/,
  );
});

test("state 7: a clean list is one line with nothing to open", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  // The one member character is listed explicitly, so nothing is missing and
  // nobody unexpected has access.
  const [member] = await db
    .select({ id: character.id })
    .from(character)
    .where(eq(character.name, "Vela Kaine"));
  await seedWatched(characterId, {
    entries: [{ kind: "character", entityId: member.id }],
  });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("in sync");
  // No disclosure control at all — not a closed one. A toggle over an empty
  // box is a promise the row cannot keep.
  await expect(row.locator("summary")).toHaveCount(0);

  // …but it is still removable. The row with no drawer is exactly the row an
  // admin most wants off the page, and for one revision of this design its
  // only "Stop watching" lived inside a drawer this row never renders — which
  // made a clean list permanently unwatchable. Asserted here, on the row that
  // has no `summary`, because that is the shape the bug hid in.
  await expect(row.getByRole("button", { name: "Stop watching" })).toBeVisible();
  await row.getByRole("button", { name: "Stop watching" }).click();
  // `.last()`: the empty-state `Notice` ("No lists are being watched yet.")
  // sits INSIDE the same region-wide `ConfirmingForm` (ahead of it in the
  // DOM), and both it and the group's own confirmation render at once once
  // the last row is gone — `.first()` would catch the wrong one here.
  await expect(page.locator(".notice").last()).toContainText(
    "removed from the watchlist",
  );
  await expect(page.locator(".acl-list__row")).toHaveCount(0);
  await expect(page.getByText("No lists are being watched yet.")).toBeVisible();
});

test("a drifted row opens to names, reads warn not bad, and its drawer survives Stop watching", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  // Two drifted rows, not one: with a single watched list, the row whose
  // drawer this test asserts on IS the row "Stop watching" deletes, so
  // `summary` is gone by construction and the assertion below is
  // unsatisfiable no matter how correct the page is. A second row gives the
  // test a `summary` that presses on THIS row cannot touch, which is the
  // only shape that can actually catch a `Disclosure` reset.
  const SECOND_LIST_ID = 4002;
  await seedCatalog(characterId);
  await seedCatalog(characterId, { accessListId: SECOND_LIST_ID, name: "Home defense" });
  // Nobody from the roster is listed, and one stranger is: both buckets at once.
  await seedWatched(characterId, {
    entries: [{ kind: "character", entityId: 99_000_123 }],
  });
  await seedWatched(characterId, {
    accessListId: SECOND_LIST_ID,
    name: "Home defense",
    entries: [{ kind: "character", entityId: 99_000_124 }],
  });
  await page.goto("/admin/access-lists");

  const rowA = page.locator(".acl-list__row").filter({ hasText: "Fleet staging" });
  const rowB = page.locator(".acl-list__row").filter({ hasText: "Home defense" });
  await expect(rowA).toContainText("1 missing access");
  await expect(rowA).toContainText("1 has access, not a member");
  // Drift is warn. `bad` is reserved for destructive acts and nothing this
  // page reports is one.
  await expect(rowA.locator(".st--warn")).toBeVisible();
  await expect(rowA.locator(".st--bad")).toHaveCount(0);

  const summaryA = rowA.locator("summary");
  await expect(summaryA).toHaveAttribute("aria-expanded", "false");
  await summaryA.click();
  await expect(summaryA).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: /Missing access \(1\)/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /not a member \(1\)/ })).toBeVisible();
  // Scoped to row A: `Disclosure` renders both rows' `.acl-detail` into the
  // DOM regardless of which is open (visibility is CSS, not conditional
  // render), so an unscoped `.acl-detail` locator is ambiguous the moment a
  // second drifted row exists.
  await expect(rowA.locator(".acl-detail")).toContainText("Vela Kaine");

  const summaryB = rowB.locator("summary");
  await summaryB.click();
  await expect(summaryB).toHaveAttribute("aria-expanded", "true");

  // The reason `removeWatchAction` returns an `ActionOutcome` instead of
  // redirecting: a redirect replaces the route tree and resets `Disclosure`'s
  // `useState`, closing every open drawer on the press that used it. Pressing
  // "Stop watching" on row A's own drawer, then reading row B's `summary`, is
  // what would catch that regression — row A's own drawer cannot be asked
  // this question, because row A is the row that just left the DOM.
  await rowA.getByRole("button", { name: "Stop watching" }).click();
  await expect(page.locator(".notice")).toContainText("removed from the watchlist");
  await expect(summaryB).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".acl-list__row")).toHaveCount(1);
  await expect(rowA).toHaveCount(0);
});

test("a corporation grant states our count AND that it is partial", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId, {
    entries: [{ kind: "corporation", entityId: 98_000_555 }],
  });
  await page.goto("/admin/access-lists");

  await page.locator(".acl-list__row summary").click();
  // We store a corporation per character and hold no corp roster, so the page
  // must never imply the second bucket is complete for a broad grant.
  await expect(page.locator(".acl-detail")).toContainText(
    "plus an unknown number of others",
  );
});

test("a failed read keeps the last good observation and dates it", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId, {
    readStatus: "not_visible",
    entries: [{ kind: "character", entityId: 99_000_123 }],
  });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("not visible to holder");
  await expect(row.locator(".st--warn")).toBeVisible();
  await row.locator("summary").click();
  await expect(page.locator(".acl-detail .notice--warn")).toContainText(
    "last successful read",
  );
});

test("allow_everyone is stated in its own words, never as zero discrepancies", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId, { allowEveryone: true });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("open to everyone");
  await expect(row).not.toContainText("in sync");
  await expect(row.locator(".st--warn")).toBeVisible();
});

test("Check now enqueues a read and audits nothing", async ({ page, context }) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await page.goto("/admin/access-lists");

  await page.getByRole("button", { name: "Check now" }).click();
  // `.first()`: the catalog is seeded but the watchlist is empty, so the page
  // also renders its own "No lists are being watched yet." notice below the
  // controls — `ConfirmNotice`'s redirect-carried confirmation is the one
  // that renders first, right under the `h1`.
  await expect(page.locator(".notice").first()).toContainText("Check queued");

  const queued = await db.select().from(outbox);
  expect(queued).toHaveLength(1);
  // Enqueuing a READ changes no state, and `runJob` already records the run in
  // `sync_run`. An audit row here would be a state change that never happened.
  const audits = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "access_list.check_requested"));
  expect(audits).toHaveLength(0);
});

/**
 * The skip link has to move the caret, not just the viewport. A fragment link
 * focuses its target only if the platform already considers that target
 * focusable, and `<main>` is not — so without `tabIndex={-1}` the page scrolls
 * to the content and focus stays back in the header, and the next Tab walks the
 * admin through the nav they just asked to skip (SC 2.4.1).
 *
 * Asserted as focus, never as `toHaveAttribute("tabindex", "-1")`: the
 * attribute is the mechanism and the caret is the requirement, and a `<main>`
 * made focusable some other way would fail an attribute check while doing
 * exactly the right thing.
 */
test("the skip link moves focus into the page, not just the scroll position", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await page.goto("/admin/access-lists");

  await page.keyboard.press("Tab");
  const skip = page.locator("a:focus");
  await expect(skip).toHaveAttribute("href", "#main");
  await skip.press("Enter");

  const landed = await page.evaluate(() => document.activeElement?.id);
  expect(landed, "focus stayed behind the skip link").toBe("main");
});

/**
 * The row toggle's accessible name must hold still. Its name is computed from
 * its contents, and one of those is `RelativeTime` — a client component on a
 * shared 30s ticker — so the control used to rename itself twice a minute with
 * nothing about the row having changed: SC 4.1.2 for a screen reader that
 * re-announces a control it sees renamed, and SC 3.2.4 for a voice user whose
 * remembered phrase stops matching the page.
 *
 * The two reads are compared against each other rather than against a literal.
 * A literal would pin today's wording and start passing for the wrong reason
 * the day the summary gains a field.
 */
test("a watched row's toggle does not rename itself as its timestamp ages", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  // Entries the alliance roster does not contain, so the row has findings and
  // therefore renders a disclosure at all — a clean row is a plain `<li>` with
  // no toggle to name.
  await seedWatched(characterId, {
    entries: [
      { kind: "character", entityId: 9001 },
      { kind: "character", entityId: 9002 },
    ],
  });

  // Before `goto`: the clock has to be in place while the page's own scripts
  // load or the ticker captures the real timers on the way past.
  await page.clock.install();
  await page.goto("/admin/access-lists");

  const summary = page.locator(".acl-list__disc > summary");
  const nameOf = () => summary.evaluate((el) => el.getAttribute("aria-label") ?? "");
  const before = await nameOf();
  // Non-empty, or the two reads below would agree vacuously.
  expect(before).not.toBe("");
  // And it still leads with what a voice user would say, so 2.5.3 holds.
  expect(before).toContain("Fleet staging");

  // The visible "ago" moving is what proves the tick landed. Without this the
  // test would pass on a page where nothing ticked at all, which is the
  // failure it exists to rule out.
  const stamp = summary.locator(".ago");
  const stampBefore = await stamp.innerText();
  await page.clock.fastForward("05:00");
  await expect(stamp).not.toHaveText(stampBefore);

  expect(await nameOf(), "the toggle renamed itself as the clock moved").toBe(before);
});

/**
 * The two halves of one decision, asserted as a pair on purpose. Either half
 * alone passes on a page that hard-codes the other: a page permanently narrow
 * satisfies the first, a page permanently wide satisfies the second, and only
 * the pair says the measure actually follows the content.
 */
test("a page with no table is narrow and says nothing about watched lists", async ({
  page,
  context,
}) => {
  // A holder whose token went stale, with nothing discovered and nothing
  // watched. `showsObservations` is true here — there is a holder — but there
  // is no observation to show, so the region would be a heading over a notice
  // saying the heading has nothing under it.
  const { characterId } = await asAdmin(context, { tokenStatus: "needs_reauth" });
  await seedHolder(characterId);
  await page.goto("/admin/access-lists");

  await expect(page.locator(".lede")).toContainText("gone stale");
  await expect(page.getByRole("heading", { name: "Watched lists" })).toHaveCount(0);
  await expect(page.getByText("No lists are being watched yet.")).toHaveCount(0);
  // One sentence and one link do not want a 78rem column.
  await expect(page.locator("main#main")).toHaveClass(/page--narrow/);
});

test("a page with a table is wide", async ({ page, context }) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedWatched(characterId);
  await page.goto("/admin/access-lists");

  await expect(page.getByRole("heading", { name: "Watched lists" })).toBeVisible();
  await expect(page.locator("main#main")).toHaveClass(/page--wide/);
});

test("a list watched before its first read is named from the catalog, not by id", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  // Deliberately NOT `seedWatched`: the watch row alone, with no snapshot,
  // which is the state every list is in between "Add to watchlist" and the
  // worker's next run. The snapshot is where the name used to come from, so
  // the row printed a bare `#4001` for a list the catalog could name all along.
  await db.insert(accessListWatch).values({ accessListId: LIST_ID, addedBy: "e2e" });
  await page.goto("/admin/access-lists");

  const row = page.locator(".acl-list__row");
  await expect(row).toContainText("Fleet staging");
  await expect(row).not.toContainText(`#${LIST_ID}`);
  await expect(row).toContainText("not read yet");
});

/** Two members of one corporation, neither on the list. */
async function seedMissingPair(corporationIds: [number, number]) {
  const a = await seedMember(db, { name: "Rane Solette", tier: "member" });
  const b = await seedMember(db, { name: "Ivo Tarn", tier: "member" });
  await db
    .update(character)
    .set({ corporationId: corporationIds[0] })
    .where(eq(character.accountId, a.id));
  await db
    .update(character)
    .set({ corporationId: corporationIds[1] })
    .where(eq(character.accountId, b.id));
}

test("one corporation behind every missing member is stated once, not per row", async ({
  page,
  context,
}) => {
  const CORP = 98_000_777;
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedMissingPair([CORP, CORP]);
  await db
    .insert(esiEntityName)
    .values({ id: CORP, kind: "corporation", name: "Static Vector" });
  // Only the admin is on the list, so the pair above is exactly `missingAccess`.
  await seedWatched(characterId, {
    entries: [{ kind: "character", entityId: characterId }],
  });
  await page.goto("/admin/access-lists");

  await page.locator(".acl-list__row summary").click();
  const detail = page.locator(".acl-detail");
  await expect(detail.locator(".acl-detail__norm")).toHaveText(
    "All of them are in Static Vector.",
  );
  // Said once. Printed per row it appeared twice and told the two rows apart
  // not at all, which is the whole finding.
  await expect(detail.getByText("Static Vector")).toHaveCount(1);
  // And the column that carried it is gone with it.
  await expect(detail.getByRole("columnheader", { name: "Corporation" })).toHaveCount(0);
  // The names are what the admin retypes in-game, so they survive intact.
  await expect(detail).toContainText("Rane Solette");
  await expect(detail).toContainText("Ivo Tarn");
});

test("missing members from different corporations keep the column that tells them apart", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  await seedMissingPair([98_000_777, 98_000_888]);
  await seedWatched(characterId, {
    entries: [{ kind: "character", entityId: characterId }],
  });
  await page.goto("/admin/access-lists");

  await page.locator(".acl-list__row summary").click();
  const detail = page.locator(".acl-detail");
  await expect(detail.getByRole("columnheader", { name: "Corporation" })).toBeVisible();
  await expect(detail.locator(".acl-detail__norm")).toHaveCount(0);
});

test("the only control in a watched row does not read as another caption", async ({
  page,
  context,
}) => {
  const { characterId } = await asAdmin(context);
  await seedHolder(characterId);
  await seedCatalog(characterId);
  // A clean row, so the button sits directly in the `<li>` rather than inside
  // a closed drawer — the shape the new rule is scoped by descendant selector
  // to cover in both cases, and the one that is visible without a press.
  await seedWatched(characterId, {
    entries: [{ kind: "character", entityId: characterId }],
  });
  await page.goto("/admin/access-lists");

  // `.btn--quiet` sets `border-color: transparent`, which computes to
  // `rgba(0, 0, 0, 0)` — the value this asserts against rather than any
  // particular colour, so it cannot be satisfied by an outline of the wrong
  // grade and does not pin a token. Without the outline the row's one
  // pressable thing sits at the weight of the labels around it.
  const outline = await page
    .getByRole("button", { name: "Stop watching" })
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(outline).not.toBe("rgba(0, 0, 0, 0)");
});

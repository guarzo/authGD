import { expect, test, type Locator, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { account } from "../src/db/schema";
import { clearOfPin, coveredByPin, pinGeometry } from "./geometry";
import { BASE_URL } from "./env";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

/**
 * The accounts table's own data rows.
 *
 * The drawer is a sibling `<tr>` of the row it belongs to now, not a
 * `<details>` nested in the name cell (see the `as="row"` shape in
 * disclosure.tsx), and it holds a
 * full crew table. So a bare `tbody tr` filtered by an account name matches
 * three elements for one account — the collapsed row, its drawer row, and the
 * crew row for the same character — and any assertion needing exactly one is a
 * strict mode violation. `>` scopes to the outer table's own tbody; the class
 * filter drops the drawer.
 */
const ROWS = ".log--dense > tbody > tr:not(.drawer-row)";
const rowFor = (page: Page, name: string) => page.locator(ROWS, { hasText: name });
/** Every row's controls live in the drawer, which is the `<tr>` right after it. */
const drawerOf = (row: Locator) => row.locator("xpath=following-sibling::tr[1]");
/** The name toggle: a `<button>` now, not a `<summary>`. */
const toggleOf = (row: Locator) => row.locator(".row-toggle");

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

async function seedWorld() {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await seedMember(db, { name: "Azzy", tier: "green", status: "cryo" });
  await seedMember(db, { name: "Zed", tier: "flygd" });
  return admin;
}

/** Enough rows that the accounts table overflows the capped scroll region. */
async function seedDenseWorld() {
  const admin = await seedMember(db, { name: "Aaa Boss", tier: "flygd", isAdmin: true });
  for (let i = 0; i < 24; i++) {
    await seedMember(db, { name: `Member ${String(i).padStart(2, "0")}` });
  }
  return admin;
}

// Three denials, three destinations. The pair below is the one that reads as a
// single case and isn't: a visitor with no cookie has never signed in, so
// "your session ended" would name an event that never happened.
test("a visitor who has never signed in gets the plain login page", async ({ page }) => {
  await page.goto("/admin/accounts");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator(".notice--bad")).toHaveCount(0);
});

test("a visitor whose session died is told so", async ({ page, context }) => {
  await context.addCookies([
    { name: "authgd_session", value: "long-dead-session", url: BASE_URL },
  ]);
  await page.goto("/admin/accounts");
  await expect(page).toHaveURL(/\/login\?error=session_expired/);
});

// resolveAdmin distinguishes "no session" from "signed in but not an admin" —
// see lib/admin-guard.ts — so a de-roled member lands on their own account
// page with an explanation, not back at the login screen as if they'd never
// signed in.
test("a signed-in non-admin is sent to their account page, not login", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, { name: "Pleb" });
  await context.addCookies([await sessionCookieFor(db, member.id)]);
  await page.goto("/admin/accounts");
  await expect(page).toHaveURL(/\/account\?error=not_admin/);
  // Filtered, not bare: Next's dev-only `__next-route-announcer__` is also
  // `role="alert"`, so a bare role query intermittently resolves to two
  // elements and fails on strict mode. A `page.goto` does not reliably leave
  // the announcer empty — this arrival is a server redirect to a *different*
  // route, which the App Router announces like any other route change, and
  // whether the announcer has been cleared again by the time the assertion
  // runs is a race. Filtering keeps the role assertion, which is the property
  // worth holding: `<Notice tone="bad">` derives `role="alert"` from the tone,
  // so a notice demoted to `warn` (role="status") must still fail here.
  await expect(
    page.getByRole("alert").filter({ hasText: "admin access was removed" }),
  ).toContainText("admin access was removed");
});

/**
 * The same distinction, on the server-action path rather than the page path.
 * These are separate guards: a layout does not protect an action and does not
 * re-run on soft navigation, so requireAdminAction is what actually gates the
 * click. It used to `throw`, which landed on error.tsx — "Something broke…
 * that's a fault on this end, not something you did." For the case that
 * actually occurs, that copy was a lie: another admin clearing your admin bit
 * while you had the page open is a race the app expects.
 *
 * De-roling *after* the page renders is the whole point. The button only
 * exists because the page was rendered by an admin; flipping the bit behind it
 * reproduces the real race rather than a state no user can reach.
 */
test("an admin de-roled after the page loaded gets the notice, not the error boundary", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/sync");
  await expect(
    page.getByRole("button", {
      name: "Sync membership, contacts, wanderer, discord-roles",
    }),
  ).toBeVisible();

  await db.update(account).set({ isAdmin: false }).where(eq(account.id, admin.id));

  await page
    .getByRole("button", { name: "Sync membership, contacts, wanderer, discord-roles" })
    .click();
  await expect(page).toHaveURL(/\/account\?error=not_admin/);
  // Scoped rather than a bare `getByRole("alert")`: Next's
  // `__next-route-announcer__` is also `role="alert"`, so a bare role query
  // matches two elements. This was once believed to be specific to
  // client-side navigation, with a full `page.goto` leaving the announcer
  // empty — it isn't. The sibling test above flaked the same way on a plain
  // `goto`, and it now filters by text for the same reason.
  await expect(page.locator("p.notice--bad")).toContainText("admin access was removed");
  await expect(page.getByText("Something broke")).toHaveCount(0);
});

test("admin list sorts by name and by tier, and filters cryo", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const mains = page.locator(`${ROWS} > td:first-child .row-toggle`);
  await expect(mains).toHaveText(["Azzy", "Boss", "Zed"]); // default name asc
  await page.getByRole("link", { name: "Tier", exact: true }).click();
  await expect(mains.first()).toHaveText(/Boss|Zed/); // flygd ranks first
  await page.goto("/admin/accounts?status=cryo");
  await expect(mains).toHaveText(["Azzy"]);
});

test("tier and cryo read as values; their controls live behind the row expander", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  // The tier and cryo columns carry a badge and nothing else, so a scan down
  // either column is a scan of state. This is the regression this test exists
  // for: a control in one of these cells is indistinguishable from the value
  // next to it, because both are mono-uppercase and say the same word.
  await expect(page.locator(`${ROWS} > td:nth-child(2) button`)).toHaveCount(0);
  await expect(page.locator(`${ROWS} > td:nth-child(3) button`)).toHaveCount(0);
  const zedRow = rowFor(page, "Zed");
  await expect(zedRow.locator("td:nth-child(2) .tier")).toHaveText(/flygd/);
  // The tier controls name their row in their accessible name, so match on that
  // rather than on the visible word alone — `name: "blue"` now matches nothing
  // at all, and toBeHidden() is satisfied by an element that does not exist.
  //
  // Scoped to the drawer rather than the row: the drawer is the row's sibling
  // now, so a control inside it is not a descendant of the collapsed row and
  // `zedRow.getByRole(...)` would find nothing whether the rule holds or not.
  await expect(
    drawerOf(zedRow).getByRole("button", { name: "Set Zed to blue" }),
  ).toBeHidden();
});

test("the row expander is labelled and reports its state", async ({ page, context }) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const toggle = toggleOf(rowFor(page, "Zed"));
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // The name has to survive into the accessible name (WCAG 2.5.3), and the
  // name alone has to say what the control does.
  await expect(toggle).toHaveAccessibleName(/^Zed .*controls/);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("tier controls: manual set locks; return-to-auto unlocks", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const zedRow = rowFor(page, "Zed");
  const zedDrawer = drawerOf(zedRow);
  await toggleOf(zedRow).click();
  await zedDrawer.getByRole("button", { name: "Set Zed to blue" }).click();
  // The lock mark is a CSS ::after (see ui.tsx/globals.css), not text, so it's
  // asserted via the element it's drawn on rather than getByText.
  await expect(zedRow.locator(".tier__lock")).toBeVisible();
  await expect(zedRow.locator(".tier")).toHaveText(/blue/);
  // The drawer holds the controls, so it has to survive the revalidation the
  // server action triggers or the next click has nothing to land on. The open
  // state is React state in Disclosure and the closed drawer row is
  // `hidden`, so visibility is what reports it — there is no `open` property
  // to read any more.
  await expect(zedDrawer).toBeVisible();
  await zedDrawer.getByRole("button", { name: "auto" }).click();
  await expect(zedRow.locator(".tier__lock")).not.toBeVisible();
});

// The drawer holds every control for the row, so a server action that collapsed
// it would make each edit cost a re-open. Its open state is React state in
// Disclosure rather than the DOM's own `open` attribute, precisely so this
// survives the revalidatePath re-render by design instead of by luck.
test("saving a note keeps the row drawer open and persists the note", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const zedRow = rowFor(page, "Zed");
  const zedDrawer = drawerOf(zedRow);
  await toggleOf(zedRow).click();
  await expect(zedDrawer).toBeVisible();
  const noteField = zedDrawer.getByPlaceholder("notes");
  const savedNotice = zedDrawer.locator(".note-form__saved");
  // Nobody has clicked save yet, so the confirmation must not be showing. The
  // rest of this test never checks this on its own: the first thing it does
  // is fill the field, which already flips `dirty` true and would hide a
  // wrongly-always-on confirmation for free, so this has to run before that.
  await expect(savedNotice).not.toBeVisible();
  await noteField.fill("watch this one");
  const save = zedDrawer.getByRole("button", { name: "save note" });
  await save.click();
  // Submit disables itself while the action is in flight; waiting for it to
  // come back is what tells us the write has landed.
  await expect(save).toBeEnabled();
  await expect(zedDrawer).toBeVisible();
  // The write lands with nothing else on screen changing: the field already
  // shows the typed text and the drawer stays open by design, so the saved
  // confirmation is the only proof that survives the action completing.
  await expect(savedNotice).toBeVisible();
  await expect(savedNotice).toHaveText(/saved/);
  // A stale "saved" sitting next to text nobody has saved yet is a lie, so
  // editing the field again has to clear it immediately, before any submit.
  await noteField.fill("watch this one, revised");
  await expect(savedNotice).not.toBeVisible();
  // A second save has to bring the confirmation back, not just the first.
  // This pins the repeat-value class of bug: any "just saved" signal that can
  // return the same value twice (a fixed sentinel, or a clock two saves could
  // tie on) leaves `state === seen` in note-form.tsx, so `dirty` never clears
  // and this assertion fails. It does NOT reproduce a millisecond collision
  // specifically — the two saves here are seconds apart, so a `Date.now()`
  // implementation would pass. `saveNoteAction`'s counter removes the class
  // rather than relying on this test to catch one instance of it.
  await save.click();
  await expect(save).toBeEnabled();
  await expect(savedNotice).toBeVisible();
  // Re-read from the server. Asserting the value on the same input the test
  // just typed into would pass whether or not anything was persisted.
  await page.reload();
  const reloaded = rowFor(page, "Zed");
  await toggleOf(reloaded).click();
  await expect(drawerOf(reloaded).getByPlaceholder("notes")).toHaveValue(
    "watch this one, revised",
  );
});

test("the skip link moves focus to the main landmark", async ({ page, context }) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  await page.keyboard.press("Tab");
  await expect(page.locator("a.skip")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

/* --- The approval queue --------------------------------------------------- */

/**
 * `TIERS` and `TIER_FILTERS` in admin/accounts/page.tsx are the whole mechanism
 * behind this section, and neither is reachable from a unit test: both are
 * module-local `const`s inside a server component whose only export is the page.
 * They are also plain arrays with no type relationship to each other, so nothing
 * but the tests below stands between a one-word edit and either an admin locking
 * an established account into the approval queue forever (`pending` added to
 * TIERS) or the queue becoming unfindable (`pending` dropped from TIER_FILTERS).
 */

async function seedQueue() {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const waiting = await seedMember(db, { name: "Waiting Pilot", tier: "pending" });
  await seedMember(db, { name: "Settled Pilot", tier: "green" });
  return { admin, waiting };
}

test("an admin reaches the queue from the count link and approves", async ({
  page,
  context,
}) => {
  const { admin, waiting } = await seedQueue();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  const queueLink = page.getByRole("link", { name: /awaiting approval/i });
  await expect(queueLink).toHaveText("1 account awaiting approval");
  await queueLink.click();
  await expect(page).toHaveURL(/tier=pending/);

  // Asserted as rows that must be ABSENT, not just as the pending row being
  // present. `pending` reaches the `?tier=` whitelist only via TIER_FILTERS, and
  // a value that misses the whitelist falls through to `tier: undefined` — an
  // unfiltered list, in which the pending row is still present and every
  // presence-only assertion below still passes. The queue silently becoming the
  // full member list is the failure this filter has.
  await expect(rowFor(page, "Waiting Pilot")).toHaveCount(1);
  await expect(rowFor(page, "Settled Pilot")).toHaveCount(0);
  await expect(rowFor(page, "Boss")).toHaveCount(0);
  await expect(page.locator(ROWS)).toHaveCount(1);

  // ...and the fall-through those absences are guarding against, shown rather
  // than described: a `?tier=` the whitelist does not recognise renders every
  // account, with no empty state and nothing on the page saying the filter was
  // ignored. That is exactly the screen `?tier=pending` would silently become.
  await page.goto("/admin/accounts?tier=not_a_tier");
  await expect(page.locator(ROWS)).toHaveCount(3);
  await page.goto("/admin/accounts?tier=pending");
  await expect(page.locator(ROWS)).toHaveCount(1);

  const row = rowFor(page, "Waiting Pilot");
  const drawer = drawerOf(row);
  await toggleOf(row).click();
  // Named for the row like every other per-account control: the visible label
  // is "Approve as Green" on every queued account, and this is the press that
  // grants someone access.
  await drawer
    .getByRole("button", { name: "approve Waiting Pilot as green", exact: true })
    .click();

  // The queue is empty, so the standing reminder is gone...
  await expect(page.getByRole("link", { name: /awaiting approval/i })).toHaveCount(0);
  // ...and the ?tier=pending view it linked to is empty too, which is also the
  // second half of the filter claim above: the approved account left this view.
  await expect(page.locator("td.log__empty")).toHaveText("No members match this filter.");
  // Read from the database rather than from the page: green is the unlocked
  // grant, so the membership job may still move it later.
  const [approved] = await db.select().from(account).where(eq(account.id, waiting.id));
  expect(approved.tier).toBe("green");
  expect(approved.tierLocked).toBe(false);
});

test("pending is never offered as a manual tier an admin can assign", async ({
  page,
  context,
}) => {
  const { admin } = await seedQueue();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  // A settled account offers the three manual tiers and no way back into the
  // queue. `pending` is in TIER_FILTERS but must never reach TIERS, which is
  // what the drawer's Set-tier map renders from.
  const settled = rowFor(page, "Settled Pilot");
  const settledDrawer = drawerOf(settled);
  await toggleOf(settled).click();
  for (const tier of ["flygd", "blue", "green"]) {
    await expect(
      settledDrawer.getByRole("button", {
        name: `Set Settled Pilot to ${tier}`,
        exact: true,
      }),
    ).toBeVisible();
  }
  // Matched on the accessible name pattern rather than on the bare word: the
  // tier controls all name their row, so `name: "pending"` would match nothing
  // whether the rule holds or not.
  await expect(settledDrawer.getByRole("button", { name: /to pending$/ })).toHaveCount(0);
  await expect(settledDrawer.getByRole("button", { name: /^approve /i })).toHaveCount(0);

  // ...and the converse on a pending row: the approve pair replaces the manual
  // tiers rather than joining them, so there is no way to stamp a queued
  // account without going through approveAccount's audit entry.
  const waiting = rowFor(page, "Waiting Pilot");
  const waitingDrawer = drawerOf(waiting);
  await toggleOf(waiting).click();
  await expect(
    waitingDrawer.getByRole("button", {
      name: "approve Waiting Pilot as green",
      exact: true,
    }),
  ).toHaveText("Approve as Green");
  await expect(
    waitingDrawer.getByRole("button", {
      name: "approve Waiting Pilot as blue",
      exact: true,
    }),
  ).toHaveText("Approve as Blue");
  await expect(
    waitingDrawer.getByRole("button", { name: /^Set Waiting Pilot to/ }),
  ).toHaveCount(0);
});

/**
 * The count is its own query, deliberately not derived from the rows on screen:
 * `rows` is narrowed by tier AND status, so counting it would hide the queue
 * from an admin looking at ?status=cryo — precisely when a standing reminder is
 * most useful, since nothing else on that screen mentions the queue at all.
 */
test("the awaiting-approval count survives a status filter that hides the queue", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  // Active, so ?status=cryo excludes it from the table below.
  await seedMember(db, { name: "Waiting Pilot", tier: "pending" });
  await seedMember(db, { name: "Frozen Pilot", tier: "green", status: "cryo" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts?status=cryo");

  await expect(rowFor(page, "Frozen Pilot")).toHaveCount(1);
  await expect(rowFor(page, "Waiting Pilot")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /awaiting approval/i })).toHaveText(
    "1 account awaiting approval",
  );
});

/**
 * Two admins working the queue, or one with a tab open since this morning. The
 * account is approved either way — just not by the admin who clicked — so this
 * is a race the app expects, not a server fault, and it must not land on
 * error.tsx's "Something broke… that's a fault on this end".
 */
test("approving an account someone else already approved lands on a notice, not the error boundary", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  const waiting = await seedMember(db, { name: "Waiting Pilot", tier: "pending" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts?tier=pending");

  const row = rowFor(page, "Waiting Pilot");
  await toggleOf(row).click();
  const approve = drawerOf(row).getByRole("button", {
    name: "approve Waiting Pilot as green",
    exact: true,
  });
  await expect(approve).toBeVisible();

  // The other admin's approval, landing between this render and the click
  // below. Written directly rather than through the action so that
  // approveAccount's own re-check under the row lock is what has to catch it.
  await db.update(account).set({ tier: "blue" }).where(eq(account.id, waiting.id));

  await approve.click();
  // Back to the queue, not to the unfiltered list: the admin was working the
  // queue and has more of it to work.
  await expect(page).toHaveURL(/tier=pending&error=not_pending/);
  // Scoped rather than a bare getByRole("alert"): Next's dev-only
  // `__next-route-announcer__` carries the same role.
  await expect(page.locator("p.notice--bad")).toContainText(
    "already approved by someone else",
  );
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // The other admin's grant stands — the losing click must not re-stamp it.
  const [after] = await db.select().from(account).where(eq(account.id, waiting.id));
  expect(after.tier).toBe("blue");
});

/**
 * The same race one level up, on the actor rather than the target: an admin
 * de-roled while the queue was open. requireAdminAction catches this before
 * approveAccount's own `not_authorized` check ever runs, so what this pins is
 * the destination, which both agree on — /account, where the member is still
 * signed in and is told what changed, rather than the error boundary.
 */
test("a de-roled admin's approve click gets the notice, not the error boundary", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await seedMember(db, { name: "Waiting Pilot", tier: "pending" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts?tier=pending");

  const row = rowFor(page, "Waiting Pilot");
  await toggleOf(row).click();
  const approve = drawerOf(row).getByRole("button", {
    name: "approve Waiting Pilot as green",
    exact: true,
  });
  await expect(approve).toBeVisible();

  await db.update(account).set({ isAdmin: false }).where(eq(account.id, admin.id));

  await approve.click();
  await expect(page).toHaveURL(/\/account\?error=not_admin/);
  await expect(page.locator("p.notice--bad")).toContainText("admin access was removed");
  await expect(page.getByText("Something broke")).toHaveCount(0);
});

// The three `.drawer__label`s (Set tier / Cryo / Note) top-align, so their
// control rows should too. `.note-form` used to add its own `margin-top` on
// top of `.drawer__group`'s `gap`, pushing the note input ~12px below the
// tier and freeze buttons even though all three labels lined up (measured at
// 1440x900: labels at y=593.8, tier/freeze controls at y=618.8, note input at
// y=630.8). Pinned here so a re-added margin regresses this test rather than
// only being visible on a designer's screen.
test("the note control aligns with the tier and freeze control rows", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/accounts");
  const zedRow = rowFor(page, "Zed");
  const zedDrawer = drawerOf(zedRow);
  await toggleOf(zedRow).click();
  await expect(zedDrawer).toBeVisible();

  const tierBox = await zedDrawer.locator(".btn-group").boundingBox();
  const freezeBox = await zedDrawer
    .getByRole("button", { name: "freeze Zed" })
    .boundingBox();
  const noteBox = await zedDrawer.locator(".note-form .field").boundingBox();
  if (!tierBox || !freezeBox || !noteBox) {
    throw new Error("expected all three control rows to be measurable");
  }
  // 4px tolerance for subpixel layout, not a real misalignment: the tier
  // buttons and freeze sit exactly together already (both are `.btn--micro`),
  // so the gap under test is only the note row's own offset.
  expect(Math.abs(tierBox.y - freezeBox.y)).toBeLessThanOrEqual(4);
  expect(Math.abs(tierBox.y - noteBox.y)).toBeLessThanOrEqual(4);
});

/* --- Narrow-screen operability ------------------------------------------ */

/**
 * The measured problem: reaching a row's tier controls means scrolling the
 * region right, which takes the character's name off the left edge — so a 28px
 * control changes someone's tier with nothing on screen saying whose. Under
 * "derole, don't boot" a wrong-person-deroled press is the thing to prevent, so
 * the pinned column is a correctness device and these are correctness tests.
 */
for (const width of [320, 390, 768]) {
  test(`accounts at ${width}px: the name stays put while the controls are reached`, async ({
    page,
    context,
  }) => {
    const admin = await seedDenseWorld();
    await context.addCookies([await sessionCookieFor(db, admin.id)]);
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/admin/accounts");
    await page.waitForSelector(".scroller tbody tr");

    const pinned = await pinGeometry(
      page,
      ".scroller",
      "tbody tr:first-child td:first-child",
      "right",
    );
    // There has to be something to scroll past, or the assertion is vacuous.
    expect(pinned.maxScrollLeft).toBeGreaterThan(0);
    expect(pinned.scrolledLeft).toBe(pinned.maxScrollLeft);
    // Fully on screen, not merely intersecting by a sliver.
    expect(pinned.overlapX).toBeCloseTo(pinned.cellWidth, 0);
    expect(pinned.overlapY).toBeGreaterThan(0);
    expect(pinned.text).toContain("Aaa Boss");

    // The corner cell rides with the column it heads. Left behind, the pinned
    // names sit under whichever heading the scroll happened to stop on — a
    // NAME column labelled ACTIONS is worse than no heading at all.
    const corner = await pinGeometry(page, ".scroller", "thead th:first-child", "right");
    expect(corner.overlapX, "the NAME heading stays over the pinned column").toBeCloseTo(
      corner.cellWidth,
      0,
    );
    expect(corner.text).toContain("Name");

    // ...and the controls at the far right of the row — the ones that made the
    // scroll necessary — are clear of the pinned cell at the same time as the
    // name. That pairing is the whole point of the pin.
    const clear = await clearOfPin(
      page,
      ".scroller",
      "tbody tr:first-child td:last-child form:last-child button",
    );
    expect(clear, "sync now is not under the pinned column").toBeCloseTo(1, 5);
  });

  test(`accounts at ${width}px: the header stays put while the rows are scrolled`, async ({
    page,
    context,
  }) => {
    const admin = await seedDenseWorld();
    await context.addCookies([await sessionCookieFor(db, admin.id)]);
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/admin/accounts");
    await page.waitForSelector(".scroller tbody tr");

    const head = await pinGeometry(page, ".scroller", "thead th:first-child", "down");
    expect(head.maxScrollTop).toBeGreaterThan(0);
    expect(head.scrolledTop).toBe(head.maxScrollTop);
    expect(head.overlapY).toBeCloseTo(head.cellHeight, 0);
    expect(head.text).toContain("Name");
  });

  test(`no horizontal page scroll on any admin page at ${width}px`, async ({
    page,
    context,
  }) => {
    const admin = await seedDenseWorld();
    await context.addCookies([await sessionCookieFor(db, admin.id)]);
    await page.setViewportSize({ width, height: 720 });
    for (const path of ["/admin/accounts", "/admin/audit", "/admin/sync"]) {
      await page.goto(path);
      const doc = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(doc.scrollWidth, `page scroll on ${path}`).toBeLessThanOrEqual(
        doc.clientWidth,
      );
    }
  });
}

test("pinned cells keep the scroll region's tab stop and the row's focus order", async ({
  page,
  context,
}) => {
  const admin = await seedDenseWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");

  // The control before the table is the last filter link; the scroll region
  // itself must still be the very next tab stop.
  await page.getByRole("link", { name: "active", exact: true }).focus();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
  ).toBe("Members");

  // Ten stops covers the four header sort links plus the first two rows: the
  // tier, cryo and note controls all sit inside each row's closed drawer, so a
  // collapsed row offers only its name toggle and its Actions cell.
  const order: string[] = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    order.push(
      await page.evaluate(() =>
        (document.activeElement?.textContent ?? "").trim().split("\n")[0].trim(),
      ),
    );
  }

  // Read from the live DOM rather than hard-coded, so a column added later
  // can't look like a focus-order regression: this fails only if keyboard Tab
  // stops disagree with source order, which is what sticky positioning must
  // never do.
  const expected = await page.evaluate(() => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    // Two scopings, both needed. `.log--dense >` keeps this to the outer
    // table: each drawer holds a crew table of its own, so a bare `tbody > tr`
    // would make the first two matches row 1 and one of *its* crew rows rather
    // than the first two accounts. `:not(.drawer-row)` drops the drawer `<tr>`
    // that follows every data row, whose lone colSpan cell is both first and
    // last child and would pull the drawer's controls in via `td:last-child`.
    const rows = [
      ...sc.querySelectorAll(".log--dense > tbody > tr:not(.drawer-row)"),
    ].slice(0, 2) as HTMLElement[];
    const els = [
      ...sc.querySelectorAll<HTMLElement>(".log--dense > thead a"),
      ...rows.flatMap((tr) => [
        ...tr.querySelectorAll<HTMLElement>(
          "td:first-child .row-toggle, td:last-child button",
        ),
      ]),
    ];
    return els.map((el) => (el.textContent ?? "").trim().split("\n")[0].trim());
  });
  expect(
    order,
    "keyboard focus order followed DOM order — sticky positioning must not reorder tab stops",
  ).toEqual(expected);

  // A relative check on top of the DOM-order one: within a row, the name
  // toggle is reached before that row's own controls, not merely "somewhere in
  // the same DOM order" by coincidence.
  const nameIdx = order.indexOf("Aaa Boss");
  const controlIdx = order.findIndex((t) => t === "revoke" || t === "sync now");
  expect(nameIdx, "the first row's name toggle is a tab stop").toBeGreaterThanOrEqual(0);
  expect(
    controlIdx,
    "the first row's name toggle is reached before its own controls",
  ).toBeGreaterThan(nameIdx);
});

/**
 * WCAG 2.2 2.4.11, Focus Not Obscured. The accounts table pins its header row
 * inside a height-capped scroll region, so the sticky layer paints over the top
 * of the scrollport an element is scrolled into. Without a `scroll-margin` on
 * the *target*, a scroll that aligns the target to the nearest edge parks it
 * exactly flush with the scrollport edge — which is underneath the header — and
 * the focus ring is rendered where nothing can see it.
 *
 * Asserting rects rather than the CSS property: `scroll-margin-top: 2.5rem` in
 * the stylesheet proves the declaration exists, not that the engine applies it.
 * That gap is the whole risk here, and it turned out to be wider than expected
 * — see the note on the scroll trigger inside.
 */
test("a control scrolled to the top of the pinned region stays clear of the header", async ({
  page,
  context,
}) => {
  const admin = await seedDenseWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/admin/accounts");

  // Everything below happens inside one `evaluate`, and the rects are read
  // with getBoundingClientRect rather than with Playwright's boundingBox().
  // boundingBox() scrolls the element into view itself, centring it in the
  // region — so a draft that scrolled through the locator API and then measured
  // through it was reading Playwright's scroll, not the browser's, and passed
  // with the CSS property deleted.
  //
  // The trigger is `scrollIntoView({block: "nearest"})` and not `focus()`,
  // which is what this rule is really about, because Chromium's programmatic
  // focus scroll *centres* an off-screen element: measured, focusing this
  // toggle from above the fold lands it at y=675 in a region whose header ends
  // at 436, with or without the scroll-margin. Nearest-edge alignment is the
  // one scroll-margin governs, it is what the engines that don't centre use for
  // sequential focus navigation, and it is the only alignment under which this
  // control can be obscured at all. Measured against a header ending at 436px:
  // 402 with the rule deleted, and clear of it with the rule in place. The
  // assertion is rect-vs-rect rather than a pixel figure, so the shared
  // scroll-margin can be widened for the taller audit header (it has been,
  // to 3rem) without this test having to be re-tuned.
  const ROW = 12;
  const geom = await page.evaluate((row) => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    const rows = sc.querySelectorAll(".log--dense > tbody > tr:not(.drawer-row)");
    const tr = rows[row] as HTMLElement | undefined;
    const toggle = tr?.querySelector("td:first-child .row-toggle") as HTMLElement | null;
    const th = sc.querySelector<HTMLElement>(".log--dense > thead th");
    if (!tr || !toggle || !th) return null;

    // One short scroll past the row, so revealing it scrolls *up* by less than
    // a screenful. From the very bottom the browser would instead run the
    // region back to 0, landing the row naturally below the header — clear of
    // it for a reason that has nothing to do with scroll-margin.
    sc.scrollTop = tr.offsetTop + tr.offsetHeight + 40;
    const scrolled = sc.scrollTop > 0 && sc.scrollTop >= tr.offsetTop;
    const before = toggle.getBoundingClientRect().top;
    const headTop = th.getBoundingClientRect().top;

    toggle.scrollIntoView({ block: "nearest" });
    // After the scroll, not before: focusing an off-screen element centres it
    // in Chromium, which would make the alignment above a no-op. On an element
    // already in view, focus() scrolls nothing.
    toggle.focus();

    const head = th.getBoundingClientRect();
    return {
      scrolled,
      startedAbove: before < headTop,
      focused: document.activeElement === toggle,
      controlTop: toggle.getBoundingClientRect().top,
      headBottom: head.bottom,
    };
  }, ROW);

  expect(
    geom,
    "the dense table, its header and row 12's toggle all resolved",
  ).not.toBeNull();
  // Three guards. Without them the assertion passes when the region never
  // scrolled, when the target was on screen all along so nothing moved, or when
  // the control was never focusable in the first place — the first two are how
  // the earlier drafts of this test went green against CSS without the fix.
  expect(
    geom!.scrolled,
    "the region scrolled far enough to put the target above it",
  ).toBe(true);
  expect(geom!.startedAbove, "the target starts above the sticky header").toBe(true);
  expect(geom!.focused, "the row toggle actually took focus").toBe(true);

  expect(
    geom!.controlTop,
    "the focused control's top edge is below the sticky header's bottom edge",
  ).toBeGreaterThanOrEqual(geom!.headBottom);
});

/**
 * This used to be "an open row drawer unpins the first column at 320px", and
 * the rule it guarded is gone. The drawer used to live inside the name cell,
 * and its crew group is `flex: 1 1 100%`, so opening one row widened column 1
 * for the whole table (columns are shared) until the pinned cell took 98% of
 * the region and painted over every other column. Unpinning was the least-bad
 * trade available.
 *
 * The drawer is its own full-width `<tr>` now, so it cannot touch column 1's
 * width and the trade is off. Re-measured at 320px on the current DOM, region
 * 286px: the pinned cell is 97px — 34% of the region — and identical open and
 * closed, where the rule this replaced was written against 279.5px/98%. The
 * pin costs the drawer nothing, because the drawer is in another row: measured
 * across the full scroll range, no drawer control has any of its area under a
 * pinned cell, including at the offsets where it shares the pin's x-band.
 *
 * The assertions are inverted rather than deleted: the pin surviving an open
 * drawer is the better end of that trade — the name stays on screen through
 * exactly the scroll the drawer's own controls make necessary — and it is worth
 * a test saying so, because the way to lose it again is for the drawer to drift
 * back inside the first cell.
 */
test("an open row drawer keeps the pin, and is not itself pinned", async ({
  page,
  context,
}) => {
  const admin = await seedDenseWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");

  const first = page.locator(ROWS).first();
  // Closed first: what the pin costs the region with no drawer open is the
  // baseline the rule this test replaced was measured against, and the whole
  // reason that rule is gone is that opening a drawer no longer moves it.
  const closed = await pinGeometry(
    page,
    ".scroller",
    `${ROWS}:first-child > td:first-child`,
    "right",
  );

  await toggleOf(first).click();
  await expect(drawerOf(first)).toBeVisible();

  const open = await pinGeometry(
    page,
    ".scroller",
    `${ROWS}:first-child > td:first-child`,
    "right",
  );
  // There has to be something to scroll past, or the geometry below is vacuous.
  expect(open.maxScrollLeft).toBeGreaterThan(0);

  // The old rule existed because opening a drawer widened column 1 for the
  // whole table. That coupling is what the drawer's own `<tr>` broke, and it is
  // the fact the rule's absence rests on — so assert the width, not the CSS.
  expect(open.cellWidth, "an open drawer does not widen column 1").toBeCloseTo(
    closed.cellWidth,
    1,
  );
  // 97px of a 286px region as measured; the rule this replaced was written
  // against 279.5px of 286px, which is what made unpinning the better trade.
  expect(
    open.cellWidth / open.regionWidth,
    "the pin leaves most of the region to the other columns",
  ).toBeLessThan(0.5);

  // The claim is the footprint, not the computed value: scrolled fully right,
  // the name is still wholly on screen.
  expect(open.position, "the body's first column stays pinned").toBe("sticky");
  expect(open.overlapX).toBeCloseTo(open.cellWidth, 0);
  expect(open.text).toContain("Aaa Boss");

  // The header's corner cell rides with the column it heads, open drawer or
  // not; left behind, the pinned names sit under whichever heading the scroll
  // stopped on.
  const corner = await pinGeometry(page, ".scroller", "thead th:first-child", "right");
  expect(corner.overlapX).toBeCloseTo(corner.cellWidth, 0);
  expect(corner.text).toContain("Name");

  // ...and the controls that made the scroll necessary are clear of the pinned
  // cell at the same time. That pairing is the whole point of the pin.
  const clear = await clearOfPin(
    page,
    ".scroller",
    `${ROWS}:first-child > td:last-child form:last-child button`,
  );
  expect(clear, "sync now is not under the pinned column").toBeCloseTo(1, 5);

  // The drawer's own cell is a colSpan across the whole table, so it matches
  // `td:first-child` and would be pinned by the same rule — a full-width cell
  // with an opaque ground and a hairline hanging off the table's right edge,
  // which is the exact bug the empty-state row was excluded for.
  // `./td` and not `td`: a descendant match would also pull in the crew
  // table's cells, which are not the drawer's own colSpan cell.
  const drawerCell = await drawerOf(first)
    .locator("xpath=./td")
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      return { position: cs.position, borderRight: cs.borderRightWidth };
    });
  expect(drawerCell.position).toBe("static");
  expect(drawerCell.borderRight).toBe("0px");

  // Not sticky is not the same as not painted over: the pinned cells above and
  // below the drawer row are opaque and outrank it, so "the drawer scrolls
  // freely underneath" has to be measured against them, not inferred from the
  // drawer's own `position`. Three offsets — at rest, mid-scroll, and fully
  // right — because the drawer's controls pass through the pin's x-band on the
  // way, and that is the only span where a regression could show.
  const tier = ".drawer-row:not([hidden]) .drawer__controls button";
  for (const at of [0, Math.round(open.maxScrollLeft / 4), open.maxScrollLeft]) {
    const m = await coveredByPin(page, ".scroller", tier, at);
    expect(m.covered, `no pinned cell paints over the drawer at scrollLeft ${at}`).toBe(
      0,
    );
  }
  // ...and that zero is a real result, not one offset that happened to miss:
  // at rest the first tier button sits squarely inside the pin's x-band and on
  // screen, so an x-only measure — `clearOfPin` — would call it fully occluded.
  const rest = await coveredByPin(page, ".scroller", tier, 0);
  expect(rest.xOverlap, "the drawer's first control shares the pin's x-band").toBeCloseTo(
    1,
    1,
  );
  expect(rest.inRegion, "...and is on screen while it does").toBeCloseTo(1, 1);
});

/**
 * The width claim, stated directly — the reason the drawer moved out of the
 * name cell at all.
 *
 * Table columns are shared, so anything rendered inside the name cell sets a
 * min-content width for column 1 on *every* row. The drawer's crew group is
 * `flex: 1 1 100%`, so while the drawer lived in that cell, opening one row
 * widened column 1 for the whole table until the pinned cell took 279.5px of a
 * 286px region — 98%, the figure recorded at globals.css's tombstone for the
 * rule that used to unpin column 1 to compensate.
 *
 * The test above cannot catch this. It asserts the pin holds, and `pinGeometry`
 * compares the cell against its own current width, so it is width-agnostic by
 * construction: a wider pinned cell is still wholly on screen and still passes.
 * `clearOfPin` notices the widening only indirectly, once a control at the far
 * right happens to fall under the pin. Neither says the thing that has to stay
 * true, so this does: opening a row must not move column 1 at all.
 *
 * The row measured is deliberately *not* the row being opened. "Opening one row
 * widens the column for every row" is the actual failure, and a neighbour's name
 * cell is where that shows.
 */
test("an open drawer does not widen the shared first column", async ({
  page,
  context,
}) => {
  const admin = await seedDenseWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");

  const first = page.locator(ROWS).first();
  // `./td[1]` and not `td`: a descendant match would reach the crew table's
  // cells inside the drawer once it is open.
  const neighbourName = page.locator(ROWS).nth(1).locator("xpath=./td[1]");
  const closed = (await neighbourName.boundingBox())!.width;

  await toggleOf(first).click();
  await expect(drawerOf(first)).toBeVisible();

  // Rules out the one genuinely vacuous case — a drawer that renders nothing,
  // against which "unchanged" would be trivially true. It is not evidence of
  // how much width the drawer's content demands: a cell spanning every column
  // is wider than any single column by table structure alone.
  const drawer = (await drawerOf(first).locator("xpath=./td").boundingBox())!.width;
  expect(drawer, "the drawer is wider than the column it left").toBeGreaterThan(closed);

  const open = (await neighbourName.boundingBox())!.width;
  // Precision 0 — within half a pixel — matching how every other width claim in
  // this file is stated. The regression this guards moves the column by hundreds
  // of pixels, so the tolerance costs nothing and keeps sub-pixel layout drift
  // from flaking it.
  expect(open, "opening one row must not widen column 1 for the others").toBeCloseTo(
    closed,
    0,
  );
});

/**
 * The drawer's controls, keyed by the aria-label each carries on Zed's row.
 * These four are the drawer's whole control surface: the tier group, the cryo
 * group, and the note field with its save button.
 */
const DRAWER_CONTROLS = {
  "set tier": '[aria-label="Set Zed to blue"]',
  freeze: '[aria-label="freeze Zed"]',
  "note field": '[aria-label="Note for Zed"]',
  "save note": '[aria-label="save note for Zed"]',
};

/**
 * The regression: the drawer is a `<tr class="drawer-row"><td colSpan={8}>`, so
 * its controls were bound to the accounts table's width rather than to what is
 * on screen. `.drawer__controls` wraps, but its flex line box was 943.8px wide
 * inside a 286px region, so wrapping never fired and `save note` sat 332px of
 * horizontal scroll off to the right — a note field with no tabular reason to
 * be anywhere but on screen. The drawer sizes itself to the scroll region now
 * (`.scroller:has(.drawer)` / `.drawer` in globals.css).
 *
 * `freeze Zed` is the load-bearing case in the pin assertions below. 83% of its
 * width sits inside the pinned column's x-band with 0% of its area covered, so
 * an x-extent-only comparison — `clearOfPin`, which is the right measure for a
 * control sharing a row with the pin — would wrongly report it 83% occluded
 * here. Only a 2-D intersection tells "under the pin" apart from "in the pin's
 * x-band, in another row's vertical band".
 */
test("accounts at 320px: an open drawer wraps to the scroll region, not to the table", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");
  await page.waitForSelector(".scroller tbody tr");

  const geometry = () =>
    page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      sc.scrollLeft = 0;
      const table = sc.querySelector("table") as HTMLElement;
      return {
        regionWidth: sc.clientWidth,
        tableWidth: table.getBoundingClientRect().width,
        maxScrollLeft: sc.scrollWidth - sc.clientWidth,
      };
    });

  // Measured closed, before the drawer exists, so the open figures below have
  // something to be unchanged against. Hard-coding the 967.8px this comes out
  // at today would fail on any future column change for a reason that has
  // nothing to do with the drawer.
  const closed = await geometry();
  // There has to be something to scroll past, or the pin assertions are vacuous.
  expect(closed.maxScrollLeft).toBeGreaterThan(0);

  const zedRow = rowFor(page, "Zed");
  await toggleOf(zedRow).click();
  await expect(drawerOf(zedRow)).toBeVisible();

  // The drawer no longer contributes to the table's width: it sizes off the
  // scrollport via a container query rather than off the cell it lives in, so
  // opening one adds no horizontal scroll at all.
  const open = await geometry();
  expect(open.tableWidth, "an open drawer does not widen the table").toBeCloseTo(
    closed.tableWidth,
    1,
  );
  expect(open.maxScrollLeft, "an open drawer adds no horizontal scroll").toBeCloseTo(
    closed.maxScrollLeft,
    1,
  );

  // Every control reachable with the region at rest: content-x plus width
  // inside the region. This is the 332px of scroll, asserted as a property
  // rather than as the numbers it currently measures.
  const reach = await page.evaluate((controls) => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    sc.scrollLeft = 0;
    const s = sc.getBoundingClientRect();
    return Object.fromEntries(
      Object.entries(controls).map(([name, sel]) => {
        const r = (sc.querySelector(sel) as HTMLElement).getBoundingClientRect();
        return [name, { contentX: r.left - s.left + sc.scrollLeft, width: r.width }];
      }),
    );
  }, DRAWER_CONTROLS);
  for (const [name, box] of Object.entries(reach)) {
    expect(
      box.contentX + box.width,
      `${name} is reachable without scrolling the region`,
    ).toBeLessThanOrEqual(open.regionWidth + 0.5);
  }

  // ...and the pin the region keeps does not pay for it: 0% of each control's
  // area is under a pinned first cell, at rest, mid-scroll and fully right.
  //
  // `covered: 0` has two ways to be true for nothing: the control could be
  // off-screen, or there could be no pinned cell to be under. `inRegion`
  // closes the first. This closes the second — `coveredByPin` sums over the
  // sticky first cells it finds, so with none found every `covered` is 0 and
  // the whole loop below would pass against a table that had lost its pin.
  const pinnedCells = await page.evaluate(() => {
    const table = document.querySelector(".scroller table") as HTMLElement;
    return Array.from(
      table.querySelectorAll(":scope > tbody > tr > td:first-child"),
    ).filter((c) => getComputedStyle(c).position === "sticky").length;
  });
  expect(
    pinnedCells,
    "there is a pin for the drawer to be measured against",
  ).toBeGreaterThan(0);

  const offsets = [0, Math.round(open.maxScrollLeft / 2), open.maxScrollLeft];
  for (const [name, sel] of Object.entries(DRAWER_CONTROLS)) {
    for (const at of offsets) {
      const m = await coveredByPin(page, ".scroller", sel, at);
      expect(m.covered, `${name} is not under the pin at scrollLeft ${at}`).toBe(0);
      expect(m.inRegion, `${name} is on screen at scrollLeft ${at}`).toBeCloseTo(1, 2);
    }
  }
});

test("the start fade never paints over the pinned column", async ({ page, context }) => {
  const admin = await seedDenseWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");

  // Scrolled off the left edge but not yet at the right one: the only state in
  // which both fades claim to be needed, so the start fade's suppression can be
  // told apart from it simply being at rest. Driving fully right would hide the
  // end fade too, correctly, and prove nothing about the start.
  const read = async () => {
    await page.evaluate(() => {
      const sc = document.querySelector(".scroller:has(> .log--dense)") as HTMLElement;
      sc.scrollLeft = Math.max(1, Math.floor((sc.scrollWidth - sc.clientWidth) / 2));
    });
    // The fade's `data-visible` comes from React state set in an onScroll
    // handler, so it is a render behind the scroll. Waiting on the attribute
    // rather than measuring in the same tick is what makes this deterministic;
    // it is not a proxy for the rule under test, whose effect is `display`.
    // Scoped to the accounts frame's own fades. Each drawer holds a crew
    // Scroller with a fade pair of its own, and those sit *inside* the outer
    // scroller — so they precede the outer frame's fades in document order and
    // a bare `.scroller-fade--end` reads a crew table's edge state instead of
    // this one's.
    await page.waitForSelector(
      ".scroller-frame:has(> .scroller > .log--dense) > .scroller-fade--start[data-visible]",
      { state: "attached" },
    );
    return page.evaluate(() => {
      const frame = document.querySelector(
        ".scroller-frame:has(> .scroller > .log--dense)",
      ) as HTMLElement;
      const sc = frame.querySelector(":scope > .scroller") as HTMLElement;
      const q = (sel: string) => frame.querySelector(`:scope > ${sel}`) as HTMLElement;
      const start = q(".scroller-fade--start");
      // Spelled out rather than interpolated from ROWS: this function is
      // serialized and run in the browser, where the module's consts do not
      // exist.
      const pin = sc.querySelector(
        ".log--dense > tbody > tr:not(.drawer-row):first-child > td:first-child",
      )!;
      const p = pin.getBoundingClientRect();
      return {
        maxScrollLeft: sc.scrollWidth - sc.clientWidth,
        display: getComputedStyle(start).display,
        endShown: q(".scroller-fade--end").hasAttribute("data-visible"),
        // How far the first cell has slid past the region's left edge. This is
        // the fact the start fade is a cue *for*: zero means nothing is hidden
        // that way and the cue would be a lie.
        pinOffLeft: sc.getBoundingClientRect().left - p.left,
      };
    });
  };

  const pinned = await read();
  expect(pinned.maxScrollLeft, "there is something to scroll past").toBeGreaterThan(0);
  // With column 1 pinned, nothing is hidden past the left edge, and 1.5rem of
  // gradient would land on the name an admin is about to act on.
  expect(pinned.display, "the start fade is suppressed while the column is pinned").toBe(
    "none",
  );
  expect(pinned.endShown, "the end fade still says the table scrolls right").toBe(true);
  // ...and the reason it is a lie: the pinned cell has not moved off the edge.
  expect(
    pinned.pinOffLeft,
    "nothing is hidden past the left edge while the column is pinned",
  ).toBeLessThan(1);

  // The suppression is now unconditional for this table — the drawer used to
  // unpin column 1, which made the cue true again, and it no longer does (see
  // the test above). That is not a lie in the other direction: the reason the
  // cue would be false is that the pin holds the first cell at the left edge,
  // and the pin now always holds. Re-asserting it with a drawer open is what
  // says so, since an open drawer is the one state that used to flip it.
  await toggleOf(page.locator(ROWS).first()).click();
  await expect(drawerOf(page.locator(ROWS).first())).toBeVisible();
  const withDrawer = await read();
  expect(withDrawer.display, "an open drawer does not bring the fade back").toBe("none");
  expect(
    withDrawer.pinOffLeft,
    "because the pin still holds the first cell at the left edge",
  ).toBeLessThan(1);
});

test("the empty-state row does not inherit the pinned column", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts?status=cryo");

  const empty = page.locator("td.log__empty");
  await expect(empty).toHaveText("No members match this filter.");
  // It spans the whole table, so pinning it would give a full-width cell an
  // opaque ground and a hairline hanging off the table's right edge.
  const style = await empty.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { position: cs.position, borderRight: cs.borderRightWidth };
  });
  expect(style.position).toBe("static");
  expect(style.borderRight).toBe("0px");
});

/* --- Row identity -------------------------------------------------------- */

test("an account with no main is still identified in the pinned column", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Aaa Boss", tier: "flygd", isAdmin: true });
  // Characters linked, no main set: the row the fallback exists for. The row
  // data carries no link order, so the page picks the alphabetically first
  // name — "Sam Alt", not the seed's own first argument.
  await seedMember(db, { name: "Wandering Sam", mainless: true, alts: ["Sam Alt"] });
  // And an account with nothing linked at all, which only the id can name.
  const [orphan] = await db.insert(account).values({ tier: "green" }).returning();

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");

  const toggles = page.locator(`${ROWS} > td:first-child .row-toggle`);
  await expect(toggles).toHaveCount(3);
  // The service sorts main-less accounts last but leaves them tied with each
  // other, so assert per row rather than on an order the data does not fix.
  const samRow = rowFor(page, "Sam Alt");
  // Visible text: the character name plus a marker, not a bare "no main" that
  // every such row would share.
  await expect(toggleOf(samRow)).toHaveText(/^Sam Alt ·no main \(\+1\)$/);
  // Accessible name: Disclosure's row shape puts the label in aria-label, which
  // overrides the visible text for a screen reader, so the character name has
  // to survive there too rather than being spoken as a bare "no main".
  // Anchored on the full visible string, not a prefix: a prefix regex passes
  // whether or not the "(+1)" count survives into the name, which is exactly
  // the WCAG 2.5.3 gap it is supposed to be guarding.
  await expect(toggleOf(samRow)).toHaveAccessibleName(
    /^Sam Alt ·no main \(\+1\) — crew and controls$/,
  );
  await expect(rowFor(page, `acct ${orphan.id.slice(0, 8)}`)).toHaveCount(1);
  // The old fallback was a bare <em>no main</em>, identical on every such row.
  await expect(page.locator(`${ROWS} em`)).toHaveCount(0);
  // Controls inside the row have to name it too — the note field announced as
  // "Note for account" on every main-less account.
  //
  // `exact`, here and at every other `Note for` below: getByLabel matches on a
  // substring, and the save button beside this field is named "save note for
  // <identity>", which contains the field's whole name. Without it these count
  // the pair and the assertion says nothing about the field.
  await expect(page.getByLabel("Note for Sam Alt", { exact: true })).toHaveCount(1);
  await expect(
    page.getByLabel(`Note for acct ${orphan.id.slice(0, 8)}`, { exact: true }),
  ).toHaveCount(1);

  // ...and the identity survives the scroll that made the pin necessary in the
  // first place: the tier controls are unreachable without it.
  const pinned = await page.evaluate(() => {
    const sc = document.querySelector(".scroller") as HTMLElement;
    sc.scrollLeft = sc.scrollWidth;
    // Data rows only: the drawer holds a crew table whose rows carry the same
    // character names, and its first cell is a full-width colSpan that is not
    // the pinned column.
    const row = [
      ...sc.querySelectorAll(".log--dense > tbody > tr:not(.drawer-row)"),
    ].find((tr) => (tr.textContent ?? "").includes("Sam Alt")) as HTMLElement;
    const cell = row.querySelector("td:first-child") as HTMLElement;
    const c = cell.getBoundingClientRect();
    const s = sc.getBoundingClientRect();
    return {
      text: cell.textContent ?? "",
      cellWidth: c.width,
      overlapX: Math.min(c.right, s.right) - Math.max(c.left, s.left),
      maxScrollLeft: sc.scrollWidth - sc.clientWidth,
    };
  });
  expect(pinned.maxScrollLeft).toBeGreaterThan(0);
  expect(pinned.overlapX).toBeCloseTo(pinned.cellWidth, 0);
  expect(pinned.text).toContain("Sam Alt");
});

test("a blank character name never becomes a row's identity", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Aaa Boss", tier: "flygd", isAdmin: true });
  // ESI has handed back an empty name before. `??` only falls through on
  // null/undefined, so an empty main produced `aria-label="Note for "` and a
  // row toggle announced as " — crew and controls" — no identity at all, in
  // the column whose whole job is saying whose tier is about to change.
  const blank = await seedMember(db, { name: "" });
  // And one whose alphabetically-first character name is blank: "" sorts ahead
  // of everything, so an unfiltered pick would name the row nothing even though
  // a perfectly good name is sitting next to it.
  await seedMember(db, { name: "", mainless: true, alts: ["Real Name"] });
  // Whitespace is the shape that survived the first fix: `||` catches "" but
  // "   " is truthy, so a padded name took the identity slot and then rendered
  // as nothing — a pinned cell that is blank and an aria-label of "Note for   ".
  const spaces = await seedMember(db, { name: "   " });
  await seedMember(db, { name: " \t ", mainless: true, alts: ["Spaced Alt"] });

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  // No row is announced as an empty string or as a bare separator.
  const summaries = page.locator(`${ROWS} > td:first-child .row-toggle`);
  const labels = await summaries.evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label") ?? ""),
  );
  expect(labels).toHaveLength(5);
  for (const l of labels) expect(l).not.toMatch(/^\s*—/);

  // Falls through to the non-blank character, not to "". The "·no main" marker
  // still applies: the row is named by a character that is not its main. The
  // "(+1)" is the blank-named sibling being counted, and it has to be in the
  // accessible name too — it is in the visible label (WCAG 2.5.3).
  await expect(page.getByLabel("Note for Real Name", { exact: true })).toHaveCount(1);
  await expect(summaries.filter({ hasText: "Real Name" })).toHaveAccessibleName(
    /^Real Name ·no main \(\+1\) — crew and controls$/,
  );

  // Nothing non-blank to borrow, so the account id has to be used, not skipped.
  const id = `acct ${blank.id.slice(0, 8)}`;
  await expect(page.getByLabel(`Note for ${id}`, { exact: true })).toHaveCount(1);
  await expect(summaries.filter({ hasText: id })).toHaveAccessibleName(
    new RegExp(`^${id} —`),
  );

  // The same two outcomes for the whitespace shape: a padded main is not a
  // name, so the row borrows its alt and is marked as having no main...
  await expect(page.getByLabel("Note for Spaced Alt", { exact: true })).toHaveCount(1);
  await expect(summaries.filter({ hasText: "Spaced Alt" })).toHaveAccessibleName(
    /^Spaced Alt ·no main \(\+1\) — crew and controls$/,
  );
  // ...and with nothing to borrow it falls all the way to the account id rather
  // than pinning a cell that looks empty.
  const spacedId = `acct ${spaces.id.slice(0, 8)}`;
  await expect(page.getByLabel(`Note for ${spacedId}`, { exact: true })).toHaveCount(1);
  await expect(summaries.filter({ hasText: spacedId })).toHaveAccessibleName(
    new RegExp(`^${spacedId} —`),
  );
});

test("every per-account control names the row it acts on", async ({ page, context }) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  // The pinned column exists so a 28px control is never pressed with nothing on
  // screen saying whose it is; a speech-input or screen-reader user never sees
  // that column, and reached these with only the tier word to go on. The
  // visible text stays the bare word, so the accessible name has to keep it
  // verbatim (WCAG 2.5.3) and add the row in front of it.
  const zedRow = rowFor(page, "Zed");
  const zedDrawer = drawerOf(zedRow);
  await toggleOf(zedRow).click();
  for (const tier of ["flygd", "blue", "green"]) {
    const btn = zedDrawer.getByRole("button", {
      name: `Set Zed to ${tier}`,
      exact: true,
    });
    await expect(btn).toHaveCount(1);
    await expect(btn).toHaveText(tier);
  }
  const cryo = zedDrawer.getByRole("button", { name: "freeze Zed", exact: true });
  await expect(cryo).toHaveText("freeze");

  // The lock-releasing control is in the same group and had the same gap.
  await zedDrawer.getByRole("button", { name: "Set Zed to blue", exact: true }).click();
  await expect(zedRow.locator(".tier__lock")).toBeVisible();
  await expect(
    zedDrawer.getByRole("button", { name: "return Zed to auto tier", exact: true }),
  ).toHaveText("auto");

  // Cryo's label follows the action, not the state.
  const azzyRow = rowFor(page, "Azzy");
  await toggleOf(azzyRow).click();
  await expect(
    drawerOf(azzyRow).getByRole("button", { name: "wake Azzy", exact: true }),
  ).toHaveText("wake");

  // The rest of the page's per-account controls, swept: the drawer's were named
  // first and the row's were not, which left three of them — grant, sync now,
  // save note — bare on a table with one row per account. Nothing about those
  // three makes them less anonymous out of their row than "freeze" was.
  const named: [Locator, string, string][] = [
    [zedRow, "grant admin to Zed", "grant"],
    [zedRow, "sync now for Zed", "sync now"],
    [zedDrawer, "save note for Zed", "save note"],
    [rowFor(page, "Boss"), "revoke admin for Boss", "revoke"],
  ];
  for (const [scope, name, visible] of named) {
    const btn = scope.getByRole("button", { name, exact: true });
    await expect(btn).toHaveCount(1);
    // The visible word has to survive inside the accessible name, or speech
    // input loses the control it can actually see (WCAG 2.5.3).
    await expect(btn).toHaveText(visible);
    expect(name.startsWith(visible), `"${name}" leads with "${visible}"`).toBe(true);
  }
});

/* --- Confirm-before-destroy ---------------------------------------------- */

test("revoke arms on the first click, confirms on the second, and Escape disarms", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  // A second admin so revoking it doesn't hit the "last admin" guard — this
  // test is about the confirm mechanism, not that error path.
  const zed = await seedMember(db, { name: "Zed", tier: "flygd", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  const zedRow = rowFor(page, "Zed");
  // Named for the row it acts on, like the tier and cryo controls: the bare
  // word "revoke" is the same on every row, and this is the control the pinned
  // column exists to keep the object of visible for.
  const revoke = zedRow.getByRole("button", {
    name: "revoke admin for Zed",
    exact: true,
  });
  const restBox = await revoke.boundingBox();

  async function zedIsAdmin() {
    const [row] = await db.select().from(account).where(eq(account.id, zed.id));
    return row?.isAdmin ?? false;
  }

  // A server action is a POST to the current route. Counting them is the only
  // assertion that actually proves the first click never reached the server —
  // "no grant button yet" would also pass in the window before an in-flight
  // revoke came back and re-rendered without it.
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST") posts += 1;
  });

  await revoke.click();
  const confirm = zedRow.getByRole("button", { name: /^confirm revoke/ });
  await expect(confirm).toBeVisible();
  expect(posts).toBe(0);

  // The label swap alone must not jitter the row.
  const armedBox = await confirm.boundingBox();
  expect(armedBox?.width).toBe(restBox?.width);

  // Escape disarms without a reload.
  await confirm.press("Escape");
  await expect(revoke).toBeVisible();
  await expect(zedRow.getByRole("button", { name: /^confirm revoke/ })).toHaveCount(0);
  expect(posts).toBe(0);
  // The account's admin flag genuinely never moved, read from the database
  // rather than from the page that would be rendering it.
  expect(await zedIsAdmin()).toBe(true);

  // Arm again and confirm: the second click is the one that actually revokes.
  await revoke.click();
  await zedRow.getByRole("button", { name: /^confirm revoke/ }).click();
  await expect(zedRow.getByRole("button", { name: /^grant/ })).toBeVisible();
  await expect.poll(zedIsAdmin).toBe(false);
});

test("freeze arms on the first click, confirms on the second, and Escape disarms", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  const zedRow = rowFor(page, "Zed");
  const zedDrawer = drawerOf(zedRow);
  await toggleOf(zedRow).click();
  await expect(zedDrawer).toBeVisible();

  const freeze = zedDrawer.getByRole("button", { name: "freeze Zed", exact: true });
  const restBox = await freeze.boundingBox();

  // First click arms. It must not reach the server: the row still reads
  // active, not cryo.
  await freeze.click();
  const confirm = zedDrawer.getByRole("button", { name: /^confirm freeze/ });
  await expect(confirm).toBeVisible();
  await expect(zedRow.getByText("cryo")).toHaveCount(0);

  // The label swap alone must not jitter the row.
  const armedBox = await confirm.boundingBox();
  expect(armedBox?.width).toBe(restBox?.width);

  // Escape disarms without a reload.
  await confirm.press("Escape");
  await expect(freeze).toBeVisible();
  await expect(zedDrawer.getByRole("button", { name: /^confirm freeze/ })).toHaveCount(0);

  // Arm again and confirm: the second click is the one that actually freezes.
  await freeze.click();
  await zedDrawer.getByRole("button", { name: /^confirm freeze/ }).click();
  await expect(zedRow.getByText("cryo")).toBeVisible();
});

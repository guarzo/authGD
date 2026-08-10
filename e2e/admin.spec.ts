import { expect, test, type Locator, type Page } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import {
  account,
  character,
  contactSyncState,
  discordLink,
  wandererAclObservation,
} from "../src/db/schema";
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

/**
 * Open every data row's drawer.
 *
 * A drawer's children are mounted on its first open and kept from then on
 * (`everOpen` in disclosure.tsx) rather than shipped closed on every row, so a
 * control inside one does not exist in the DOM until its row has been expanded
 * at least once. Tests that assert on a per-row control's accessible name —
 * rather than on the opening itself — go through this.
 */
async function openEveryDrawer(page: Page) {
  const toggles = page.locator(`${ROWS} > td:first-child .row-toggle`);
  const n = await toggles.count();
  for (let i = 0; i < n; i++) await toggles.nth(i).click();
}

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

async function seedWorld() {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await seedMember(db, { name: "Azzy", tier: "alumni", status: "cryo" });
  await seedMember(db, { name: "Zed", tier: "member" });
  return admin;
}

/** Enough rows that the accounts table overflows the capped scroll region. */
async function seedDenseWorld() {
  const admin = await seedMember(db, { name: "Aaa Boss", tier: "member", isAdmin: true });
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
      name: "Sync now",
    }),
  ).toBeVisible();

  await db.update(account).set({ isAdmin: false }).where(eq(account.id, admin.id));

  await page.getByRole("button", { name: "Sync now" }).click();
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
  await expect(mains.first()).toHaveText(/Boss|Zed/); // member ranks first
  await page.goto("/admin/accounts?status=cryo");
  await expect(mains).toHaveText(["Azzy"]);
});

/**
 * The roster's own "find one member" answer (see view.ts's
 * `matchesAccountSearch`): a GET form submitting `?q=`, exercised end to end
 * because a redirect/navigation and the resulting accessible-name and
 * heading-count behavior are exactly the things a unit test over the pure
 * predicate cannot see.
 */
test("a name search finds the member, works from the keyboard, and reports the count", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  // Heading-based count, the same mechanism /admin/audit already uses for its
  // own row count — no aria-live region exists anywhere in this codebase's
  // filtering flows, so this is the one place a screen-reader admin can learn
  // how many rows a search left them with.
  await expect(page.getByRole("heading", { name: "3 members" })).toBeVisible();

  // Keyboard only: no pointer click on the input or the button below.
  const search = page.getByRole("searchbox", { name: "Name or handle" });
  await search.focus();
  await search.fill("zed");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/[?&]q=zed(&|$)/);
  await expect(page.locator(ROWS)).toHaveCount(1);
  await expect(rowFor(page, "Zed")).toBeVisible();
  // The count in the heading moved with the filtered list, not just the rows.
  await expect(page.getByRole("heading", { name: "1 member" })).toBeVisible();
  // The value the admin typed is still in the box after the round trip, same
  // as every other filter chip's active state surviving a reload.
  await expect(search).toHaveValue("zed");
});

/**
 * The known trap this test is written to avoid: the empty state is one `<tr>`
 * whether the roster itself is empty or a filter merely matched nothing, so a
 * bare `toHaveCount(0)` (or `toHaveCount(1)` on the wrong locator) would pass
 * either way. The two states render different text (page.tsx), and that text
 * is what this asserts — a search that matches nobody must say so, distinctly
 * from "no accounts exist at all".
 */
test("a search with no matches says so, distinctly from an empty roster", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts?q=nobody-by-this-name");

  // ROWS itself is not the right locator here: the empty-state `<tr>` is not
  // `.drawer-row`, so it matches ROWS too and a bare `toHaveCount(0)` on it
  // would fail whether or not the search actually ran — the exact trap this
  // test exists to avoid. None of the seeded names are on screen, and the
  // cell says why.
  await expect(rowFor(page, "Boss")).toHaveCount(0);
  await expect(rowFor(page, "Azzy")).toHaveCount(0);
  await expect(rowFor(page, "Zed")).toHaveCount(0);
  await expect(page.locator("td.log__empty")).toHaveText("No members match this filter.");
  // Distinct from the truly-empty-roster message, which this filtered search
  // must never render even though both are rendered by the same `<td>`.
  await expect(page.locator("td.log__empty")).not.toHaveText(
    "No accounts yet. They appear here after someone signs in with EVE.",
  );
});

/*
 * Next hands a page `string | string[]` for every search param, and a repeated
 * one is not exotic: appending `&q=Zed` to a URL that already carries a `q` is
 * how a shared link picks up a second value. The page declared `q?: string`,
 * so the array reached `.trim()` and the whole roster came back as a 500 —
 * an admin loses the screen entirely over a malformed link. Last value wins,
 * matching `/admin/audit`'s filters.
 */
test("a repeated q parameter renders rather than throwing", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await seedMember(db, { name: "Azzy", tier: "member" });
  await seedMember(db, { name: "Zed", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/admin/accounts?q=Azzy&q=Zed");
  await expect(page.getByText("Something broke")).toHaveCount(0);
  await expect(page.locator(ROWS)).toHaveCount(1);
  await expect(rowFor(page, "Zed")).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Name or handle" })).toHaveValue(
    "Zed",
  );
});

/** An alt's name, not just the main's, is a handle an admin searches by — the
 *  roster's own crew table shows alts by name and nothing else. */
test("a search also matches an alt's name, not only the main", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await seedMember(db, { name: "Zed", tier: "member", alts: ["Zed Alt"] });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/admin/accounts?q=Zed+Alt");
  await expect(page.locator(ROWS)).toHaveCount(1);
  // The row is still identified by its main, "Zed" — the alt matched the
  // search, but it is not what names the row.
  await expect(rowFor(page, "Zed")).toBeVisible();
});

/**
 * Searching must not reset the choices an admin already made narrowing the
 * roster — the hidden fields in the search form (page.tsx) carry tier/status/
 * sort/dir through the GET submission for exactly this.
 */
test("a search preserves an active status filter across the submission", async ({
  page,
  context,
}) => {
  await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await seedMember(db, { name: "Azzy", tier: "alumni", status: "cryo" });
  await seedMember(db, { name: "Zed Cryo", tier: "member", status: "cryo" });
  const admin = await seedMember(db, { name: "Admin", tier: "member", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/admin/accounts?status=cryo");
  await expect(page.locator(ROWS)).toHaveCount(2);

  const search = page.getByRole("searchbox", { name: "Name or handle" });
  await search.fill("zed");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/[?&]status=cryo(&|$)/);
  await expect(page).toHaveURL(/[?&]q=zed(&|$)/);
  await expect(page.locator(ROWS)).toHaveCount(1);
  await expect(rowFor(page, "Zed Cryo")).toBeVisible();
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
  await expect(zedRow.locator("td:nth-child(2) .tier")).toHaveText(/Testers/);
  // The tier controls name their row in their accessible name, so match on that
  // rather than on the visible word alone — `name: "Friends"` now matches nothing
  // at all, and toBeHidden() is satisfied by an element that does not exist.
  //
  // Scoped to the drawer rather than the row: the drawer is the row's sibling
  // now, so a control inside it is not a descendant of the collapsed row and
  // `zedRow.getByRole(...)` would find nothing whether the rule holds or not.
  await expect(
    drawerOf(zedRow).getByRole("button", { name: "Set Zed to Friends" }),
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

/**
 * "Why is this person's role wrong?" is the question PRODUCT.md gives the audit
 * log a minute to answer, and the nav item was the only way in — so the answer
 * started by retyping a name from memory into a filter.
 *
 * Filtered by NAME rather than by account id on purpose: `resolveFilterIdentity`
 * (services/audit.ts) expands a name into the account, its characters AND its
 * discord id, which are the three identifier forms one person's target rows are
 * spread across. A uuid is `kind: "raw"` and matches only the account's own
 * rows.
 */
test("each row links into the audit log filtered to that account", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  const zedRow = rowFor(page, "Zed");
  await toggleOf(zedRow).click();
  const link = drawerOf(zedRow).getByRole("link", { name: "audit log for Zed" });
  // Visible text leads the accessible name, so speech input reaches it by what
  // is written on it (WCAG 2.5.3).
  await expect(link).toHaveText("audit log");
  await expect(link).toHaveAttribute("href", "/admin/audit?target=Zed");

  await link.click();
  await expect(page).toHaveURL(/\/admin\/audit\?target=Zed/);
  // The destination understood the filter rather than merely receiving it.
  await expect(page.locator("input[name='target']")).toHaveValue("Zed");
});

/**
 * Four of the ten headers sort and six do not, and at rest they were
 * pixel-identical — the hover colour was the only thing that ever said so, and
 * a keyboard or touch user never sees it before committing to a click. The
 * glyph is aria-hidden because `aria-sort` on the `<th>` already carries the
 * state, so it must not reach any accessible name.
 */
test("sortable headers say so at rest, without changing their accessible names", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  const sortable = page.locator(".log--dense thead th:has(a)");
  await expect(sortable).toHaveCount(4);
  // Name is the active sort, so it shows a direction arrow; the other three
  // show the inactive hint.
  await expect(page.locator(".log--dense thead .log__sortable")).toHaveCount(3);
  await expect(
    page.locator(".log--dense thead th:not(:has(a)) .log__sortable"),
  ).toHaveCount(0);

  await expect(
    page.getByRole("columnheader", { name: "Name", exact: true }),
  ).toHaveAttribute("aria-sort", "ascending");
  // The glyph is inside the link, so an accessible name that had picked it up
  // would read "Tier ↕" here.
  await expect(page.getByRole("link", { name: "Tier", exact: true })).toBeVisible();
});

/**
 * The direction a column opens on its first click.
 *
 * Every header opened ascending, which is right for Name, Tier and Cryo — a
 * value you already have in mind, found from the top. It is wrong for "Tier
 * changed": nobody opens that column to find the account nothing has happened
 * to since last spring. They open it to answer "what moved while I was away",
 * and ascending answers the opposite question, putting the answer at the
 * bottom of the roster behind a second click.
 *
 * Asserted through the URL and through the rendered order, because the URL
 * alone would pass if `dir` stopped reaching the query.
 */
test("the date column opens newest-first; the others still open ascending", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  // Two accounts whose tier moved a year apart, named so that alphabetical
  // order and recency order disagree — otherwise a sort that did nothing at
  // all would pass this test.
  const ancient = await seedMember(db, { name: "Ancient", tier: "member" });
  const zeta = await seedMember(db, { name: "Zeta", tier: "member" });
  // `seedMember` does not take a tier-change instant — stamped here rather
  // than by widening a helper five other spec files share.
  await db
    .update(account)
    .set({ tierChangedAt: new Date("2024-01-01T00:00:00Z") })
    .where(eq(account.id, ancient.id));
  await db
    .update(account)
    .set({ tierChangedAt: new Date("2026-01-01T00:00:00Z") })
    .where(eq(account.id, zeta.id));
  await page.goto("/admin/accounts");

  await page.getByRole("link", { name: "Tier changed", exact: true }).click();
  await expect(page).toHaveURL(/[?&]sort=tierChangedAt(&|$)/);
  await expect(page).toHaveURL(/[?&]dir=desc(&|$)/);
  await expect(
    page.getByRole("columnheader", { name: "Tier changed", exact: true }),
  ).toHaveAttribute("aria-sort", "descending");
  // Zeta moved last, so it is first. Boss and Ancient are older.
  await expect(page.locator(".log--dense tbody tr").first()).toContainText("Zeta");

  // Once active the column toggles as it always did — this change is about
  // the first press only.
  await page.getByRole("link", { name: /^Tier changed/ }).click();
  await expect(page).toHaveURL(/[?&]dir=asc(&|$)/);
  await expect(page.locator(".log--dense tbody tr").first()).toContainText("Ancient");

  // A non-date column is untouched: still ascending on its first press.
  await page.goto("/admin/accounts");
  await page.getByRole("link", { name: "Tier", exact: true }).click();
  await expect(page).toHaveURL(/[?&]sort=tier(&|$)/);
  await expect(page).toHaveURL(/[?&]dir=asc(&|$)/);
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
  await zedDrawer.getByRole("button", { name: "Set Zed to Friends" }).click();
  // Two presses, not one: every tier chip arms first now (backlog item 1), so
  // an accidental brush of a chip can no longer lock the account.
  await zedDrawer.getByRole("button", { name: "confirm set Zed to Friends" }).click();
  // The lock mark is a CSS ::after (see ui.tsx/globals.css), not text, so it's
  // asserted via the element it's drawn on rather than getByText.
  await expect(zedRow.locator(".tier__lock")).toBeVisible();
  await expect(zedRow.locator(".tier")).toHaveText(/Friends/);
  // The drawer holds the controls, so it has to survive the revalidation the
  // server action triggers or the next click has nothing to land on. The open
  // state is React state in Disclosure and the closed drawer row is
  // `hidden`, so visibility is what reports it — there is no `open` property
  // to read any more.
  await expect(zedDrawer).toBeVisible();
  await zedDrawer.getByRole("button", { name: "auto" }).click();
  await expect(zedRow.locator(".tier__lock")).not.toBeVisible();
});

/**
 * The lock is the whole point of the press, and until this the confirmation
 * did not mention it.
 *
 * `setTierManual` writes `tierLocked: true` on every manual set, and the tier
 * buttons are only `disabled` when the account is *already* locked at that
 * tier — so on an ordinary auto-tiered account the button carrying
 * `aria-pressed="true"` is fully live, painted with the raised ground and
 * leading `▪` that the filter chips above use to mean "you are already here,
 * this does nothing". Pressing it is the case measured below: the tier does
 * not move, nothing in the row changes except a lock mark, and the sentence
 * has to carry the news on its own.
 *
 * The account's *current* tier is pressed deliberately. Setting Zed to a
 * different tier would change the tier token in the row and give the admin a
 * second, visible signal that something happened; pressing the one that is
 * already selected is the failure the copy exists for.
 */
test("pressing the already-selected tier says it pinned the account", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const zedRow = rowFor(page, "Zed");
  const zedDrawer = drawerOf(zedRow);
  await toggleOf(zedRow).click();

  // Zed is a member, so "Testers" (TIER_LABEL_MEMBER, playwright.config.ts) is
  // the tier already showing — and its button is live, not disabled.
  const already = zedDrawer.getByRole("button", { name: "Set Zed to Testers" });
  await expect(already).toHaveAttribute("aria-pressed", "true");
  await expect(already).toBeEnabled();
  // Backlog item 1. This press is the pin, and it is also the press most easily
  // made by accident — the chip is painted "you are already here", so nothing
  // about pressing it looks like it does anything. The arm step is what tells
  // the two apart, so assert it happened rather than just clicking through it:
  // one press must NOT have locked the account.
  await already.click();
  await expect(zedRow.locator(".tier__lock")).not.toBeVisible();
  // Arming keeps `aria-pressed` — which tier the row holds is not a fact about
  // whether this press is mid-confirm — and the account is still unlocked.
  await expect(already).toHaveAttribute("aria-pressed", "true");
  await zedDrawer.getByRole("button", { name: "confirm set Zed to Testers" }).click();

  const confirmation = zedDrawer.locator(".notice");
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("Zed pinned to Testers");
  // ...and it names the control that undoes it — which the same press has just
  // brought into the drawer for the first time.
  await expect(confirmation).toContainText("auto");
  await expect(
    zedDrawer.getByRole("button", { name: "return Zed to auto tier", exact: true }),
  ).toBeVisible();
  // The pin is real, not just claimed: the lock mark is on the row and the
  // button that was live a moment ago is now the disabled one.
  await expect(zedRow.locator(".tier__lock")).toBeVisible();
  await expect(already).toBeDisabled();
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

test("an admin can unlink a member's Discord", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const member = await seedMember(db, { name: "Pilot", tier: "alumni" });
  await db.insert(discordLink).values({
    accountId: member.id,
    discordUserId: "duid-e2e",
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/admin/accounts");
  // Ruling R2 (docs/design-walkthrough.md) moved this control off the
  // collapsed row and into the drawer, the same move #186 made for
  // `/account`'s MAIN/UNLINK — the drawer has to be open before the button
  // exists at all (`everOpen` in disclosure.tsx).
  await toggleOf(rowFor(page, "Pilot")).click();
  // The cost of the unlink is carried as a description, not folded into the
  // accessible name: the name is spoken ahead of every press and has to keep
  // matching the visible label (WCAG 2.5.3). Asserted at rest AND armed because
  // ConfirmSubmit swaps the name on arm (confirm-submit.tsx:139) while leaving
  // aria-describedby alone (:140) — the description has to survive that swap,
  // and nothing else in the suite would notice if the id link broke.
  const unlink = page.getByRole("button", {
    name: "unlink Discord for Pilot",
    exact: true,
  });
  await expect(unlink).toHaveAccessibleDescription(
    "Unlinking queues removal of the Discord roles authGD manages for this member.",
  );
  await unlink.click();
  const confirm = page.getByRole("button", {
    name: "confirm unlink Discord for Pilot",
    exact: true,
  });
  await expect(confirm).toHaveAccessibleDescription(
    "Unlinking queues removal of the Discord roles authGD manages for this member.",
  );
  await confirm.click();

  await expect(
    page.getByRole("button", { name: "unlink Discord for Pilot", exact: true }),
  ).toHaveCount(0);
  // The half the button's disappearance says nothing about. A success here
  // unmounts the section the control lived in, so the confirmation only paints
  // if its `ConfirmGroup` host is outside that conditional (page.tsx) — nested
  // inside, this sentence is returned into a subtree already being removed and
  // the assertion above still passes. Focus follows it: `ConfirmGroup` focuses
  // its own host on every report, and a host that unmounted could not be
  // focused, so an admin who pressed this by keyboard would be dropped to
  // `<body>` with the drawer's remaining controls behind a full re-traverse.
  const notice = page.getByText("Discord unlinked for Pilot.", { exact: true });
  await expect(notice).toBeVisible();
  await expect(notice.locator("xpath=ancestor::div[@tabindex='-1'][1]")).toBeFocused();
  expect(await db.select().from(discordLink)).toHaveLength(0);
});

/**
 * Two admins working the same row, or one with a drawer open since this
 * morning — the same class of race `"approving an account someone else
 * already approved"` covers for the tier queue, but this control has no
 * redirect to fall back on (ruling R2 moved it into the drawer, and a
 * redirect there would close the very drawer the admin has open). Written
 * directly to the DB rather than through the action, so `unlinkDiscord`'s own
 * re-check under the row lock is what has to catch it, not this test's setup.
 */
test("unlinking a Discord link someone else already cleared lands on a warning, not silence", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const member = await seedMember(db, { name: "Pilot", tier: "alumni" });
  await db.insert(discordLink).values({
    accountId: member.id,
    discordUserId: "duid-e2e-race",
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/admin/accounts");
  await toggleOf(rowFor(page, "Pilot")).click();

  const unlink = page.getByRole("button", {
    name: "unlink Discord for Pilot",
    exact: true,
  });
  await unlink.click();
  const confirm = page.getByRole("button", {
    name: "confirm unlink Discord for Pilot",
    exact: true,
  });
  await expect(confirm).toBeVisible();

  // The other admin's clear, landing between the arm above and the press
  // below.
  await db.delete(discordLink).where(eq(discordLink.accountId, member.id));

  await confirm.click();

  // No redirect: `not_linked` resolves inline, the way it always has — this
  // control's error union never reached `redirectOnMutationError` at all. What
  // changed is that resolving inline used to mean resolving silently. The URL
  // picks up no `?error=` code and the drawer this admin had open stays open
  // rather than being replaced by a fresh route tree.
  await expect(page).not.toHaveURL(/[?&]error=/);
  const row = rowFor(page, "Pilot");
  await expect(drawerOf(row)).toBeVisible();
  const notice = drawerOf(row).locator("p.notice--warn");
  await expect(notice).toContainText("Discord was already unlinked for Pilot.");
  await expect(page.getByText("Something broke")).toHaveCount(0);
});

/**
 * The same race one control over, and the reason `changed` exists on every
 * mutation in `services/admin-accounts.ts`: a press that writes nothing must
 * not read back as a press that did. The freeze control only renders on a row
 * the page believes is active, so the only way to press it against a frozen
 * account is for the freeze to land between the render and the press — which
 * is exactly what this stages, by writing the status directly rather than
 * through the action, so `setAccountStatus`'s own re-check is what catches it.
 *
 * The cost of getting this wrong is not just a wrong sentence: the success
 * copy sends an admin to `/admin/audit` for a row that was never written.
 */
test("freezing an account someone else already froze says so, and claims nothing", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const member = await seedMember(db, { name: "Pilot", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/admin/accounts");
  const row = rowFor(page, "Pilot");
  await toggleOf(row).click();
  await drawerOf(row).getByRole("button", { name: "freeze Pilot", exact: true }).click();
  const confirm = drawerOf(row).getByRole("button", {
    name: "confirm freeze Pilot",
    exact: true,
  });
  await expect(confirm).toBeVisible();

  // The other admin's freeze, landing between the arm above and the press
  // below.
  await db.update(account).set({ status: "cryo" }).where(eq(account.id, member.id));

  await confirm.click();

  const notice = drawerOf(rowFor(page, "Pilot")).locator("p.notice");
  await expect(notice).toHaveText("Pilot was already frozen.");
  // The distinction the whole change is for: not the success sentence, which
  // would send this admin looking for an audit row that does not exist.
  await expect(notice).not.toHaveText("Pilot frozen.");
});

/**
 * The note field is the one control here an admin can press twice against the
 * same value without any race at all — it stays on screen holding its own text
 * after a save, and pressing again is a natural way to make sure. `"· saved"`
 * on that second press would claim a write `setStatusNote` short-circuited.
 */
test("saving a note that hasn't changed says already saved, not saved", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const drawer = drawerOf(rowFor(page, "Zed"));
  await toggleOf(rowFor(page, "Zed")).click();

  const save = drawer.getByRole("button", { name: "save note" });
  const saved = drawer.locator(".note-form__saved");
  await drawer.getByPlaceholder("notes").fill("watch this one");
  await save.click();
  await expect(saved).toHaveText("· saved");

  // Same text, second press. `seq` still has to advance — that is what clears
  // `dirty` and repaints this at all — while `changed` says what the press did.
  await save.click();
  await expect(saved).toHaveText("· already saved");
});

/**
 * A press the re-entry guard refuses produces no POST and no response
 * (`submit-guard.ts`), so nothing about it reaches `ConfirmingForm`. Outside a
 * drawer that silence is fine: the first press navigated, and the admin can
 * see it. Inside one the page does not move, so the refusal is indistinguishable
 * from a dead control — hence `ConfirmSubmit` reporting it into the group's own
 * notice when there is a group above it.
 *
 * Reaching the guard takes three clicks, not two: after the first confirm the
 * control disarms, so the next click re-arms (never touching the guard) and
 * only the one after that is a submit for the guard to refuse.
 */
test("a drawer press refused while the last one is still in flight says so", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await seedMember(db, { name: "Pilot", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  // Held open so the second confirm lands while the first is still in flight.
  // POSTs only: the server action is one, the RSC fetches around it are not.
  await page.route("**/admin/accounts**", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

  const row = rowFor(page, "Pilot");
  await toggleOf(row).click();
  const freeze = drawerOf(row).getByRole("button", { name: /freeze Pilot/ });
  await freeze.click();
  await freeze.click();
  await freeze.click(); // re-arms
  await freeze.click(); // refused: the first press is still in flight

  const notice = drawerOf(rowFor(page, "Pilot")).locator("p.notice--warn");
  await expect(notice).toHaveText("Still working on the last press.");
  // And it is not the last word: the action it was waiting on overwrites it.
  await expect(drawerOf(rowFor(page, "Pilot")).locator("p.notice")).toHaveText(
    "Pilot frozen.",
  );
});

/**
 * The unlink control sits in the drawer at the standalone (36px) grade, per
 * ruling R1 (DESIGN.md's "Hit targets") — the same grade every other control
 * in this drawer takes, not the 28px `.btn--micro` grade the collapsed row's
 * own actions (revoke, grant, sync now) correctly keep.
 */
test("the Discord unlink control sits at the standalone hit-target grade", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const member = await seedMember(db, { name: "Pilot", tier: "alumni" });
  await db.insert(discordLink).values({
    accountId: member.id,
    discordUserId: "duid-e2e-grade",
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  await toggleOf(rowFor(page, "Pilot")).click();

  const unlink = page.getByRole("button", {
    name: "unlink Discord for Pilot",
    exact: true,
  });
  const box = await unlink.boundingBox();
  expect(box).not.toBeNull();
  // 36px, `.btn`'s own `min-height` — not `.btn--micro`'s 28px.
  expect(box!.height).toBeGreaterThanOrEqual(36);
});

/**
 * The Discord column names the account a drawer's unlink control is about to
 * disconnect. Before #115, a linked row said only `unlink` — the admin could
 * see that a link existed but not where it pointed; ruling R2 later moved the
 * control itself into the row's drawer, but the collapsed cell keeps naming
 * the link for the same reason — it is what tells an admin, scanning the
 * table, whether the link points where they think it does before ever
 * opening the row to disconnect it.
 *
 * The null case is the important half. Nothing backfills these columns; they
 * fill in on each account's next roles sync, so on the deploy that ships this
 * every row is null and has to keep working. It renders a bare `linked`
 * status, not a placeholder name.
 */
test("the Discord column names the account behind the link, when it knows it", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const named = await seedMember(db, { name: "Alpha Pilot", tier: "member" });
  const unnamed = await seedMember(db, { name: "Bravo Pilot", tier: "member" });
  await db.insert(discordLink).values({
    accountId: named.id,
    discordUserId: "duid-named",
    username: "guarzo",
    // Set, and deliberately not expected below: the display name is the account
    // page's business. A row here is already identified by its EVE name in the
    // pinned first column.
    displayName: "Wardec Wally",
  });
  await db.insert(discordLink).values({
    accountId: unnamed.id,
    discordUserId: "duid-unnamed",
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  const cellFor = (name: string) => rowFor(page, name).locator(".discord-cell");

  await expect(cellFor("Alpha Pilot")).toContainText("@guarzo");
  await expect(cellFor("Alpha Pilot")).not.toContainText("Wardec Wally");
  // No handle known yet: a bare `linked` status, not a placeholder name — and
  // no control here at all, since ruling R2 moved it into the drawer.
  await expect(cellFor("Bravo Pilot")).toHaveText("linked");
  await expect(
    rowFor(page, "Bravo Pilot").getByRole("button", {
      name: "unlink Discord for Bravo Pilot",
      exact: true,
    }),
  ).toHaveCount(0);
  await toggleOf(rowFor(page, "Bravo Pilot")).click();
  await expect(
    rowFor(page, "Bravo Pilot").getByRole("button", {
      name: "unlink Discord for Bravo Pilot",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    drawerOf(rowFor(page, "Bravo Pilot")).getByRole("button", {
      name: "unlink Discord for Bravo Pilot",
      exact: true,
    }),
  ).toBeVisible();
});

/**
 * A row with no Discord link at all renders `none` in the column and mounts
 * no Discord group in its drawer — matching Session 3's judgement for
 * `/account`'s own empty case (`character-row.tsx`): no dangling label or
 * empty `.drawer__group` for a control that has nothing to act on.
 */
test("a row with no Discord link renders no Discord drawer group", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await seedMember(db, { name: "Solo Pilot", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  await expect(rowFor(page, "Solo Pilot").locator(".discord-cell")).toHaveCount(0);
  await expect(rowFor(page, "Solo Pilot")).toContainText("none");
  await toggleOf(rowFor(page, "Solo Pilot")).click();
  const drawer = drawerOf(rowFor(page, "Solo Pilot"));
  // The absence assertion below is `toHaveCount(0)`, which is also true of a
  // drawer that never opened and of a locator that resolved to nothing. Anchor
  // it first on something this drawer always renders, so "no Discord section"
  // can only be read off a drawer that is actually there.
  await expect(
    drawer.getByRole("textbox", { name: "Note for Solo Pilot" }),
  ).toBeVisible();
  await expect(drawer.getByText("Discord", { exact: true })).toHaveCount(0);
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const waiting = await seedMember(db, { name: "Waiting Pilot", tier: "pending" });
  await seedMember(db, { name: "Settled Pilot", tier: "alumni" });
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
  // is "Approve as Veterans" on every queued account, and this is the press that
  // grants someone access. The row goes after the visible label rather than
  // inside it, so the label survives as one contiguous run of the accessible
  // name and speech input can still reach the button by what is written on it
  // (WCAG 2.5.3) — the same convention the Actions cell uses.
  await drawer
    .getByRole("button", { name: "Approve as Veterans for Waiting Pilot", exact: true })
    .click();

  // The queue is empty, so the standing reminder is gone...
  await expect(page.getByRole("link", { name: /awaiting approval/i })).toHaveCount(0);
  // ...and the ?tier=pending view it linked to is empty too, which is also the
  // second half of the filter claim above: the approved account left this view.
  await expect(page.locator("td.log__empty")).toHaveText("No members match this filter.");
  // Read from the database rather than from the page: alumni is the unlocked
  // grant, so the membership job may still move it later.
  const [approved] = await db.select().from(account).where(eq(account.id, waiting.id));
  expect(approved.tier).toBe("alumni");
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
  for (const tier of ["Testers", "Friends", "Veterans"]) {
    await expect(
      settledDrawer.getByRole("button", {
        name: `Set Settled Pilot to ${tier}`,
        exact: true,
      }),
    ).toBeVisible();
  }
  // Matched on the accessible name pattern rather than on the bare word: the
  // tier controls all name their row, so `name: "Queued"` would match nothing
  // whether the rule holds or not.
  await expect(settledDrawer.getByRole("button", { name: /to Queued$/ })).toHaveCount(0);
  await expect(settledDrawer.getByRole("button", { name: /^approve /i })).toHaveCount(0);

  // ...and the converse on a pending row: the approve pair replaces the manual
  // tiers rather than joining them, so there is no way to stamp a queued
  // account without going through approveAccount's audit entry.
  const waiting = rowFor(page, "Waiting Pilot");
  const waitingDrawer = drawerOf(waiting);
  await toggleOf(waiting).click();
  await expect(
    waitingDrawer.getByRole("button", {
      name: "Approve as Veterans for Waiting Pilot",
      exact: true,
    }),
  ).toHaveText("Approve as Veterans");
  await expect(
    waitingDrawer.getByRole("button", {
      name: "Approve as Friends for Waiting Pilot",
      exact: true,
    }),
  ).toHaveText("Approve as Friends");
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  // Active, so ?status=cryo excludes it from the table below.
  await seedMember(db, { name: "Waiting Pilot", tier: "pending" });
  await seedMember(db, { name: "Frozen Pilot", tier: "alumni", status: "cryo" });
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const waiting = await seedMember(db, { name: "Waiting Pilot", tier: "pending" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts?tier=pending");

  const row = rowFor(page, "Waiting Pilot");
  await toggleOf(row).click();
  const approve = drawerOf(row).getByRole("button", {
    name: "Approve as Veterans for Waiting Pilot",
    exact: true,
  });
  await expect(approve).toBeVisible();

  // The other admin's approval, landing between this render and the click
  // below. Written directly rather than through the action so that
  // approveAccount's own re-check under the row lock is what has to catch it.
  await db.update(account).set({ tier: "associate" }).where(eq(account.id, waiting.id));

  await approve.click();
  // Back to the queue, not to the unfiltered list: the admin was working the
  // queue and has more of it to work.
  //
  // Asserted as two independent params rather than as the adjacent pair they
  // used to be. The error URL now carries the whole view the admin was looking
  // at — sort and dir as well as the filter — so `sort=name&dir=asc` sits
  // between these two, and a regex pinning them side by side would be pinning
  // param order, which nothing depends on.
  await expect(page).toHaveURL(/[?&]tier=pending(&|$)/);
  await expect(page).toHaveURL(/[?&]error=not_pending(&|$)/);
  // Scoped rather than a bare getByRole("alert"): Next's dev-only
  // `__next-route-announcer__` carries the same role.
  await expect(page.locator("p.notice--bad")).toContainText(
    "already approved by someone else",
  );
  await expect(page.getByText("Something broke")).toHaveCount(0);
  // The other admin's grant stands — the losing click must not re-stamp it.
  const [after] = await db.select().from(account).where(eq(account.id, waiting.id));
  expect(after.tier).toBe("associate");
});

/**
 * The general form of the claim above, on a view that has nothing to do with
 * the approval queue.
 *
 * The old error URLs carried at most a hard-coded `tier=pending`, on the theory
 * that only queue work produced these races. Every other admin — filtered to
 * cryo, sorted by tier changed — was dropped on the unfiltered list sorted by
 * name and had to rebuild the view before they could carry on. `last_admin` is
 * used here because it needs no second actor to provoke: one admin, demoting
 * themselves. The path it takes through `adminAccountsErrorUrl` is the one
 * every other mutation error takes.
 */
test("an error returns the admin to the filter and sort they were working", async ({
  page,
  context,
}) => {
  // The only admin, and frozen, so ?status=cryo is a view that actually holds
  // them: an empty list would make the assertions below vacuous.
  const admin = await seedMember(db, {
    name: "Boss",
    tier: "member",
    status: "cryo",
    isAdmin: true,
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts?status=cryo&sort=tierChangedAt&dir=desc");

  const bossRow = rowFor(page, "Boss");
  await expect(bossRow).toHaveCount(1);
  const revoke = bossRow.getByRole("button", { name: "revoke admin for Boss" });
  await revoke.click();
  await bossRow.getByRole("button", { name: /^confirm revoke admin/ }).click();

  // Every param of the view survives, not just the one the old code guessed at.
  await expect(page).toHaveURL(/[?&]status=cryo(&|$)/);
  await expect(page).toHaveURL(/[?&]sort=tierChangedAt(&|$)/);
  await expect(page).toHaveURL(/[?&]dir=desc(&|$)/);
  await expect(page).toHaveURL(/[?&]error=last_admin(&|$)/);
  // No stale `tier=pending` invented on the way through, which is what the
  // removed forced filter would have added here.
  await expect(page).not.toHaveURL(/[?&]tier=/);

  await expect(page.locator("p.notice--bad")).toContainText("last admin");
  // And the list under the notice is the filtered one, rendered from those
  // params rather than merely named by them.
  await expect(page.locator(ROWS)).toHaveCount(1);
  // The active chip's accessible name picks up the "▪" its aria-current
  // styling draws in front of it, and a bare "cryo" also matches the Cryo
  // column's sort link, so name the chip as it actually reads.
  await expect(page.getByRole("link", { name: "▪ cryo", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

/**
 * `accountsConfirmation` (view.ts) is unit-tested directly, and `isDoneCode`
 * with it, but neither of those proves `AdminAccountsPage` actually applies
 * `isDoneCode` to `params.done` before calling it — that wiring at the page
 * boundary is the entire point of narrowing `accountsConfirmation`'s
 * signature, and it has no coverage anywhere else. `syncAccountAction` is the
 * cheapest of the four `doneUrl` call sites to reach: no confirm-arm, no
 * side effect worth asserting beyond the redirect itself.
 */
test("a recognised ?done= code renders its confirmation", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await seedMember(db, { name: "Sync Target", tier: "member", status: "active" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  // "sync now" is a row action, not a drawer control — it sits in the row's
  // own admin-actions cell, unlike grant/revoke/tier/freeze which live behind
  // the row's toggle.
  const row = rowFor(page, "Sync Target");
  await row
    .getByRole("button", { name: "sync now for Sync Target", exact: true })
    .click();

  await expect(page).toHaveURL(/[?&]done=sync(&|$)/);
  // Scoped to `ConfirmNotice`'s own wrapper (the `tabIndex={-1}` focus
  // target): the page mounts two other `Notice`s unconditionally
  // (`errorMessage`, the pending-queue banner), and a bare `p.notice` would
  // match whichever of the three happens to have text.
  const notice = page.locator('div[tabindex="-1"] p.notice');
  await expect(notice).toHaveText(
    "Sync queued for Sync Target. The worker picks it up within a few seconds.",
  );
});

/**
 * The other half of the same boundary: a hand-edited `?done=` (or one a build
 * has since dropped) must not become copy on the page. Reached by direct
 * navigation, not a button — there is no in-app way to produce an
 * unrecognised code, which is exactly why the page-level guard, not a form
 * validator, is what has to catch it.
 *
 * Asserted on text content, not element count: `Notice` mounts an empty
 * `.notice-slot` unconditionally (ui.tsx's own docblock), so a bare
 * `toHaveCount` would pass whether or not `isDoneCode` actually ran — see
 * `docs/design-sweep`'s note on the audit page's identical trap. This page
 * carries two OTHER unconditional `Notice`s beside `ConfirmNotice`
 * (`errorMessage`, the pending-queue banner), both empty here too since
 * neither `?error=` nor a pending queue is in play — scoping to
 * `ConfirmNotice`'s own `tabIndex={-1}` wrapper is what keeps this pinned to
 * the boundary under test rather than any of the three.
 */
test("an unrecognised ?done= code renders no confirmation", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/admin/accounts?done=delete_account&name=Nobody");

  const slot = page.locator('div[tabindex="-1"] p');
  await expect(slot).toHaveCount(1);
  await expect(slot).toHaveClass("notice-slot");
  await expect(slot).toHaveText("");
  await expect(slot).not.toHaveAttribute("data-glyph", /./);
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await seedMember(db, { name: "Waiting Pilot", tier: "pending" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts?tier=pending");

  const row = rowFor(page, "Waiting Pilot");
  await toggleOf(row).click();
  const approve = drawerOf(row).getByRole("button", {
    name: "Approve as Veterans for Waiting Pilot",
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
  // buttons and freeze sit exactly together already (both are `.btn`, the
  // standalone 36px grade ruling R1 gives every control in this drawer), so
  // the gap under test is only the note row's own offset.
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
    // `.scroller--tall` reserves a vertical-scrollbar gutter unconditionally
    // (globals.css, `scrollbar-gutter: stable`); `gutterWidth` measures it
    // directly (see geometry.ts), so the rightmost scrollLeft only has to
    // clear the naive figure less that measured reservation, not an assumed
    // one.
    expect(pinned.scrolledLeft).toBeGreaterThanOrEqual(
      pinned.maxScrollLeft - pinned.gutterWidth,
    );
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

/**
 * Pressing a tier mounts the `auto` button next to the three tier buttons
 * (page.tsx renders it under `r.tierLocked`), so the press that pins a tier is
 * the press that grows this group. Measured at 320px with `.btn-group` unable
 * to wrap: the group went 251.3px → 282.9px inside a 262px drawer panel, which
 * put `auto` — the control that undoes the pin — off the panel and behind a
 * sideways scroll of the accounts table.
 *
 * The bound is the drawer's control column as it stood *before* the press, not
 * `.drawer` itself and not the column measured afterwards. Two measurements
 * rule those out. `.drawer__controls` is 264.5 against a 262px panel with
 * nothing pressed — the note field's own intrinsic minimum, which is there
 * whenever the drawer is open (hiding the Note group drops the column to
 * exactly 262), so a panel-relative bound would be pinning that instead of
 * this. And measuring the column *after* the press is circular: the tier group
 * is a stretch item in that column, so an unwrapped group widens `.note-form`
 * and every sibling to match itself — a draft asserting group ⊆ column passed
 * with this fix reverted, at 311.9 vs 311.9.
 */
test("accounts at 320px: the tier group stays in the drawer when the press adds auto", async ({
  page,
  context,
}) => {
  const admin = await seedDenseWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");
  await page.waitForSelector(".scroller tbody tr");

  const row = rowFor(page, "Member 00");
  const drawer = drawerOf(row);
  await toggleOf(row).click();
  await expect(drawer).toBeVisible();

  const columnRight = (loc: Locator) =>
    loc.evaluate(
      (tr) =>
        (tr.querySelector(".drawer__controls") as HTMLElement).getBoundingClientRect()
          .right,
    );
  const before = await columnRight(drawer);

  await drawer
    .getByRole("button", { name: "Set Member 00 to Friends", exact: true })
    .click();
  await drawer
    .getByRole("button", { name: "confirm set Member 00 to Friends", exact: true })
    .click();
  // The guard: without the press actually landing, the group never grows and
  // every measurement below passes on the pre-press layout.
  await expect(
    drawer.getByRole("button", { name: "return Member 00 to auto tier", exact: true }),
  ).toBeVisible();

  const after = await drawer.evaluate((tr) => {
    const group = tr.querySelector(".btn-group") as HTMLElement;
    return {
      groupRight: group.getBoundingClientRect().right,
      buttons: group.querySelectorAll("button").length,
    };
  });
  expect(after.buttons, "three tiers plus auto").toBe(4);
  expect(
    after.groupRight,
    "pinning a tier does not push the group past where the drawer's controls already ended",
  ).toBeLessThanOrEqual(before + 0.5);
});

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
 * Finding 4.4 (docs/design-walkthrough.md, Session 4). This replaces the two
 * specs that used to sit here — "the crew table scrolls inside its region
 * rather than escaping the drawer" and "the crew region scrolled to the top of
 * the pinned table stays clear of the header" — both of which asserted that
 * the crew Scroller overflowed at 320px and held a keyboard tab stop there.
 * That was true of the fix those specs were guarding (the two `min-width: 0`
 * floors, `.drawer__crew` and `.drawer__crew .scroller-frame` in globals.css):
 * it made the crew table scroll in its own region instead of escaping the
 * drawer panel. But a scroller nested inside the page's own horizontally
 * scrolling region has no good visual state either way, which is finding 4.4:
 * below 30rem the crew table now reflows into one labelled block per
 * character instead of scrolling, and above it the Name column is bounded
 * (`.log--crew .char` in globals.css, guarded by the long-name spec below),
 * so there is nothing left in that region to overflow at any width. The old
 * specs' premise — tabIndex 0, a real scroll range at 320px — is exactly the
 * state this fix removes, which is why they're gone rather than updated in
 * place. Deleting the second one is the load-bearing call: it was a WCAG 2.2
 * 2.4.11 guard, and a WCAG guard is only safe to delete when the scenario
 * cannot occur, not when the current fixture happens not to reach it. It is
 * safe here because a region that never takes a tab stop can never be the
 * target of a sequential-focus scroll — which is what the long-name spec
 * below pins, at the widths where a long name used to keep the scroll range
 * alive.
 *
 * Five widths, matching the measurements in the `.log--crew` comment in
 * globals.css. Re-measured on this repo's own `seedDenseWorld` fixture rather
 * than trusting the walkthrough's quoted figures verbatim: the walkthrough put
 * the boundary at 440px (370.45px min-content against a 370px scrollport), but
 * on this fixture the table's min-content is 395.77px and 440px still
 * overflows by 26px — the true boundary is 465px. 320/390/420 sit inside the
 * old overflowing band; 479px is just under the chosen 30rem breakpoint
 * (still reflowed, with margin above the measured 465px); 480px and 768px are
 * comfortably at and above it.
 */
for (const { width, reflowed } of [
  { width: 320, reflowed: true },
  { width: 390, reflowed: true },
  { width: 420, reflowed: true },
  { width: 479, reflowed: true },
  { width: 480, reflowed: false },
  { width: 768, reflowed: false },
]) {
  test(`the crew table is ${
    reflowed ? "reflowed into blocks" : "still tabular"
  } at ${width}px`, async ({ page, context }) => {
    const admin = await seedDenseWorld();
    await context.addCookies([await sessionCookieFor(db, admin.id)]);
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/admin/accounts");

    const row = page.locator(ROWS).nth(12);
    await toggleOf(row).click();
    await expect(drawerOf(row)).toBeVisible();

    const region = drawerOf(row).locator(".drawer__crew .scroller");
    // Settles after a ResizeObserver measurement post-hydration, not on the
    // server render — wait for the measured state rather than reading
    // tabIndex the instant the drawer appears (same discipline the specs
    // above this one use).
    await expect(region).toHaveAttribute("tabindex", "-1");

    const geom = await drawerOf(row).evaluate((tr) => {
      const r = tr.querySelector<HTMLElement>(".drawer__crew .scroller");
      const thead = tr.querySelector<HTMLElement>(".log--crew thead");
      const label = tr.querySelector<HTMLElement>(".log--crew .crew__label");
      if (!r || !thead || !label) return null;
      return {
        scrollWidth: r.scrollWidth,
        clientWidth: r.clientWidth,
        theadDisplay: getComputedStyle(thead).display,
        labelDisplay: getComputedStyle(label).display,
      };
    });

    expect(geom, "the crew scroller, its thead and a label all resolved").not.toBeNull();
    // At every one of these six widths the crew scroller now has nothing to
    // scroll — reflowed widths because the table is no longer laid out wide,
    // tabular widths because the drawer has room for this fixture's short
    // names. Short names are the floor, not the whole story: the long-name
    // case is the next spec's, because it is what decided the breakpoint.
    expect(
      geom!.scrollWidth,
      "the crew scroller has no scroll range left to overflow",
    ).toBeLessThanOrEqual(geom!.clientWidth + 1);
    expect(
      geom!.theadDisplay,
      reflowed
        ? "the thead is hidden below the breakpoint, its th scope=col job taken over by .crew__label"
        : "the thead stays visible at and above the breakpoint",
    ).toBe(reflowed ? "none" : "table-header-group");
    expect(
      geom!.labelDisplay,
      reflowed
        ? "the per-cell label shows below the breakpoint"
        : "the per-cell label stays hidden where the thead is doing the naming",
    ).toBe(reflowed ? "block" : "none");
  });
}

/**
 * The other axis of finding 4.4, and the one that makes the 30rem breakpoint
 * defensible. A crew table's min-content is text-driven, and `.char` sets
 * `white-space: nowrap`, so a character name is a single unbreakable word:
 * the fixture above measures 395.77px because its names are short, but EVE
 * allows 37 characters and at that length the same table measures 616px. That
 * still overflows by 206px at 480px, 86px at 600px and 2px at 700px — the
 * whole tabular band the spec above declares clear, on a name a real alliance
 * can have. Covering it by breakpoint alone would mean reflowing to blocks at
 * ~44rem, where three of the four columns fit side by side perfectly well, so
 * `.log--crew .char` unbinds `nowrap` for this table instead (and only this
 * table — the account manifest's identity block wants its name on one line).
 *
 * These are the three widths where the unbounded name still overflowed. The
 * assertion is the same pair the spec above makes, for the reason the header
 * comment there gives: a region that never takes a tab stop can never be
 * scrolled into view by sequential focus navigation, which is what retires
 * the deleted WCAG 2.2 2.4.11 spec rather than the fixture simply not
 * reaching that state.
 *
 * The name is one of two texts in this table that needed bounding; the quoted
 * contact label in the Standings cell is the other, pinned by the spec below.
 * `.char__location` is the third player-supplied string in a crew row —
 * structure names run past 150 characters — but `globals.css` already caps it
 * at `max-width: 22rem` with `overflow: hidden`, and that caps its intrinsic
 * contribution too: a 200-character location injected into an open drawer
 * clips at 352px and moves the scroller's `scrollWidth` not at all, at 480
 * through 1000px. Not pinned here because the cap is `.char__location`'s own
 * contract, not this table's, and a spec here would fail for whoever
 * legitimately changes it.
 */
for (const width of [480, 600, 700]) {
  test(`a 37-character crew name leaves the crew scroller nothing to scroll at ${width}px`, async ({
    page,
    context,
  }) => {
    const admin = await seedMember(db, {
      name: "Aaa Boss",
      tier: "member",
      isAdmin: true,
    });
    // 37 characters, EVE's ceiling, with no space to break at — the worst
    // case for a `nowrap` cell, not merely a long one.
    const longName = "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(longName).toHaveLength(37);
    await seedMember(db, { name: longName, tier: "member" });
    await context.addCookies([await sessionCookieFor(db, admin.id)]);
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/admin/accounts");

    const row = rowFor(page, longName);
    await toggleOf(row).click();
    await expect(drawerOf(row)).toBeVisible();

    const region = drawerOf(row).locator(".drawer__crew .scroller");
    // Post-hydration ResizeObserver measurement, as above — wait for the
    // settled attribute rather than reading it on the first paint.
    await expect(region).toHaveAttribute("tabindex", "-1");

    const geom = await region.evaluate((r) => ({
      scrollWidth: r.scrollWidth,
      clientWidth: r.clientWidth,
    }));
    expect(
      geom.scrollWidth,
      "a 37-character name no longer holds the crew table open past its scrollport",
    ).toBeLessThanOrEqual(geom.clientWidth + 1);
  });
}

/**
 * The second unbounded text, and the one that nearly shipped as a hole.
 *
 * The Standings cell renders `ContactRemedy`, which on a `label_mismatch`
 * result quotes the member's own label back inside `code.literal` — and
 * `code.literal` is `white-space: pre`, which suppresses wrapping exactly as
 * the name cell's `nowrap` did. The quoted text is unbounded from two
 * directions: `STANDINGS_LABEL` has no maximum length (`z.string().min(1)`,
 * src/config.ts) and is operator-set, and the candidate labels are raw
 * player-set EVE contact labels.
 *
 * Bounding the name alone left this open at EVERY width, not only in the
 * reflow band — measured before the fix, `.drawer__crew .scroller` reported
 * scrollWidth/clientWidth of 976/250 at 320px, 976/409 at 479px, 1205/410 at
 * 480px and 1205/530 at 600px. That is the tab stop the deleted WCAG 2.2
 * 2.4.11 spec used to guard, reachable through ordinary content, so this is
 * pinned rather than merely recorded: it is the premise the deletion rests on.
 *
 * Both bands are covered because the bug spanned both, and no earlier spec
 * seeded a contact result at all.
 */
for (const width of [320, 480, 600]) {
  test(`a long quoted contact label leaves the crew scroller nothing to scroll at ${width}px`, async ({
    page,
    context,
  }) => {
    const admin = await seedMember(db, {
      name: "Aaa Boss",
      tier: "member",
      isAdmin: true,
    });
    const target = await seedMember(db, { name: "Label Holder", tier: "member" });
    const [ch] = await db
      .select()
      .from(character)
      .where(eq(character.accountId, target.id));
    // One unbroken 120-character label: the worst case for `pre`, not merely a
    // long one. EVE imposes no length here that this table can rely on.
    await db.insert(contactSyncState).values({
      characterId: ch.id,
      lastResult: "label_mismatch",
      lastDetail: JSON.stringify([`${"L".repeat(120)}`]),
    });
    await context.addCookies([await sessionCookieFor(db, admin.id)]);
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/admin/accounts");

    const row = rowFor(page, "Label Holder");
    await toggleOf(row).click();
    await expect(drawerOf(row)).toBeVisible();

    // Fail loudly if the fixture stops producing the remedy at all: without
    // this the geometry assertion below would pass on an empty cell and the
    // spec would guard nothing.
    await expect(drawerOf(row).locator(".log--crew code.literal").first()).toBeVisible();

    const region = drawerOf(row).locator(".drawer__crew .scroller");
    await expect(region).toHaveAttribute("tabindex", "-1");

    const geom = await region.evaluate((r) => ({
      scrollWidth: r.scrollWidth,
      clientWidth: r.clientWidth,
    }));
    expect(
      geom.scrollWidth,
      "a 120-character quoted label no longer holds the crew table open past its scrollport",
    ).toBeLessThanOrEqual(geom.clientWidth + 1);
  });
}

/**
 * The accessibility-tree half of finding 4.4: `display: grid`/`block` on a
 * `<tr>`/`<td>` strips the table's own semantics in every browser tested, so
 * hiding the `<thead>` below the breakpoint would silently drop the column
 * names from the a11y tree if nothing stood in for them — which is why
 * `.crew__label` exists as a real DOM element rather than `content:
 * attr(data-label)` (generated content is inconsistently exposed to
 * assistive tech). This measures the actual a11y tree at both widths rather
 * than assuming the CSS `display` toggle above is enough.
 */
test("the crew column names reach the accessibility tree at both widths, never doubled", async ({
  page,
  context,
}) => {
  const admin = await seedDenseWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // Narrow: the thead is display:none (removed from the a11y tree with it),
  // so "columnheader" roles for the crew table disappear and the label spans
  // are the only surviving carrier of the column names.
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/accounts");
  const narrowRow = page.locator(ROWS).nth(12);
  await toggleOf(narrowRow).click();
  const narrowDrawer = drawerOf(narrowRow);
  await expect(narrowDrawer.locator(".drawer__crew .scroller")).toHaveAttribute(
    "tabindex",
    "-1",
  );
  await expect(narrowDrawer.getByRole("columnheader", { name: "Token" })).toHaveCount(0);
  await expect(narrowDrawer.getByRole("columnheader", { name: "Standings" })).toHaveCount(
    0,
  );
  // Scoped to the table, not to `.drawer__crew`: that section also renders a
  // sibling `Map observed <timestamp>` line outside the table, and a snapshot
  // taken over the section would satisfy `toContain("Map")` from that line
  // alone — the one column name here whose assertion could pass with its label
  // span deleted.
  const narrowSnapshot = await narrowDrawer.locator(".log--crew").ariaSnapshot();
  for (const name of ["Name", "Token", "Standings", "Map"]) {
    expect(
      narrowSnapshot,
      `"${name}" reaches the a11y tree below the breakpoint`,
    ).toContain(name);
  }

  // Wide: the thead is back, so the columnheader roles are exposed again —
  // and the label spans are display:none, so the names aren't read twice.
  await page.setViewportSize({ width: 768, height: 720 });
  await page.goto("/admin/accounts");
  const wideRow = page.locator(ROWS).nth(12);
  await toggleOf(wideRow).click();
  const wideDrawer = drawerOf(wideRow);
  // Each of these resolves to exactly one element (Playwright's strict mode
  // throws otherwise on a plain `.toBeVisible()`), which already proves the
  // column name isn't exposed twice under two different roles.
  await expect(wideDrawer.getByRole("columnheader", { name: "Token" })).toBeVisible();
  await expect(wideDrawer.getByRole("columnheader", { name: "Standings" })).toBeVisible();
  // The label span still exists in the DOM (so no re-render is needed at the
  // breakpoint) but is display:none, so a cell's own accessible content is
  // just its value — not "Token missing" the way the narrow cell's is. A raw
  // substring count over the whole snapshot isn't a safe way to check this:
  // the table row's own computed name is the concatenation of every column
  // header's text ("Name Token Standings Map"), so "Token" legitimately
  // appears in that row-level string once even with no duplication at all.
  // Scoping to the one cell that would carry a duplicate is what actually
  // tests it.
  const wideSnapshot = await wideDrawer.locator(".drawer__crew").ariaSnapshot();
  expect(
    wideSnapshot,
    "the Token cell's own value has no label text mixed in at a wide viewport",
  ).toContain('cell "missing"');
  expect(
    wideSnapshot,
    "a label-prefixed cell value would mean the hidden .crew__label leaked into the accessible name",
  ).not.toContain('cell "Token missing"');
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
  // at rest the first tier button sits inside the pin's x-band and on screen,
  // so an x-only measure — `clearOfPin` — would call it occluded.
  //
  // A threshold rather than ~1: the button's width is its tier's configured
  // label, so the exact fraction moves with TIER_LABEL_MEMBER. Any large
  // majority makes the point that an x-only measure would get this wrong; an
  // equality here only pinned the length of one word.
  // 0.7, not 0.8: ruling R1 (docs/design-walkthrough.md) grew every drawer
  // control from `.btn--micro` to `.btn`, which widens the first tier button
  // too — measured here at 76.7% overlap post-R1, down from >80% pre-R1. The
  // property this proves ("an x-only measure gets this wrong") only needs a
  // large majority, not a specific fraction; 0.7 stays well clear of the
  // ~50% where that claim would stop holding.
  const rest = await coveredByPin(page, ".scroller", tier, 0);
  expect(
    rest.xOverlap,
    "the drawer's first control shares the pin's x-band",
  ).toBeGreaterThan(0.7);
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
  "set tier": '[aria-label="Set Zed to Friends"]',
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
    // Vertical, per control, immediately before measuring — not once for the
    // whole drawer. The region is height-capped against the chrome above it
    // (`.scroller--tall:has(.log--dense)`), and at 320px this drawer is taller
    // than the cap: 786.6px against a 576px region, of which ~157px is the
    // crew table's reflow to stacked blocks and the rest was already there.
    // globals.css blesses exactly that ("a drawer taller than 80svh still
    // scrolls in the region — that is the case where a nested scroll is the
    // honest answer"), so no single scrollTop puts every control on screen at
    // once, and centering the drawer left `set tier` 12px above the region's
    // top edge — a vertical clip failing a test whose every claim is
    // horizontal. `inRegion` is only here to stop `covered: 0` being vacuously
    // true of an off-screen control, so give each control its own scroll.
    // This may move scrollLeft too, which costs nothing: `coveredByPin` sets
    // scrollLeft itself, to the offset under test, on the very next line.
    await page.locator(sel).scrollIntoViewIfNeeded();
    for (const at of offsets) {
      const m = await coveredByPin(page, ".scroller", sel, at);
      expect(m.covered, `${name} is not under the pin at scrollLeft ${at}`).toBe(0);
      expect(m.inRegion, `${name} is on screen at scrollLeft ${at}`).toBeCloseTo(1, 2);
    }
  }
});

/**
 * The region's height cap (`.scroller--tall:has(.log--dense)`) subtracts the
 * chrome above it so the whole thing lands inside the viewport and the page
 * itself never scrolls. That is right for the collapsed table and wrong for an
 * open drawer: the drawer is taller than a row by design, so the cap clipped it
 * mid-crew-table behind a second, inner scrollbar while the page below the
 * region sat empty.
 *
 * The load-bearing assertion is that the drawer *fits* the region, not that the
 * region stops scrolling — on a table this long it still scrolls, and should.
 * The last assertion is what stops the fix from being "delete the cap": the
 * sticky header needs a scroll range to travel over, so a released cap has to
 * still be a cap.
 *
 * Heights are compared against each other rather than against the 436px and
 * 720px they measure today, because both are viewport arithmetic over a chrome
 * measurement the rule's own comment expects to be revisited.
 */
test("an open drawer is not clipped by the region's height cap", async ({
  page,
  context,
}) => {
  const admin = await seedDenseWorld();
  // Enough crew that the drawer is taller than the chrome-subtracted cap, but
  // not so much that it exceeds the 80svh cap itself — this seed has to land
  // INSIDE that window for the test to mean anything, and the window is what
  // the count is calibrated to, not the crew size for its own sake.
  //
  // Was seven alts, chosen when a crew row with no location reading rendered
  // nothing at all. `CharacterLocation` now renders a visible "not reported"
  // badge for `{kind:"never"}` (src/core/location.ts, widened so the account
  // manifest could stop showing one blank for two different facts), and this
  // page is that component's second consumer — so every unplaced alt here got
  // a line taller, at a measured ~63.7px per alt. Seven alts moved the drawer
  // to 777.6px against a 718px region: past the cap, which is the one thing
  // this seed must not do.
  //
  // Five, measured at 1280x900: drawer 650.1px, against closed 434px and open
  // 718px. 216px clear of the lower bound and 68px of the upper, where six
  // measured 713.8px and left just 4.2px — inside the window, but close enough
  // that a font-metric change would push it out and the failure would look
  // like a regression in the cap rather than a seed that was always marginal.
  //
  // NOT a relaxed cap and NOT a relaxed assertion. `globals.css`'s 80svh bound
  // is structural — the sticky header needs a scroll range to travel over, and
  // its own comment blesses this exact case ("a drawer taller than 80svh still
  // scrolls in the region — that is the case where a nested scroll is the
  // honest answer"). The seed is the calibration; the cap is the rule.
  await seedMember(db, {
    name: "Zed Wide",
    alts: ["Alt One", "Alt Two", "Alt Three", "Alt Four", "Alt Five"],
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/admin/accounts");

  const region = () =>
    page.evaluate(() => {
      const sc = document.querySelector(".scroller") as HTMLElement;
      const drawer = sc.querySelector(".drawer-row:not([hidden])");
      return {
        visible: sc.clientHeight,
        content: sc.scrollHeight,
        drawer: drawer ? drawer.getBoundingClientRect().height : 0,
      };
    });

  const closed = await region();
  const row = rowFor(page, "Zed Wide");
  await toggleOf(row).click();
  await expect(drawerOf(row)).toBeVisible();
  const open = await region();

  expect(open.drawer, "the drawer is tall enough to have been clipped").toBeGreaterThan(
    closed.visible,
  );
  expect(
    open.visible,
    "opening a drawer gives the chrome subtraction back",
  ).toBeGreaterThan(closed.visible);
  expect(open.drawer, "an open drawer fits the region it opened in").toBeLessThanOrEqual(
    open.visible,
  );
  expect(
    open.content,
    "the region is still capped, so sticky keeps its range",
  ).toBeGreaterThan(open.visible);
});

/**
 * `.scroller--tall:has(.log--dense)`'s cap is `100svh - 29rem`: 29rem is a
 * fixed CSS-px measurement of the chrome above the table, but `svh` shrinks
 * with browser zoom (a 200% zoom halves the effective viewport in CSS px
 * without touching anything expressed in rem). Past 200% on an ordinary
 * screen the subtraction goes negative and `max(18rem, ...)` floors it — but
 * flat, not scaled: two zoomed-in viewports of different heights both floor
 * to the exact same 18rem, so the region stops answering to the viewport at
 * all. That is the porthole: a fixed-size slot that does not grow even when
 * the (zoomed) viewport pinching it does.
 *
 * Simulated the way the sweep's own note suggests — a viewport at half the
 * CSS-pixel size of a normal one, which is what page zoom does to `svh`
 * without touching `rem`. Two heights below the 29rem/464px chrome floor
 * stand in for two different zoom levels on the same physical screen.
 */
test("the accounts scroller does not floor to the same height at every zoom level", async ({
  page,
  context,
}) => {
  const admin = await seedDenseWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  const visibleHeightAt = async (height: number) => {
    await page.setViewportSize({ width: 640, height });
    await page.goto("/admin/accounts");
    // `.scroller--tall`, not `.scroller`: the page mounts a second, untall
    // Scroller for the drawer's crew table, and the bare class would silently
    // start measuring that one the day the two swap document order.
    await page.waitForSelector(".scroller--tall tbody tr");
    return page.evaluate(
      () => (document.querySelector(".scroller--tall") as HTMLElement).clientHeight,
    );
  };

  // Both heights are under 464px (29rem): the chrome above the table no
  // longer fits the "svh minus chrome" arithmetic at all, which is exactly
  // the regime a 200% zoom produces on an ordinary screen.
  const shorter = await visibleHeightAt(400);
  const taller = await visibleHeightAt(460);

  expect(
    taller,
    "a taller (less-zoomed) viewport must not floor to the same region height as a shorter one",
  ).toBeGreaterThan(shorter);
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
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

  // ...and the message it holds is actually on screen, which is the assertion
  // this test used to be missing. The cell is ~750px wide inside a ~286px
  // scrollport and `text-align: center` centred the text at x≈375 — entirely
  // outside the region, with the start fade deliberately suppressed on
  // sticky-column tables so nothing even cued scrolling to it. `toHaveText`
  // passed the whole time: the text existed, it was just nowhere a reader
  // could get to it. Presence is what let this ship, so measure the box.
  const boxes = await page.evaluate(() => {
    const region = document.querySelector(".scroller") as HTMLElement;
    const text = document.querySelector(".log__empty-text") as HTMLElement;
    const r = region.getBoundingClientRect();
    const t = text.getBoundingClientRect();
    return {
      overlap: Math.max(0, Math.min(r.right, t.right) - Math.max(r.left, t.left)),
      textWidth: t.width,
      textLeft: t.left,
      regionLeft: r.left,
      regionRight: r.right,
      maxScrollLeft: region.scrollWidth - region.clientWidth,
    };
  });
  // The region really does scroll, so "on screen" is a fact about this message
  // and not about a table that happened to fit.
  expect(boxes.maxScrollLeft, "the table is wider than its region").toBeGreaterThan(0);
  expect(
    boxes.overlap,
    "the empty-state message is wholly inside the scroll region at rest",
  ).toBeCloseTo(boxes.textWidth, 0);
  expect(boxes.textLeft, "...and not pushed off to the right of it").toBeLessThan(
    boxes.regionRight,
  );
});

/* --- Row identity -------------------------------------------------------- */

test("an account with no main is still identified in the pinned column", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Aaa Boss", tier: "member", isAdmin: true });
  // Characters linked, no main set: the row the fallback exists for. The row
  // data carries no link order, so the page picks the alphabetically first
  // name — "Sam Alt", not the seed's own first argument.
  await seedMember(db, { name: "Wandering Sam", mainless: true, alts: ["Sam Alt"] });
  // And an account with nothing linked at all, which only the id can name.
  const [orphan] = await db.insert(account).values({ tier: "alumni" }).returning();

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
  await openEveryDrawer(page);
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
  const admin = await seedMember(db, { name: "Aaa Boss", tier: "member", isAdmin: true });
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
  await openEveryDrawer(page);
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
  for (const tier of ["Testers", "Friends", "Veterans"]) {
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
  await zedDrawer
    .getByRole("button", { name: "Set Zed to Friends", exact: true })
    .click();
  // The armed name carries the row too, for the same reason the rest name does:
  // it is the name spoken at the moment of the press that actually commits.
  await zedDrawer
    .getByRole("button", { name: "confirm set Zed to Friends", exact: true })
    .click();
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
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  // A second admin so revoking it doesn't hit the "last admin" guard — this
  // test is about the confirm mechanism, not that error path.
  const zed = await seedMember(db, { name: "Zed", tier: "member", isAdmin: true });
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

/**
 * The other half of the same law, which the arming pass left out.
 *
 * `revoke` has confirmed since that pass; `grant` fired on one click. The
 * asymmetry read as "arm the destructive one", but the reason recorded at
 * `docs/settled-design-decisions.md:32` is about the table, not the verb —
 * it is "too easy to hit a destructive action by accident scanning a dense
 * table" — and `grant` is the half a mis-press cannot take back. The account
 * it lands on can change every tier and revoke every other admin, including
 * the one who slipped.
 *
 * The POST counter is the assertion that matters: "no revoke button yet"
 * would also pass in the window before an in-flight grant re-rendered.
 */
test("grant arms on the first click, confirms on the second, and Escape disarms", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const zed = await seedMember(db, { name: "Zed", tier: "member", isAdmin: false });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  const zedRow = rowFor(page, "Zed");
  const grant = zedRow.getByRole("button", {
    name: "grant admin to Zed",
    exact: true,
  });
  const restBox = await grant.boundingBox();

  async function zedIsAdmin() {
    const [row] = await db.select().from(account).where(eq(account.id, zed.id));
    return row?.isAdmin ?? false;
  }

  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST") posts += 1;
  });

  await grant.click();
  const confirm = zedRow.getByRole("button", { name: /^confirm grant/ });
  await expect(confirm).toBeVisible();
  expect(posts).toBe(0);

  // Arming a constructive action must not repaint it as a destructive one:
  // `revoke` swaps to `.btn--danger` when armed and this deliberately does
  // not, so only the word changes. Width is what the ghost label holds still.
  const armedBox = await confirm.boundingBox();
  expect(armedBox?.width).toBe(restBox?.width);
  await expect(confirm).not.toHaveClass(/btn--danger/);

  await confirm.press("Escape");
  await expect(grant).toBeVisible();
  await expect(zedRow.getByRole("button", { name: /^confirm grant/ })).toHaveCount(0);
  expect(posts).toBe(0);
  expect(await zedIsAdmin()).toBe(false);

  await grant.click();
  await zedRow.getByRole("button", { name: /^confirm grant/ }).click();
  await expect(zedRow.getByRole("button", { name: /^revoke/ })).toBeVisible();
  await expect.poll(zedIsAdmin).toBe(true);
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

test("the filter row's Find and clear match the tier chips they sit beside", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  // `clear` only renders once `q` is set.
  await page.goto("/admin/accounts?q=Boss");

  const find = page.getByRole("button", { name: "Find" });
  const clear = page.getByRole("link", { name: "clear" });
  // A tier chip: the same row, already at the standalone grade, and the thing
  // Find and clear looked short against. Scoped to the tier group because the
  // status group renders an "all" chip of its own.
  const chip = page
    .getByRole("group", { name: "Filter by tier" })
    .getByRole("link", { name: "Queued" });
  await expect(clear).toBeVisible();

  const [findBox, clearBox, chipBox] = await Promise.all([
    find.boundingBox(),
    clear.boundingBox(),
    chip.boundingBox(),
  ]);

  expect(Math.round(chipBox!.height)).toBe(36);
  expect(Math.round(findBox!.height)).toBe(Math.round(chipBox!.height));
  expect(Math.round(clearBox!.height)).toBe(Math.round(chipBox!.height));
});

/**
 * The one standing call to action on this page — the link that routes an admin
 * to the queue waiting for them — was a bare `<a>` dropped into `Notice`'s flex
 * row: no padding, no min-height, no `.btn` grade, and no `.notice a` rule
 * anywhere in globals.css to supply one. Its hit target was the `--t-data`
 * line box, measured at 21.7px tall: under WCAG 2.5.8 (AA)'s 24px floor, and
 * neither of the two hit-target grades DESIGN.md:277-278 permits "and no
 * others". The admin who misses it on a trackpad or a touch screen goes back
 * to hand-filtering `?tier=pending`.
 *
 * Measured against the tier chip rather than against a bare 36, for the same
 * reason the filter-row test above does: the standalone grade is a property of
 * this stylesheet, and asserting the two together says "this is the same size
 * as the controls beside it" — the actual claim — instead of pinning a number
 * that moves if the grade ever does. The literal 36 is kept as well, since a
 * regression that shrank *both* would otherwise pass.
 *
 * The link's own text is asserted elsewhere ("an admin reaches the queue from
 * the count link and approves"), so this is only about the box.
 */
test("the pending-queue link is a standalone-grade target, not a bare line of text", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await seedMember(db, { name: "Waiting Pilot", tier: "pending" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  const queueLink = page.getByRole("link", { name: /awaiting approval/i });
  const chip = page
    .getByRole("group", { name: "Filter by tier" })
    .getByRole("link", { name: "Queued" });
  await expect(queueLink).toBeVisible();

  const [linkBox, chipBox] = await Promise.all([
    queueLink.boundingBox(),
    chip.boundingBox(),
  ]);

  expect(Math.round(chipBox!.height)).toBe(36);
  expect(Math.round(linkBox!.height)).toBe(Math.round(chipBox!.height));
});

/*
 * The Map column (`account-view.ts`'s `mapStatus`, rendered in
 * `admin/accounts/page.tsx`). It had no e2e at all: unit tests cover the
 * desired/observed arithmetic, but nothing proved the four render branches
 * are reachable, or that the two regressions the column was rebuilt to fix
 * stay fixed.
 *
 * All five accounts are asserted from one page load. The column is a
 * comparison between accounts as much as a value per account — "which rows
 * need attention" is read by scanning it — and five separate page loads
 * would each prove a branch while proving nothing about the scan.
 */

/** The 7th column: SORTS (Name, Tier, Cryo, Tier changed) then Tokens, Discord, Map. */
const MAP_CELL = 6;

/** `wandererAclObservation` is keyed by character id, and `seedMember` returns
 *  only the account — so the characters are looked up by name after the fact. */
async function observeCharacters(names: string[]) {
  const rows = await db
    .select({ id: character.id })
    .from(character)
    .where(inArray(character.name, names));
  expect(rows).toHaveLength(names.length);
  await db.insert(wandererAclObservation).values(
    rows.map((c) => ({
      characterId: c.id,
      role: "member",
      observedAt: new Date("2026-08-01T00:00:00Z"),
    })),
  );
}

test("the Map column separates a healthy account from every way it can drift", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });

  // Every character on the ACL, and every character that should be.
  await seedMember(db, { name: "Ok Member", tier: "member", alts: ["Ok Alt"] });
  // Two alts never added to the ACL: the ordinary "there is work to do" case.
  await seedMember(db, {
    name: "Partial Member",
    tier: "member",
    alts: ["Partial Alt One", "Partial Alt Two"],
  });
  // The costly direction, and the one the old `mapCount` reported as healthy:
  // an alumni account still sitting on the ACL after it stopped being a member.
  await seedMember(db, { name: "Stale Alum", tier: "alumni" });
  await seedMember(db, { name: "Clean Alum", tier: "alumni" });
  // The regression the `affiliationInvalid` filter fixed: a biomassed alt is
  // not a contacts target, so it must not hold the account amber forever with
  // nothing an admin could do about it.
  await seedMember(db, {
    name: "Biomassed Member",
    tier: "member",
    alts: ["Biomassed Alt"],
  });
  await db
    .update(character)
    .set({ affiliationInvalid: true })
    .where(eq(character.name, "Biomassed Alt"));

  await observeCharacters([
    "Ok Member",
    "Ok Alt",
    "Partial Member",
    "Stale Alum",
    "Biomassed Member",
  ]);

  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  // Self-check on the index: a column inserted to the left of Map would
  // otherwise turn every assertion below into a silent test of the wrong cell.
  await expect(page.locator(".log--dense > thead th").nth(MAP_CELL)).toHaveText("Map");

  const mapCell = (name: string) => rowFor(page, name).locator("td").nth(MAP_CELL);

  await expect(mapCell("Ok Member")).toHaveText("2/2");
  await expect(mapCell("Ok Member").locator("span")).toHaveClass(/st--ok/);

  await expect(mapCell("Partial Member")).toHaveText("1/3");
  await expect(mapCell("Partial Member").locator("span")).toHaveClass(/st--warn/);

  await expect(mapCell("Stale Alum")).toHaveText("1 extra");
  await expect(mapCell("Stale Alum").locator("span")).toHaveClass(/st--warn/);

  await expect(mapCell("Clean Alum")).toHaveText("off");
  await expect(mapCell("Clean Alum").locator("span")).toHaveClass(/st--off/);

  await expect(mapCell("Biomassed Member")).toHaveText("1/1");
  await expect(mapCell("Biomassed Member").locator("span")).toHaveClass(/st--ok/);

  // Neither drift is destructive, and DESIGN.md reserves `--signal-bad` for
  // acts that destroy something. Asserted rather than assumed: `bad` is the
  // reflex tone for "something is wrong", and this column is exactly where
  // that reflex would land. Scoped to the Map cells — the Tokens column two
  // over does render `bad`, legitimately, and a table-wide count would be
  // asserting on that instead.
  await expect(
    page.locator(`${ROWS} > td:nth-child(${MAP_CELL + 1}) .st--bad`),
  ).toHaveCount(0);
});

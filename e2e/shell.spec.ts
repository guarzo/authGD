import { expect, test } from "@playwright/test";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import { payoutOperation } from "../src/db/schema";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

/**
 * The bug item 4 of the shell critique describes: `NavItem.key` used to be a
 * bare string matched by `===` against `current`, and the member nav keyed
 * items to an arbitrary label ("account") while the admin nav keyed them to
 * the route itself ("/admin/accounts") — two conventions that both
 * typecheck, so a caller mismatch produced silent absence of `aria-current`
 * rather than a compile error. Matching on `href` everywhere makes that
 * mismatch impossible; this asserts the fix actually lands on every route
 * that renders a `SiteHeader`, not just the one it was noticed on.
 */
test("aria-current lands on the right tab on every shell route", async ({
  page,
  context,
}) => {
  // tier member so the payout routes render too — they carry their own nav,
  // built independently of the account and admin ones, and were the first
  // thing to reintroduce exactly the key-vs-href mismatch this test exists
  // for (they passed `current="payouts"` against an `href` of `/payouts`).
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/account");
  await expect(page.getByRole("link", { name: "Your account" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  for (const [path, label, token] of [
    ["/admin/accounts", "Members", "page"],
    ["/admin/audit", "Audit log", "page"],
    ["/admin/sync", "Sync", "page"],
    ["/payouts", "Operations", "page"],
    // `/payouts/new` sits under the Operations tab without being it, so the tab
    // is current-within-the-set rather than the page you are on. Asserting the
    // exact token, not just its presence: "page" here is the bug — a screen
    // reader is told the link's target is this document when it is not.
    ["/payouts/new", "Operations", "true"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: label })).toHaveAttribute(
      "aria-current",
      token,
    );
    // Exactly one tab lit, counted across the whole bar in either token.
    // Asserting only that "Your account" is dark leaves the other two admin
    // tabs unchecked, and a matcher like `i.href.startsWith("/admin")` would
    // then light all three on every admin route with this test still green.
    // Scoped to the nav rather than the document: /admin/accounts' filter chips
    // carry their own, correct, `aria-current="true"` for the selected filter.
    await expect(page.locator(".shell__nav [aria-current]")).toHaveCount(1);
    // And that the tab is actually painted as active. The attribute and the
    // stylesheet are two independent things: `globals.css` matched
    // `[aria-current="page"]` alone until the "true" token existed, which left
    // the section routes correct to a screen reader and unmarked to everyone
    // else. Asserting the hairline rather than the colour — `--ink` is also
    // the hover colour, so text colour alone does not distinguish an active
    // tab from a hovered one, and the critique's own note says the 1px rule is
    // doing necessary work rather than decorating.
    const rule = await page
      .getByRole("link", { name: label })
      .evaluate((el) => getComputedStyle(el, "::after").height);
    expect(rule).toBe("1px");
  }
});

/**
 * The reported symptom, made concrete: before `nav-items.ts`, membership was
 * hand-copied per section rather than derived from the viewer, so an admin
 * standing on `/admin/audit` had no route to `/payouts` anywhere in the
 * chrome — `admin-nav.tsx`'s own `ITEMS` array had never been taught payouts
 * existed. This test seeds the two reaches that actually differ (admin who
 * *is* a payouts reader, admin who is *not* — `isAdmin` and `tier` are
 * orthogonal columns, db/schema.ts) and checks both the account section and
 * the admin section agree on what that viewer can reach, since the rule is a
 * property of the viewer, not of which of the two sections is on screen.
 *
 * Every locator is scoped to `.shell__nav`: `/admin/accounts` renders its own
 * filter chips with their own `aria-current` (see the test above), and
 * `/account` renders body copy that can repeat a nav label.
 */
test("nav membership follows the viewer, not the section", async ({ page, context }) => {
  const adminReader = await seedMember(db, {
    name: "Boss",
    tier: "member",
    isAdmin: true,
  });
  await context.addCookies([await sessionCookieFor(db, adminReader.id)]);

  for (const path of ["/account", "/admin/audit"]) {
    await page.goto(path);
    const nav = page.locator(".shell__nav");
    // All five, in the one fixed order — broadest access first — on both a
    // member surface and an admin surface, for the same admin+member viewer.
    await expect(nav.getByRole("link")).toHaveText([
      "Your account",
      "Operations",
      "Members",
      "Audit log",
      "Sync",
    ]);
  }

  await resetDb(db);

  // The bounce the rule exists to prevent: an admin whose tier is NOT
  // "member" (the default, "alumni", here) cannot read payouts, and the admin
  // section must not render an Operations link that sends them to a redirect.
  const adminNonReader = await seedMember(db, { name: "Warden", isAdmin: true });
  await context.clearCookies();
  await context.addCookies([await sessionCookieFor(db, adminNonReader.id)]);

  await page.goto("/admin/audit");
  const adminNav = page.locator(".shell__nav");
  await expect(adminNav.getByRole("link")).toHaveText([
    "Your account",
    "Members",
    "Audit log",
    "Sync",
  ]);
  await expect(
    adminNav.getByRole("link", { name: "Operations", exact: true }),
  ).toHaveCount(0);

  await resetDb(db);

  // A plain payouts reader, no admin bit at all: sees exactly the two
  // destinations they can prove they reach, none of the three admin ones.
  const plainMember = await seedMember(db, { name: "Pilot", tier: "member" });
  await context.clearCookies();
  await context.addCookies([await sessionCookieFor(db, plainMember.id)]);

  await page.goto("/account");
  const memberNav = page.locator(".shell__nav");
  await expect(memberNav.getByRole("link")).toHaveText(["Your account", "Operations"]);
});

test("the admin header names its own register, and the two navs get distinct accessible names", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/account");
  await expect(page.getByRole("navigation")).toHaveAccessibleName("Main");
  await expect(page.locator(".shell__register")).toHaveCount(0);

  await page.goto("/admin/accounts");
  await expect(page.getByRole("navigation")).toHaveAccessibleName("Admin");
  await expect(page.locator(".shell__register")).toBeVisible();
  // The home mark follows the admin register rather than always going to
  // /account, so it doesn't quietly walk an admin out of the admin section.
  await expect(page.locator(".shell__mark")).toHaveAttribute("href", "/admin/accounts");
});

/**
 * The bar used to take a `measure` prop and track the page's own column, which
 * made it 960px on /account and /payouts/new and 1248px everywhere else — a
 * 144px lateral jump for the seal and the nav on every crossing, including the
 * /payouts -> /payouts/new step a plain member walks in sequence.
 *
 * Asserting the rect rather than the absence of a class name: the class was one
 * of several ways to reintroduce the shift (a `--narrow` variant, a `:has()`
 * rule, a per-page override), and only the geometry is the property that
 * matters. Width alone would also miss a bar that stayed 1248px wide but
 * stopped being centred, so the slack either side is pinned too.
 */
test("the header bar occupies the same rect on every shell route", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1440, height: 900 });

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Header rect",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: admin.id,
    })
    .returning();

  // Every route that renders a SiteHeader and can be reached with a session.
  // `/payouts/new` and `/account` are the two that used to render the narrow
  // bar, so dropping either from this list guts the test.
  const routes = [
    "/account",
    "/admin/accounts",
    "/admin/audit",
    "/admin/sync",
    "/payouts",
    "/payouts/new",
    `/payouts/${op.id}`,
  ];

  const rects: Record<string, { slack: number; width: number }> = {};
  for (const path of routes) {
    await test.step(path, async () => {
      await page.goto(path);
      // Three guards against measuring a bar that isn't the one asked for,
      // because all three failure modes end in a *passing* assertion below:
      // an access redirect lands on /account (bar already 1248), the error
      // boundary renders its own SiteHeader (and this very commit dropped its
      // `measure="narrow"`, so its bar is now exactly 1248 too), and a missing
      // bar makes boundingBox() null — a bare `box!.x` would throw a TypeError
      // naming neither the route nor the reason.
      expect(new URL(page.url()).pathname).toBe(path);
      await expect(page.getByRole("heading", { name: "Something broke" })).toHaveCount(0);
      const bar = page.locator(".shell__bar");
      await expect(bar).toBeVisible();

      const box = (await bar.boundingBox())!;
      // Against the layout viewport, not the hardcoded 1440: nothing sets
      // `scrollbar-gutter: stable`, so a route whose fixtures ever grow past
      // one screenful takes a vertical scrollbar and shifts a centred box's
      // `left` by half its width. Pinning the raw x would then fail for a
      // reason that has nothing to do with the header measure guarded here.
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      rects[path] = {
        slack: Math.round(box.x - (vw - box.width) / 2),
        width: Math.round(box.width),
      };
    });
  }

  // 78rem at the default root font size, centred (zero slack). Spelled out
  // rather than compared to rects["/account"] so a regression that moved
  // *every* route to the narrow measure together still fails here. Keyed off
  // `routes` rather than `Object.keys(rects)` so a route that silently stopped
  // being measured fails as a missing key instead of passing vacuously.
  const expected = { slack: 0, width: 1248 };
  expect(rects).toEqual(Object.fromEntries(routes.map((p) => [p, expected])));
});

/**
 * The same defect one level down, and the one a user actually reported: the bar
 * was fixed but `.page--narrow` still capped the *column* at 60rem, so /account
 * and /payouts/new put their H1 and every section rule 144px right of where the
 * other five routes put theirs, and the header's seal lined up with neither.
 *
 * Measuring `main.page` rather than asserting the absence of `.page--narrow`:
 * the narrow cap can come back as a class, a `:has()` rule, or a per-page
 * override, and only the geometry is the property the reader sees. Both the
 * slack and the width are pinned for the reason the bar test gives — a column
 * that stayed 1248px but stopped being centred is the same bug.
 */
test("the page column occupies the same rect on every shell route", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.setViewportSize({ width: 1440, height: 900 });

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Column rect",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: admin.id,
    })
    .returning();

  // /account and /payouts/new are two of the five routes that carry
  // `page--narrow`; dropping either from this list guts the test.
  const routes = [
    "/account",
    "/admin/accounts",
    "/admin/audit",
    "/admin/sync",
    "/payouts",
    "/payouts/new",
    `/payouts/${op.id}`,
  ];

  const rects: Record<string, { slack: number; width: number }> = {};
  for (const path of routes) {
    await test.step(path, async () => {
      await page.goto(path);
      // Same three guards as the header test above, for the same three reasons:
      // an access redirect, the error boundary's own `main`, and a null box.
      expect(new URL(page.url()).pathname).toBe(path);
      await expect(page.getByRole("heading", { name: "Something broke" })).toHaveCount(0);
      const column = page.locator("main.page");
      await expect(column).toBeVisible();

      const box = (await column.boundingBox())!;
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      rects[path] = {
        slack: Math.round(box.x - (vw - box.width) / 2),
        width: Math.round(box.width),
      };
    });
  }

  // The same 1248px the header bar takes — that identity is the fix. Spelled
  // out rather than compared to rects["/admin/audit"], so a regression moving
  // every route to the narrow measure together still fails here.
  const expected = { slack: 0, width: 1248 };
  expect(rects).toEqual(Object.fromEntries(routes.map((p) => [p, expected])));
});

test("the pending count reaches the admin nav, without renaming the tab", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
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
  await expect(page.locator(".shell__badge")).toHaveText("2 awaiting approval");
  // ...and it is associated with the link, not merely next to it.
  const describedBy = await members.getAttribute("aria-describedby");
  expect(describedBy).toBe("nav-badge-/admin/accounts");

  await resetDb(db);
  const solo = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await context.clearCookies();
  await context.addCookies([await sessionCookieFor(db, solo.id)]);
  await page.goto("/admin/audit");
  await expect(page.locator(".shell__badge")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Members", exact: true }),
  ).not.toHaveAttribute("aria-describedby");
});

/**
 * The badge is computed in the admin LAYOUT, and an approval only revalidates
 * the page beneath it — so the first half asserts the thing that is easy to
 * get wrong: that the count reflects the very action that changed it.
 *
 * The second half is a guard rather than a reproduction. Today it cannot fail:
 * the admin nav renders plain `<a href>` (ui.tsx), and `next/link` appears
 * nowhere outside `/payouts`, so every admin navigation is a full document
 * load and the layout is recomputed each time. Swap those anchors for `Link`
 * and the client Router Cache becomes free to serve the pre-approval layout on
 * the soft navigation that follows — which is exactly when this half starts
 * earning its place. `.click()` on the nav link, never `page.goto()`: a goto
 * would be a fresh document load even after such a swap, and would keep
 * passing through the bug.
 */
test("approving an account updates the nav badge, and the new count carries to the next admin route", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  await seedMember(db, { name: "Waiting One", tier: "pending" });
  await seedMember(db, { name: "Waiting Two", tier: "pending" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  await page.goto("/admin/accounts");
  await expect(page.locator(".shell__badge")).toHaveText("2 awaiting approval");

  const row = page.locator(".log--dense > tbody > tr:not(.drawer-row)", {
    hasText: "Waiting One",
  });
  await row.locator(".row-toggle").click();
  await row
    .locator("xpath=following-sibling::tr[1]")
    .getByRole("button", { name: "Approve as Veterans for Waiting One", exact: true })
    .click();

  // The layout re-ran for the action that changed it.
  await expect(page.locator(".shell__badge")).toHaveText("1 awaiting approval");

  // ...and the corrected count is what the next admin route shows.
  await page.getByRole("link", { name: "Audit log", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/audit/);
  await expect(page.locator(".shell__badge")).toHaveText("1 awaiting approval");
});

test("sign-out ends the session and a subsequent protected request bounces to login", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, { name: "Pilot Prime" });
  const cookie = await sessionCookieFor(db, member.id);
  await context.addCookies([cookie]);
  await page.goto("/account");

  await page.getByRole("button", { name: "sign out" }).click();
  await expect(page).toHaveURL(/\/login/);

  // Replaying the *same* cookie value is the whole point of this assertion.
  // Simply reloading /account after sign-out proves nothing: the response
  // cleared the cookie, so that request bounces for want of a cookie whether
  // or not the row was ever deleted, and the test would pass with endSession
  // stubbed out. Putting the original value back leaves exactly one thing
  // that can still reject it — the session row being gone server-side.
  await context.addCookies([cookie]);
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login/);
});

test("sign-out with no session cookie still lands on login rather than erroring", async ({
  page,
}) => {
  const res = await page.request.post("/auth/signout");
  expect(res.ok()).toBe(true);
  expect(new URL(res.url()).pathname).toBe("/login");
});

/**
 * A type-scale sweep found `.shell__nav a` rendering 33.05px tall against
 * DESIGN.md's documented "two sizes, no others" (36px standalone / 28px
 * in-row). The obvious fixes -- shrinking `padding-block`, or an explicit
 * `height` -- both move the link's box relative to the `[aria-current]::after`
 * underline, which is inset `bottom: var(--s-1)` against the padding box: pull
 * the box up from underneath a fixed inset and the hairline walks toward the
 * label. The fix taken instead reuses `.btn`'s own idiom
 * (`display: inline-flex; align-items: center; min-height: 2.25rem`) rather
 * than hand-picking a padding value: the link becomes a flex container that
 * centres its own text within a 36px floor, so the text moves toward the
 * *middle* of the box and gains clearance from the underline instead of
 * losing it. This pins the geometry so a future padding/height edit that
 * reintroduces the collision fails here instead of shipping.
 */
test("the active nav link reaches the 36px standalone hit-target without the underline touching the label", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Pilot Prime", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  const link = page.getByRole("link", { name: "Your account" });
  await expect(link).toBeVisible();

  const box = (await link.boundingBox())!;
  // 36px, not 33.05 and not 28: the standalone control height DESIGN.md
  // already names, applied here rather than left as an undocumented third
  // size.
  expect(Math.round(box.height)).toBe(36);

  const geometry = await link.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el.firstChild!);
    const text = range.getBoundingClientRect();
    const after = getComputedStyle(el, "::after");
    const rect = el.getBoundingClientRect();
    const underlineTop =
      rect.bottom - parseFloat(after.bottom) - parseFloat(after.height);
    return { textBottom: text.bottom, underlineTop };
  });

  // A real gap, not just "no overlap": the sweep's own measurement (a screenshot
  // plus this same computation) found ~6.5px of clearance after the fix, up
  // from ~5px before it. Floored well under that so sub-pixel font-rendering
  // differences across platforms/CI don't make this flaky, while still
  // catching a regression that removes the gap entirely.
  expect(geometry.underlineTop - geometry.textBottom).toBeGreaterThan(2);
});

/**
 * The sibling half of the test above, and the reason it needs its own: that
 * sweep raised `.shell__nav a` to the 36px grade and left the one control in
 * the bar that is not a link — sign out — at `.btn--quiet .btn--micro`'s 28px.
 * DESIGN.md rations 28px to `.btn--micro` in admin table rows and nowhere
 * else, so the smallest target in the header, on all ten pages that render
 * one, was the button that ends the session.
 *
 * Height and type are asserted together because the fix could trivially have
 * bought the box by dropping `.btn--micro`, which also carries
 * `font-size: var(--t-label)` — the thing that makes sign out read as one of
 * the nav's own labels rather than as a button parked among them.
 * `.shell__signout .btn` overrides the box only, so both must hold: 36px tall,
 * and still the same computed font size as the links beside it.
 */
test("sign out reaches the 36px standalone hit-target without leaving the nav's type register", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Pilot Prime", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  const signout = page.getByRole("button", { name: "sign out" });
  await expect(signout).toBeVisible();

  const box = (await signout.boundingBox())!;
  expect(Math.round(box.height)).toBe(36);

  const link = page.getByRole("link", { name: "Your account" });
  const [signoutFont, linkFont] = await Promise.all([
    signout.evaluate((el) => getComputedStyle(el).fontSize),
    link.evaluate((el) => getComputedStyle(el).fontSize),
  ]);
  expect(signoutFont).toBe(linkFont);
});

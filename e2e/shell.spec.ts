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
  // tier flygd so the payout routes render too — they carry their own nav,
  // built independently of the account and admin ones, and were the first
  // thing to reintroduce exactly the key-vs-href mismatch this test exists
  // for (they passed `current="payouts"` against an `href` of `/payouts`).
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
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
    ["/payouts", "Payouts", "page"],
    // `/payouts/new` sits under the Payouts tab without being it, so the tab
    // is current-within-the-set rather than the page you are on. Asserting the
    // exact token, not just its presence: "page" here is the bug — a screen
    // reader is told the link's target is this document when it is not.
    ["/payouts/new", "Payouts", "true"],
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
  }
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
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
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

import { expect, test } from "@playwright/test";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

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

  for (const [path, label] of [
    ["/admin/accounts", "Members"],
    ["/admin/audit", "Audit log"],
    ["/admin/sync", "Sync"],
    ["/payouts", "Payouts"],
    ["/payouts/new", "Payouts"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: label })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Exactly one, counted across the whole bar. Asserting only that "Your
    // account" is dark leaves the other two admin tabs unchecked, and a
    // matcher like `i.href.startsWith("/admin")` would then light all three
    // on every admin route with this test still green.
    await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
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

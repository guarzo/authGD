import { expect, test } from "@playwright/test";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

test("login page renders the wired error param", async ({ page }) => {
  await page.goto("/login?error=oauth_denied");
  // Next.js dev also renders its own role="alert" route-announcer, so scope
  // to the alert that actually carries our copy.
  await expect(page.getByRole("alert").filter({ hasText: "cancelled" })).toContainText(
    "cancelled",
  );
});

test("unauthenticated /account redirects to login", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login/);
});

test("account page shows characters, main marker, and tier", async ({ page, context }) => {
  const acc = await seedMember(db, { name: "Pilot Prime", tier: "flygd", alts: ["Pilot Alt"] });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByText("Pilot Prime")).toBeVisible();
  await expect(page.getByText("(main)")).toBeVisible();
  await expect(page.getByText("Pilot Alt")).toBeVisible();
  // "flygd" also happens to be STANDINGS_LABEL in the e2e env, which the page
  // renders separately in a footer <code> tag, and again in the tier badge —
  // so scope to the tier field rather than matching the bare word.
  await expect(page.locator("[data-field='tier']")).toContainText("flygd");
});

import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

/**
 * Branding and tier labels, end to end.
 *
 * The values asserted here — `Test Corp`, `Test Ops`, `Veterans` — are set in
 * `playwright.config.ts`'s dev-server env and appear nowhere in `src/`. That is
 * the point: a suite asserting the *defaults* (`authGD` / `Auth` / `Alumni`)
 * would pass just as well against hardcoded strings, which is exactly the bug
 * this configuration could introduce. The defaults are asserted in the unit
 * suite instead, whose env sets none of these vars. Neither half alone proves
 * the wiring; together they do.
 *
 * Five paths, because a brand string reaches the DOM five separately-wired
 * ways and a miss in any one is invisible to the other four: a server-rendered
 * header, the client header inside `AdminNav`, the header's mark URL, the
 * error boundary's header (which renders with no server data at all), and a
 * tier badge.
 */

const WORDMARK = ".shell__wordmark";

test("the server-rendered header shows the configured wordmark", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, {
    name: "Header Reader",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await page.goto("/account");
  await expect(page.locator(WORDMARK)).toContainText("Test Corp");
  await expect(page.locator(WORDMARK)).toContainText("Test Ops");
});

test("the admin header shows it too, through the client context", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, {
    name: "Boss",
    tier: "member",
    status: "active",
    isAdmin: true,
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // AdminNav is a client component: it cannot take server props from its
  // layout and reads `useBrand()` instead. Its own assertion because that is a
  // second wiring, not the same one.
  await page.goto("/admin/accounts");
  await expect(page.locator(WORDMARK)).toContainText("Test Corp");
  await expect(page.locator(WORDMARK)).toContainText("Test Ops");
});

test("the header mark is the configured image, not the default", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, {
    name: "Header Reader",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await page.goto("/account");
  // `/brand/emblem.webp` is a real file but not the mark's default, so this
  // distinguishes "config was read" from "the default was served".
  await expect(page.locator("a.shell__mark img")).toHaveAttribute(
    "src",
    "/brand/emblem.webp",
  );
});

test("the error boundary's header carries the brand as well", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, {
    name: "Link Follower",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  // Same trigger as error-boundary.spec.ts: rename a table the page body reads
  // after its guard, restore it in `finally`. The boundary is the one header
  // that renders with no server data at all.
  await db.execute(sql`ALTER TABLE payout_operation RENAME TO payout_operation_probe`);
  try {
    await page.goto("/payouts");
    await expect(page.getByRole("heading", { name: "Something broke" })).toBeVisible();
    await expect(page.locator(WORDMARK)).toContainText("Test Corp");
    await expect(page).toHaveTitle("Something broke · Test Corp");
  } finally {
    await db.execute(sql`ALTER TABLE payout_operation_probe RENAME TO payout_operation`);
  }
});

test("a tier badge reads its configured label and not the raw enum", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, {
    name: "Boss",
    tier: "member",
    status: "active",
    isAdmin: true,
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await seedMember(db, { name: "Old Timer", tier: "alumni", status: "active" });

  await page.goto("/admin/accounts");
  await expect(page.locator(".tier--alumni").first()).toHaveText("Veterans");
  // The negative half: it fails if a badge renders the raw value beside the
  // label, or if one renderer was missed while another was converted.
  await expect(page.getByText("alumni", { exact: true })).toHaveCount(0);
});

test("the login page shows the configured motto and footer", async ({ page }) => {
  // The only coverage BRAND_MOTTO and BRAND_FOOTER have: both are optional and
  // render nowhere else.
  await page.goto("/login");
  await expect(page.locator(".launch__motto")).toContainText("Test motto line");
  await expect(page.locator(".launch__foot")).toHaveText("Test footer line");
});

import { expect, test } from "@playwright/test";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

async function seedWorld() {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await seedMember(db, { name: "Azzy", tier: "green", status: "cryo" });
  await seedMember(db, { name: "Zed", tier: "flygd" });
  return admin;
}

test("non-admins are redirected away from /admin", async ({ page, context }) => {
  const member = await seedMember(db, { name: "Pleb" });
  await context.addCookies([await sessionCookieFor(db, member.id)]);
  await page.goto("/admin/accounts");
  await expect(page).toHaveURL(/\/login/);
});

test("admin list sorts by name and by tier, and filters cryo", async ({ page, context }) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const mains = page.locator("tbody tr td:first-child summary");
  await expect(mains).toHaveText(["Azzy", "Boss", "Zed"]); // default name asc
  await page.getByRole("link", { name: "Tier", exact: true }).click();
  await expect(mains.first()).toHaveText(/Boss|Zed/); // flygd ranks first
  await page.goto("/admin/accounts?status=cryo");
  await expect(mains).toHaveText(["Azzy"]);
});

test("tier controls: manual set locks; return-to-auto unlocks", async ({ page, context }) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const zedRow = page.locator("tbody tr", { hasText: "Zed" });
  await zedRow.getByRole("button", { name: "blue", exact: true }).click();
  await expect(zedRow.getByText("🔒")).toBeVisible();
  await expect(zedRow.getByText("blue", { exact: false }).first()).toBeVisible();
  await zedRow.getByRole("button", { name: "auto" }).click();
  await expect(zedRow.getByText("🔒")).not.toBeVisible();
});

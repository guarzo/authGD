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

test("admin list sorts by name and by tier, and filters cryo", async ({
  page,
  context,
}) => {
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
  await expect(page.locator("tbody tr td:nth-child(2) button")).toHaveCount(0);
  await expect(page.locator("tbody tr td:nth-child(3) button")).toHaveCount(0);
  const zedRow = page.locator("tbody tr", { hasText: "Zed" });
  await expect(zedRow.locator("td:nth-child(2) .tier")).toHaveText(/flygd/);
  await expect(zedRow.getByRole("button", { name: "blue", exact: true })).toBeHidden();
});

test("the row expander is labelled and reports its state", async ({ page, context }) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const toggle = page.locator("tbody tr", { hasText: "Zed" }).locator("summary");
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
  const zedRow = page.locator("tbody tr", { hasText: "Zed" });
  await zedRow.locator("summary").click();
  await zedRow.getByRole("button", { name: "blue", exact: true }).click();
  await expect(zedRow.getByText("🔒")).toBeVisible();
  await expect(zedRow.locator(".tier")).toHaveText(/blue/);
  // The drawer holds the controls, so it has to survive the revalidation the
  // server action triggers or the next click has nothing to land on.
  await expect(zedRow.locator("details")).toHaveJSProperty("open", true);
  await zedRow.getByRole("button", { name: "auto" }).click();
  await expect(zedRow.getByText("🔒")).not.toBeVisible();
});

// The drawer holds every control for the row, so a server action that collapsed
// it would make each edit cost a re-open. Its open state is React state in
// RowDisclosure rather than the DOM's own `open` attribute, precisely so this
// survives the revalidatePath re-render by design instead of by luck.
test("saving a note keeps the row drawer open and persists the note", async ({
  page,
  context,
}) => {
  const admin = await seedWorld();
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");
  const zedRow = page.locator("tbody tr", { hasText: "Zed" });
  await zedRow.locator("summary").click();
  await expect(zedRow.locator("details")).toHaveJSProperty("open", true);
  await zedRow.getByPlaceholder("notes").fill("watch this one");
  const save = zedRow.getByRole("button", { name: "save note" });
  await save.click();
  // Submit disables itself while the action is in flight; waiting for it to
  // come back is what tells us the write has landed.
  await expect(save).toBeEnabled();
  await expect(zedRow.locator("details")).toHaveJSProperty("open", true);
  // Re-read from the server. Asserting the value on the same input the test
  // just typed into would pass whether or not anything was persisted.
  await page.reload();
  const reloaded = page.locator("tbody tr", { hasText: "Zed" });
  await reloaded.locator("summary").click();
  await expect(reloaded.getByPlaceholder("notes")).toHaveValue("watch this one");
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

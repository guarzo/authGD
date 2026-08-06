import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { character, universeName } from "../src/db/schema";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

const SYSTEM_ID = 31000123;
const STRUCTURE_ID = 1035466617946;

/** Puts every character on an account in a named citadel, as the job would. */
export async function placeCrew(accountId: string) {
  await db
    .insert(universeName)
    .values([
      { id: SYSTEM_ID, kind: "system", name: "J123456" },
      { id: STRUCTURE_ID, kind: "structure", name: "Home Astrahus" },
    ])
    .onConflictDoNothing();
  await db
    .update(character)
    .set({
      locationSystemId: SYSTEM_ID,
      locationStructureId: STRUCTURE_ID,
      locationOnline: true,
      locationCheckedAt: new Date(),
    })
    .where(eq(character.accountId, accountId));
}

// Scoped to the Scroller's own region rather than to `table.log`, which the
// payouts table on the same page also carries.
const manifest = (page: Page) => page.locator("[aria-label='Your characters']");

test("the compressed manifest keeps four columns and an actionable re-authorize", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Pilot Prime", tier: "member" });
  await placeCrew(acc.id);
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  const head = manifest(page).locator("thead > tr > th");
  await expect(head).toHaveCount(4);
  await expect(head.nth(1)).toHaveText("Name");
  await expect(head.nth(2)).toHaveText("Status");

  // The location line sits in the NAME cell, under the name.
  const nameCell = manifest(page).locator("tbody > tr > td").nth(1);
  await expect(nameCell.locator(".char__location")).toHaveText("J123456 — Home Astrahus");

  // The re-authorize remedy is a control, not a chip: seedMember gives the
  // character an empty scope array, so every configured scope is missing and
  // this row is always in the remedy state.
  await expect(manifest(page).getByRole("link", { name: "re-authorize" })).toBeVisible();

  // The dead columns are gone, and the caption no longer names them.
  await expect(page.getByRole("columnheader", { name: "Contacts" })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Map" })).toHaveCount(0);
  await expect(manifest(page).locator("caption")).not.toContainText("CONTACTS column");

  // One manifest-level label, not one per row.
  await expect(page.getByText(/locations .* ago/)).toHaveCount(1);
});

test("a character with no location reading renders no location line", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Unread Pilot", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  await expect(page.getByText("Unread Pilot")).toBeVisible();
  await expect(page.locator(".char__location")).toHaveCount(0);
});

test("the members drawer shows the location line, and the collapsed row does not", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
  const zed = await seedMember(db, { name: "Zed", tier: "member" });
  await placeCrew(zed.id);
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/accounts");

  const zedRow = page.locator(".log--dense > tbody > tr:not(.drawer-row)", {
    hasText: "Zed",
  });
  // Explicitly out of scope in the design: no location rollup on the collapsed
  // row. The drawer's children are not mounted until first open, so this holds
  // for the whole page before any click.
  await expect(page.locator(".char__location")).toHaveCount(0);

  await zedRow.locator(".row-toggle").click();
  const crew = zedRow.locator("xpath=following-sibling::tr[1]").locator(".drawer__crew");
  await expect(crew.locator(".char__location")).toHaveText("J123456 — Home Astrahus");
  await expect(crew).toContainText("Locations as of");
});

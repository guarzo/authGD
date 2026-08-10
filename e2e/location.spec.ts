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

test("the compressed manifest drops its dead columns and keeps an actionable re-authorize", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Pilot Prime", tier: "member" });
  await placeCrew(acc.id);
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  // Three, not the four this test asserted when ACTIONS was an unconditional
  // column: `seedMember` gives one character, who is the main, so that row has
  // neither `make main` (gated on `!isMain`) nor `unlink` (gated on crew size),
  // and the header is elided along with the empty cells. Asserted below by name
  // as well as by count, so a future column arriving under a different name
  // can't quietly restore the four.
  const head = manifest(page).locator("thead > tr > th");
  await expect(head).toHaveCount(3);
  await expect(head.nth(1)).toHaveText("Name");
  await expect(head.nth(2)).toHaveText("Status");
  await expect(manifest(page).getByRole("columnheader", { name: "Actions" })).toHaveCount(
    0,
  );

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

// Was "renders no location line". The redesign's P0 replaced that blank with
// an explicit badge, because a blank was also what an elided "with main" row
// rendered — two states, one pixel-identical output. `.char__location` is
// still absent (the badge is a `.st`, not that class), but the row now says
// something, and asserting only the absence would let the badge be deleted
// without failing anything.
test("a character with no location reading says 'not reported'", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Unread Pilot", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  await expect(page.getByText("Unread Pilot")).toBeVisible();
  await expect(page.locator(".char__location")).toHaveCount(0);
  await expect(manifest(page).getByText("not reported")).toHaveCount(1);
});

// Task 3 put "last seen " in a `.visually-hidden` span, gated on `offline`
// alone — a deliberate trade where a screen reader got more words than a
// sighted user saw. The manifest redesign reverses that trade under R4
// (information may not live only in the assistive-tech channel): both facts
// are now visible text, "last seen " ahead of an offline reading and a
// trailing "(stale)" on a stale-but-online one, with `.dim` still shared
// between them because "true, but not now" is the one thing they have in
// common. Nothing else in this file exercises the offline branch — every
// other seed hardcodes `locationOnline: true`.
test("an offline location says 'last seen'; a merely stale one says '(stale)'", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, {
    name: "Offline Pilot",
    tier: "member",
    alts: ["Stale Pilot"],
  });
  const crew = await db.select().from(character).where(eq(character.accountId, acc.id));
  const offlineId = crew.find((c) => c.name === "Offline Pilot")!.id;
  const staleId = crew.find((c) => c.name === "Stale Pilot")!.id;

  await db
    .insert(universeName)
    .values([
      { id: SYSTEM_ID, kind: "system", name: "J123456" },
      { id: STRUCTURE_ID, kind: "structure", name: "Home Astrahus" },
    ])
    .onConflictDoNothing();

  const now = new Date();
  // Offline, checked just now: the case the hidden span exists for.
  await db
    .update(character)
    .set({
      locationSystemId: SYSTEM_ID,
      locationStructureId: STRUCTURE_ID,
      locationOnline: false,
      locationCheckedAt: now,
    })
    .where(eq(character.id, offlineId));
  // Online, but checked long enough ago (> LOCATION_CADENCE_MS = 15 minutes,
  // src/core/location.ts:6) relative to the offline character's reading that
  // `locationFreshness` marks it stale too — a different fact from
  // "offline" that happens to share the `.dim` visual treatment
  // (character-location.tsx:13-17). This character must NOT get the hidden
  // "last seen" text: it is genuinely where the line says it is right now.
  await db
    .update(character)
    .set({
      locationSystemId: SYSTEM_ID,
      locationStructureId: STRUCTURE_ID,
      locationOnline: true,
      locationCheckedAt: new Date(now.getTime() - 20 * 60 * 1000),
    })
    .where(eq(character.id, staleId));

  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  const rows = manifest(page).locator("tbody tr");
  const offlineLocation = rows
    .filter({ hasText: "Offline Pilot" })
    .locator(".char__location");
  const staleLocation = rows
    .filter({ hasText: "Stale Pilot" })
    .locator(".char__location");

  // Asserted as visible text, and asserted that no `.visually-hidden` span
  // survives anywhere in the line: the R4 fix is only done if the fact moved
  // channels rather than being duplicated into both.
  await expect(offlineLocation).toContainText("last seen ");
  await expect(offlineLocation.locator(".visually-hidden")).toHaveCount(0);
  await expect(offlineLocation).not.toContainText("(stale)");
  await expect(offlineLocation).toHaveClass(/\bdim\b/);

  // "last seen" would assert this character has moved on; it has not, only the
  // timestamp is old. So the stale-but-online line keeps its own word.
  await expect(staleLocation).toContainText("(stale)");
  await expect(staleLocation).not.toContainText("last seen");
  await expect(staleLocation.locator(".visually-hidden")).toHaveCount(0);
  await expect(staleLocation).toHaveClass(/\bdim\b/);
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

/**
 * Coverage boundary: Playwright runs with `SYNC_MODE: "dry-run"`
 * (playwright.config.ts), and dry-run makes `getFreshAccessToken` return
 * before any network call — refreshing during a dry run would rotate and
 * destroy a real refresh token. So no e2e test here can reach an ESI fetch;
 * neither job can populate a roster or send an alert under this harness. That
 * behaviour is already proven in tests/ against real Postgres (Tasks 8 and 9).
 * What this file covers instead: the state cascade's sentences, designation
 * via the server action, and the roster/events tables rendering from rows
 * seeded directly into Postgres — plus the nav entry's visibility.
 */
import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { character, structure, structureHolder } from "../src/db/schema";
import { NOTIFICATIONS_SCOPE, STRUCTURES_SCOPE } from "../src/lib/esi/client";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();

test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

const CORP = 98_000_321;

test("an admin with no holder is asked to grant", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Vela Kaine", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/structures");

  await expect(page.getByRole("main")).toContainText("No character has granted");
});

test("a seeded roster renders most-alarming-first", async ({ page, context }) => {
  const admin = await seedMember(db, { name: "Vela Kaine", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  const holderCharacterId = admin.mainCharacterId!;
  await db
    .update(character)
    .set({
      scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
      tokenStatus: "valid",
      corporationId: CORP,
    })
    .where(eq(character.id, holderCharacterId));
  await db.insert(structureHolder).values({
    id: 1,
    characterId: holderCharacterId,
    corporationId: CORP,
    designatedBy: "e2e",
  });
  const now = new Date();
  await db.insert(structure).values([
    {
      structureId: 1001,
      corporationId: CORP,
      typeId: 1,
      typeName: "Astrahus",
      systemId: 30_000_142,
      name: "Alpha Keep",
      state: "shield_vulnerable",
      observedAt: now,
    },
    {
      structureId: 1002,
      corporationId: CORP,
      typeId: 2,
      typeName: "Fortizar",
      systemId: 30_000_142,
      name: "Bravo Keep",
      state: "hull_reinforce",
      observedAt: now,
    },
    {
      structureId: 1003,
      corporationId: CORP,
      typeId: 3,
      typeName: "Athanor",
      systemId: 30_000_142,
      name: "Charlie Refinery",
      state: "anchoring",
      observedAt: now,
    },
  ]);
  await page.goto("/admin/structures");

  const rows = page
    .getByRole("region", { name: "Structure roster" })
    .locator("tbody > tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("hull");
});

test("designating a holder through the server action clears the ask", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Vela Kaine", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  const holderCharacterId = admin.mainCharacterId!;
  await db
    .update(character)
    .set({
      scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
      tokenStatus: "valid",
      corporationId: CORP,
    })
    .where(eq(character.id, holderCharacterId));

  await page.goto("/admin/structures");
  await expect(page.getByRole("main")).toContainText(
    "granted structure access but is not",
  );
  await page.getByRole("button", { name: "Designate as holder" }).click();

  await expect(page.getByRole("main")).not.toContainText("is not the holder");
});

test("corp-changed shows the designate form and never a second primary action", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Vela Kaine", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  const holderCharacterId = admin.mainCharacterId!;
  await db
    .update(character)
    .set({
      scopes: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
      tokenStatus: "valid",
      corporationId: CORP,
    })
    .where(eq(character.id, holderCharacterId));
  await db.insert(structureHolder).values({
    id: 1,
    characterId: holderCharacterId,
    corporationId: CORP,
    designatedBy: "e2e",
  });
  // The character leaves the pinned corp after designation — this is what
  // produces corp-changed, distinct from the holder never existing.
  await db
    .update(character)
    .set({ corporationId: CORP + 1 })
    .where(eq(character.id, holderCharacterId));

  await page.goto("/admin/structures");

  await expect(page.getByRole("button", { name: "Designate as holder" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check now" })).toHaveCount(0);
});

test("Structures appears in the admin nav and not for a plain member", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Vela Kaine", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  await page.goto("/admin/structures");
  await expect(
    page.locator(".shell__nav").getByRole("link", { name: "Structures" }),
  ).toBeVisible();

  await resetDb(db);
  const member = await seedMember(db, { name: "Rane Solette", tier: "member" });
  await context.clearCookies();
  await context.addCookies([await sessionCookieFor(db, member.id)]);
  await page.goto("/account");
  await expect(
    page.locator(".shell__nav").getByRole("link", { name: "Structures" }),
  ).toHaveCount(0);
});

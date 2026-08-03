import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { account, syncRun } from "../src/db/schema";
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

test("account page shows characters, main marker, and tier", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, {
    name: "Pilot Prime",
    tier: "flygd",
    alts: ["Pilot Alt"],
  });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByText("Pilot Prime")).toBeVisible();
  await expect(page.getByText("(main)")).toBeVisible();
  await expect(page.getByText("Pilot Alt")).toBeVisible();
  // "flygd" also happens to be STANDINGS_LABEL in the e2e env, which the page
  // renders again in the contacts note now attached to the STANDINGS column —
  // so scope to the tier field rather than matching the bare word.
  await expect(page.locator("[data-field='tier']")).toContainText("flygd");
});

test("the contacts note describes the column and only shows where it explains something", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, {
    name: "Synced Main",
    tier: "blue",
    alts: ["Unsynced Alt"],
  });
  // Only the main has ever synced, so the alt's never-run state is one the note
  // explains and the note earns its space above the manifest.
  await db.execute(sql`
    insert into contact_sync_state (character_id, last_result, last_synced_at)
    select id, 'ok', now() from "character" where name = 'Synced Main'
  `);
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  // It hangs off the column header as an accessible description, not as a
  // standing footnote at the foot of the page, and not as a title attribute
  // that no keyboard user could ever summon.
  await expect(page.getByRole("columnheader", { name: "Standings" })).toHaveAttribute(
    "aria-describedby",
    "contacts-note",
  );
  const note = page.locator("#contacts-note");
  await expect(note).toHaveText(/authGD owns the flygd contact label/);
  await expect(page.locator("[title]")).toHaveCount(0);
  await expect(page.locator(".footnote")).toHaveCount(0);

  // Visible, once, above the table — not repeated inside the cells.
  await expect(note).toHaveClass(/table-note/);
  await expect(page.locator(".log").getByText(/managed automatically/)).toHaveCount(0);

  // With every row healthy it stops being visible copy but stays in the
  // accessible tree, so the header description never goes away.
  await db.execute(sql`
    insert into contact_sync_state (character_id, last_result, last_synced_at)
    select id, 'ok', now() from "character" where name = 'Unsynced Alt'
  `);
  await page.reload();
  await expect(page.locator("#contacts-note")).toHaveClass(/visually-hidden/);
  await expect(page.getByRole("columnheader", { name: "Standings" })).toHaveAttribute(
    "aria-describedby",
    "contacts-note",
  );
});

test("unlink is quiet at rest and lands on one vertical with make main", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, {
    name: "Pilot Prime",
    tier: "green",
    alts: ["Pilot Alt"],
  });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  // The main's row carries only UNLINK; the alt's carries MAKE MAIN + UNLINK.
  // Both UNLINKs must still share a right edge, or the column stops reading as
  // a column.
  const edges = await page
    .getByRole("button", { name: "unlink" })
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
  expect(edges).toHaveLength(2);
  expect(edges[0]).toBe(edges[1]);

  // Demoted from --signal-bad: at rest it matches the neutral quiet grade that
  // "make main" uses, and only takes the red on hover or keyboard focus.
  const [unlinkColor, makeMainColor] = await Promise.all([
    page
      .getByRole("button", { name: "unlink" })
      .first()
      .evaluate((e) => getComputedStyle(e).color),
    page
      .getByRole("button", { name: "make main" })
      .first()
      .evaluate((e) => getComputedStyle(e).color),
  ]);
  expect(unlinkColor).toBe(makeMainColor);

  await page.getByRole("button", { name: "unlink" }).first().focus();
  await expect
    .poll(() =>
      page
        .getByRole("button", { name: "unlink" })
        .first()
        .evaluate((e) => getComputedStyle(e).color),
    )
    .not.toBe(makeMainColor);
});

test("last pushed reports per surface, with an unlinked Discord called out", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Pilot Prime", tier: "flygd" });
  // Contacts has pushed; wanderer has not. Discord is not linked at all, which
  // is a different state from "the job has not run" and must read differently.
  await db.insert(syncRun).values({
    jobType: "contacts",
    status: "ok",
    finishedAt: new Date(Date.now() - 12 * 60 * 1000),
  });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  const pushed = page.locator("dl.facts").last();
  await expect(page.getByRole("heading", { name: "Last pushed" })).toBeVisible();
  await expect(pushed).toContainText("12m ago");
  await expect(pushed).toContainText("not yet run"); // map: scheduled, never run
  await expect(pushed).toContainText("not linked"); // discord: nothing to push
  // The cadence is knowable even for the surfaces that have never run.
  await expect(pushed.getByText(/^next \d\d:\d\d$/).first()).toBeVisible();
});

test("last pushed is omitted entirely before any character is linked", async ({
  page,
  context,
}) => {
  // An account with nothing linked has nothing being pushed for it; three
  // "not yet run" rows would read as a broken system rather than an empty one.
  const [acc] = await db.insert(account).values({ tier: "green" }).returning();
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Last pushed" })).toHaveCount(0);
});

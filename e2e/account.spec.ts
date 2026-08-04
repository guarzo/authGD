import { expect, test } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { account, character, syncRun } from "../src/db/schema";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

test("login page renders the wired error param", async ({ page }) => {
  await page.goto("/login?error=oauth_denied");
  // Next.js dev also renders its own role="alert" route-announcer, so scope
  // to the alert that actually carries our copy.
  await expect(
    page.getByRole("alert").filter({ hasText: "No access was granted" }),
  ).toContainText("No access was granted");
});

// Every code the callbacks can redirect to /login with. A code with no entry in
// the ERRORS map renders nothing at all, which is the one failure mode this
// page cannot show the member, so each is checked by name.
for (const [code, phrase] of [
  ["oauth_expired", "expired before you finished"],
  ["oauth_failed", "EVE couldn't be reached"],
  ["session_expired", "Your session ended"],
] as const) {
  test(`login page explains ?error=${code}`, async ({ page }) => {
    await page.goto(`/login?error=${code}`);
    await expect(page.getByRole("alert").filter({ hasText: phrase })).toBeVisible();
  });
}

// An unknown code must degrade to the plain page, never an empty alert box.
test("login page ignores an unrecognised error code", async ({ page }) => {
  await page.goto("/login?error=not_a_real_code");
  await expect(page.locator(".notice--bad")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /log in with eve online/i })).toBeVisible();
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
    tier: "flygd",
    alts: ["Unsynced Alt"],
  });
  // FLYGD, because only a FLYGD account's characters are contacts targets at
  // all — the note explains a column that says nothing to anyone else. Only the
  // main has ever synced, so the alt's never-run state is one the note explains
  // and the note earns its space above the manifest.
  await db.execute(sql`
    insert into contact_sync_state (character_id, last_result, last_synced_at)
    select id, 'ok', now() from "character" where name = 'Synced Main'
  `);
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  // It hangs off the column header as an accessible description, not as a
  // standing footnote at the foot of the page, and not as a title attribute
  // that no keyboard user could ever summon.
  await expect(page.getByRole("columnheader", { name: "Contacts" })).toHaveAttribute(
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
  await expect(page.getByRole("columnheader", { name: "Contacts" })).toHaveAttribute(
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

test("unlink arms on the first click, confirms on the second, and Escape disarms", async ({
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

  const altRow = page.locator("tr", { hasText: "Pilot Alt" });
  const unlink = altRow.getByRole("button", { name: "unlink", exact: true });
  const restBox = await unlink.boundingBox();

  // A server action is a POST to the current route. Counting them is the only
  // assertion that actually proves the first click never reached the server —
  // "the row is still visible" would also pass in the window before an
  // in-flight unlink came back and re-rendered without it.
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST") posts += 1;
  });

  await unlink.click();
  const confirm = altRow.getByRole("button", { name: /^confirm unlink/ });
  await expect(confirm).toBeVisible();
  expect(posts).toBe(0);

  // The label swap alone must not jitter the row.
  const armedBox = await confirm.boundingBox();
  expect(armedBox?.width).toBe(restBox?.width);

  // Escape disarms without a reload.
  await confirm.press("Escape");
  await expect(altRow.getByRole("button", { name: "unlink", exact: true })).toBeVisible();
  await expect(altRow.getByRole("button", { name: /^confirm unlink/ })).toHaveCount(0);
  expect(posts).toBe(0);
  // And the roster genuinely still holds both characters, read from the
  // database rather than from the page that would be rendering it. Asserted
  // here rather than while armed: a query is slow enough to race the arm's own
  // revert timer, and the disarmed state is the stable one to read from.
  expect(
    await db.select().from(character).where(eq(character.accountId, acc.id)),
  ).toHaveLength(2);

  // Arm again and confirm: the second click is the one that actually unlinks.
  await unlink.click();
  await altRow.getByRole("button", { name: /^confirm unlink/ }).click();
  await expect(page.getByText("Pilot Alt")).toHaveCount(0);
  expect(
    await db.select().from(character).where(eq(character.accountId, acc.id)),
  ).toHaveLength(1);
});

test("last pushed reports per surface, and drops Discord when it isn't linked", async ({
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

  // Scoped per row: a container-wide toContainText would pass even if the three
  // states landed on the wrong surfaces.
  const row = (label: string) => pushed.locator(`dt:text-is("${label}") + dd`);
  // JOB_CRON: contacts is hourly :05, wanderer hourly :10. Asserting the
  // minute proves the row reads its own job's cadence, not just any cadence.
  await expect(row("Standings")).toContainText("12m ago");
  await expect(row("Standings")).toContainText(/next \d\d:05$/);
  await expect(row("Map")).toContainText("not yet run"); // scheduled, never run
  await expect(row("Map")).toContainText(/next \d\d:10$/);
  // Nothing to push, so the row is dropped entirely rather than shown as an
  // inert "not linked" token: STANDING above already states the same fact
  // with the fix (Link Discord) attached, ~800px away.
  await expect(pushed.locator("dt:text-is('Discord')")).toHaveCount(0);

  // The "next" column lines up across rows despite the states differing in
  // width, which is the whole point of reserving a column for them.
  const nextEdges = await pushed
    .locator(".push__next")
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(nextEdges).toHaveLength(2);
  expect(nextEdges[0]).toBe(nextEdges[1]);
});

test("a blue member is not told their first sync is pending", async ({
  page,
  context,
}) => {
  // The contacts job only ever writes FLYGD members' contact lists, so a blue
  // member accrues no per-character result and never will. Reading that
  // absence as "not yet run" told most of the corp their first sync was
  // pending, permanently.
  const acc = await seedMember(db, { name: "Blue Pilot", tier: "blue" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByText("First sync has not run yet")).toHaveCount(0);
  // Scoped to the manifest: "not yet run" is still the truthful state for a
  // JOB that has never fired, which is what the LAST PUSHED rows report here.
  // The claim being fixed is the per-character one.
  await expect(page.getByRole("table").getByText("not yet run")).toHaveCount(0);
  // The account-level answer still shows: the standing is being pushed, and
  // this is where the member can see when.
  await expect(page.getByRole("heading", { name: "Last pushed" })).toBeVisible();
  // The contact-label note stays in the accessible tree as the column's
  // description, but it is not visible copy: authGD writes no contact label on
  // a blue member's characters, so there is nothing for it to explain.
  await expect(page.locator("#contacts-note")).toHaveClass(/visually-hidden/);
});

test("a flygd member still sees the first-run notice", async ({ page, context }) => {
  // The notice is correct here and must survive: this account has a target
  // character, and it has no recorded result yet.
  const acc = await seedMember(db, { name: "Flygd Pilot", tier: "flygd" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  await expect(page.getByText("First sync has not run yet")).toBeVisible();
  // The label note applies to this account, so it becomes visible copy.
  await expect(page.locator("#contacts-note")).toHaveClass(/table-note/);
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

test("unlinking a character that already left the account lands on a styled notice, not the error boundary", async ({
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

  const altRow = page.locator("tr", { hasText: "Pilot Alt" });
  const unlink = altRow.getByRole("button", { name: "unlink" });
  await expect(unlink).toBeVisible();

  // Simulate the race the action's pre-check exists for: the character leaves
  // this account (a transfer reclaim, or a second click already unlinking it)
  // between this render and the click below, without going through
  // unlinkAction so the page's own pre-check is what has to catch it.
  await db.delete(character).where(eq(character.name, "Pilot Alt"));

  // First click arms rather than fires; this exercises the actual unlink
  // submission, so it has to confirm.
  await unlink.click();
  await unlink.click();
  await expect(page).toHaveURL(/error=stale_character/);
  await expect(
    page.getByRole("alert").filter({ hasText: "isn't on this account anymore" }),
  ).toBeVisible();
});

import { expect, test } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import {
  account,
  character,
  discordLink,
  payoutOperation,
  payoutParticipant,
  syncRun,
} from "../src/db/schema";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

// Every code the callbacks can redirect to /login with, checked by name: a code
// with no entry in the ERRORS map renders nothing at all, which is the one
// failure mode this page cannot show the member.
//
// `tone` is asserted alongside the copy because the two are one decision. Only a
// genuine fault renders `bad`; a member who clicked cancel on EVE's consent
// screen and a session cookie reaching its TTL are neither of them broken
// (PRODUCT.md principle 4). Notice derives its role from that tone — `bad` is
// assertive, everything else polite — so the role is the observable proxy for
// it, and pinning both here stops a future tone edit from silently flipping how
// urgently AT interrupts on a non-fault.
for (const [code, phrase, tone] of [
  ["oauth_denied", "No access was granted", "info"],
  ["oauth_expired", "expired before you finished", "bad"],
  ["oauth_failed", "EVE couldn't be reached", "bad"],
  ["session_expired", "Your session ended", "info"],
] as const) {
  test(`login page explains ?error=${code} in the ${tone} tone`, async ({ page }) => {
    await page.goto(`/login?error=${code}`);
    // Next.js dev also renders its own role="alert" route-announcer, so scope
    // to the node that actually carries our copy rather than to the role alone.
    const notice = page.locator("p.notice").filter({ hasText: phrase });
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("role", tone === "bad" ? "alert" : "status");
    await expect(notice).toHaveClass(tone === "bad" ? /notice--bad/ : /^notice$/);
  });
}

// An unknown code must degrade to the plain page. The notice is now mounted
// unconditionally so its live region is registered before any text arrives, so
// what has to hold is that the empty slot is inert: no tone class, no glyph,
// nothing drawn — and `role="status"`, not `alert`. Notice takes its role from
// the tone and not from whether the slot has text, so an empty slot in the bad
// tone would put an assertive region on the app's front door on every ordinary
// visit. Checked here and on the no-code path below, because those are the two
// ways to reach an empty slot.
test("login page ignores an unrecognised error code", async ({ page }) => {
  await page.goto("/login?error=not_a_real_code");
  await expect(page.locator(".notice--bad")).toHaveCount(0);
  await expect(page.locator("p.notice")).toHaveCount(0);
  const slot = page.locator("p.notice-slot");
  await expect(slot).toHaveCount(1);
  await expect(slot).toHaveText("");
  await expect(slot).not.toHaveAttribute("data-glyph", /./);
  await expect(slot).toHaveAttribute("role", "status");
  await expect(page.getByRole("link", { name: /log in with eve online/i })).toBeVisible();
});

test("login page with no error code carries an inert, polite slot", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("p.notice")).toHaveCount(0);
  const slot = page.locator("p.notice-slot");
  await expect(slot).toHaveCount(1);
  await expect(slot).toHaveText("");
  await expect(slot).toHaveAttribute("role", "status");
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

test("the contacts note describes the column via a table caption, and shows visible prose only where it explains something", async ({
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

  // The note lives in a <caption>, announced for the table as a whole — a
  // keyboard/screen-reader user reaches it whether they land on the header or
  // any cell in the CONTACTS column, unlike a `<th>`'s aria-describedby, which
  // only ever reached the header.
  const caption = page.locator("table.log caption");
  await expect(caption).toHaveText(/authGD owns the flygd contact label/);
  await expect(caption).toHaveClass(/visually-hidden/);
  await expect(page.locator("[title]")).toHaveCount(0);
  await expect(page.locator(".footnote")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Contacts" })).not.toHaveAttribute(
    "aria-describedby",
  );

  // Visible, once, above the table — not repeated in the rows. Scoped to
  // `tbody`, not `.log`: the caption is now inside the table and says these
  // very words on purpose, so a table-wide check would match it.
  const visibleNote = page.locator("p.table-note", { hasText: "authGD owns the" });
  await expect(visibleNote).toBeVisible();
  await expect(page.locator(".log tbody").getByText(/managed automatically/)).toHaveCount(
    0,
  );

  // With every row healthy the visible copy goes away, but the caption — a
  // standing property of the column, not news — never does.
  await db.execute(sql`
    insert into contact_sync_state (character_id, last_result, last_synced_at)
    select id, 'ok', now() from "character" where name = 'Unsynced Alt'
  `);
  await page.reload();
  await expect(page.locator("p.table-note", { hasText: "authGD owns the" })).toHaveCount(
    0,
  );
  await expect(page.locator("table.log caption")).toHaveText(
    /authGD owns the flygd contact label/,
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

test("sync schedule reports per surface, and drops Discord when it isn't linked", async ({
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
  await expect(page.getByRole("heading", { name: "Sync schedule" })).toBeVisible();

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
  // JOB that has never fired, which is what the SYNC SCHEDULE rows report here.
  // The claim being fixed is the per-character one.
  await expect(page.getByRole("table").getByText("not yet run")).toHaveCount(0);
  // The account-level answer still shows: the standing is being pushed, and
  // this is where the member can see when.
  await expect(page.getByRole("heading", { name: "Sync schedule" })).toBeVisible();
  // The contact-label note stays in the accessible tree as the whole table's
  // caption, but it is not visible copy: authGD writes no contact label on a
  // blue member's characters, so there is nothing for it to explain.
  await expect(page.locator("table.log caption")).toHaveClass(/visually-hidden/);
  await expect(page.locator("p.table-note", { hasText: "authGD owns the" })).toHaveCount(
    0,
  );
});

test("a flygd member still sees the first-run notice", async ({ page, context }) => {
  // The notice is correct here and must survive: this account has a target
  // character, and it has no recorded result yet.
  const acc = await seedMember(db, { name: "Flygd Pilot", tier: "flygd" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  await expect(page.getByText("First sync has not run yet")).toBeVisible();
  // This account has no Discord link, and the notice renders directly above
  // the "Link Discord" button. Promising roles here would tell the member the
  // one step they still owe is already taken care of.
  await expect(page.getByRole("status")).toContainText("Discord roles start once you");
  await expect(page.getByRole("link", { name: "Link Discord" })).toBeVisible();
  // The label note applies to this account, so it becomes visible copy above
  // the table, in addition to the caption that is always in the accessible tree.
  await expect(
    page.locator("p.table-note", { hasText: "authGD owns the" }),
  ).toBeVisible();
});

test("the first-run notice promises Discord roles once Discord is linked", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Linked Pilot", tier: "flygd" });
  await db.insert(discordLink).values({
    accountId: acc.id,
    discordUserId: "606060606060606060",
  });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  // Scoped to the Notice itself: a linked account now also renders the
  // Discord unlink control's own always-mounted status live region
  // (confirm-submit.tsx), so a bare getByRole("status") matches both.
  await expect(page.locator("p.notice")).toContainText(
    "Standings, map access and Discord roles",
  );
  await expect(page.getByRole("link", { name: "Link Discord" })).toHaveCount(0);
});

test("a member can unlink their own Discord", async ({ page, context }) => {
  const member = await seedMember(db, { name: "Pilot", tier: "green" });
  await db.insert(discordLink).values({
    accountId: member.id,
    discordUserId: "duid-e2e",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await page.goto("/account");
  // Two clicks by design: ConfirmSubmit arms first, submits second.
  await page.getByRole("button", { name: "unlink Discord", exact: true }).click();
  await page.getByRole("button", { name: "confirm unlink Discord", exact: true }).click();

  await expect(page.getByRole("link", { name: "Link Discord" })).toBeVisible();
  expect(await db.select().from(discordLink)).toHaveLength(0);
});

test("a pending member is told their access is awaiting approval", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Pending Pilot", tier: "pending" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  // Scoped to the Standing row's own field rather than a bare page-wide text
  // match: the word "pending" also appears in the first-sync copy elsewhere on
  // this page, and the claim here is about the tier value specifically.
  const standing = page.locator("[data-field='tier']");
  await expect(standing).toContainText("pending");
  await expect(standing).toContainText("awaiting approval from an admin");

  // Not a fault. DESIGN.md reserves warning colour for the admin table and
  // PRODUCT.md's "nothing reads as punishment" applies hardest here — the
  // member has done nothing wrong and is waiting on someone else — so this must
  // not arrive as a bad/warn Notice.
  await expect(page.locator(".notice--bad, .notice--warn")).toHaveCount(0);
});

test("sync schedule is omitted entirely before any character is linked", async ({
  page,
  context,
}) => {
  // An account with nothing linked has nothing being pushed for it; three
  // "not yet run" rows would read as a broken system rather than an empty one.
  const [acc] = await db.insert(account).values({ tier: "green" }).returning();
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sync schedule" })).toHaveCount(0);
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

/**
 * Reading your own history needs only a session; reading an OPERATION needs
 * tier flygd. A member demoted out of flygd still gets the answer to "did I
 * get paid for that Thursday roam" — as plain text, because a link would
 * silently redirect them straight back to this page.
 */
test("a member who is no longer flygd sees their payout row with no link to the operation", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "flygd",
    status: "active",
  });
  const member = await seedMember(db, { name: "Demoted Pilot", tier: "green" });

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Thursday roam",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      status: "finalized",
      createdBy: operator.id,
    })
    .returning();
  await db.insert(payoutParticipant).values({
    operationId: op.id,
    accountId: member.id,
    displayName: "Demoted Pilot",
    shares: "1",
    amount: "450000.00",
  });

  await context.addCookies([await sessionCookieFor(db, member.id)]);
  await page.goto("/account");

  const row = page.getByRole("row").filter({ hasText: "Thursday roam" });
  // Grouped by fmtIsk, as everywhere else this page prints an amount. The
  // operation pages under /payouts still print the raw numeric(20,2) string —
  // adopting fmtIsk there belongs to whoever owns those tables.
  await expect(row).toContainText("450,000.00 ISK");
  await expect(row).toContainText("unpaid");
  // The name is there; the link is not.
  await expect(row.getByRole("link")).toHaveCount(0);
  // And the nav offers no way in either — same tier gate, one control up.
  await expect(page.getByRole("link", { name: "Payouts" })).toHaveCount(0);
});

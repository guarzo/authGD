import { expect, test, type Page } from "@playwright/test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  account,
  character,
  contactSyncState,
  discordLink,
  payoutOperation,
  payoutParticipant,
  syncRun,
  universeName,
} from "../src/db/schema";
import type { ContactSyncResult } from "../src/core/contact-result";
import { pinGeometry, rowHeights } from "./geometry";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

// The scopes playwright.config.ts grants EVE_SSO_SCOPES, mirrored here rather
// than imported: a character's `scopes` column is what account-view.ts diffs
// against that config to decide `needsReauthForScopes`, so a manifest row only
// reads as a healthy token when it holds every one of these.
const ALL_SCOPES = [
  "esi-characters.read_contacts.v1",
  "esi-characters.write_contacts.v1",
  "esi-ui.open_window.v1",
  "esi-location.read_location.v1",
  "esi-universe.read_structures.v1",
  "esi-location.read_online.v1",
];

/** Marks every character on this account token-valid with a full scope grant,
 *  the manifest row precondition every "collapses to ok" test below needs —
 *  `seedMember` leaves `tokenStatus` at its "missing" default, which alone
 *  reads as needing attention. */
async function markTokensHealthy(accountId: string) {
  await db
    .update(character)
    .set({ tokenStatus: "valid", scopes: ALL_SCOPES })
    .where(eq(character.accountId, accountId));
}

/** Puts named characters (by id) somewhere named, so the name cell's location
 *  line actually renders (mirrors location.spec.ts's placeCrew). Takes ids
 *  rather than an account, so a test can leave one alt without a location
 *  reading as an in-page one-line reference row. */
async function placeCrew(
  characterIds: number[],
  systemId: number,
  structureName: string,
) {
  const structureId = systemId + 1_000_000_000;
  await db
    .insert(universeName)
    .values([
      { id: systemId, kind: "system", name: `J${systemId}` },
      { id: structureId, kind: "structure", name: structureName },
    ])
    .onConflictDoNothing();
  await db
    .update(character)
    .set({
      locationSystemId: systemId,
      locationStructureId: structureId,
      locationOnline: true,
      locationCheckedAt: new Date(),
    })
    .where(inArray(character.id, characterIds));
}

/** Ten characters, all token-healthy, all contacts-`ok`, all located: the shape
 *  the density design was measured against, and the only seed whose row heights
 *  and fold counts mean anything.
 *
 *  `contactSyncState` is seeded per character rather than left null on purpose.
 *  A targeted character with a null result makes `firstSyncPending` true
 *  (account-health.ts:173-174), which mounts a Notice ABOVE the manifest and
 *  pushes every row down — a seed that skipped this measured 696px of chrome
 *  against the 539px a real nominal account renders. */
async function seedNominalCrew(name = "Pilot Prime") {
  const acc = await seedMember(db, {
    name,
    tier: "member",
    alts: [
      "Alt Pilot One",
      "Alt Pilot Two",
      "Alt Pilot Three",
      "Alt Pilot Four",
      "Alt Pilot Five",
      "Alt Pilot Six",
      "Alt Pilot Seven",
      "Alt Pilot Eight",
      "Alt Pilot Nine",
    ],
  });
  await markTokensHealthy(acc.id);
  const crew = await db.select().from(character).where(eq(character.accountId, acc.id));
  await db
    .insert(contactSyncState)
    .values(crew.map((c) => ({ characterId: c.id, lastResult: "ok" as const })));
  await placeCrew(
    crew.map((c) => c.id),
    30000142,
    "Home Astrahus",
  );
  return acc;
}

/** Faults one named character so it can never classify `ok`, which makes the
 *  exception-only STATUS column render and leaves an `ok` row's own chip
 *  assertable.
 *
 *  Scoped to one account, not keyed by name alone: `resetDb` runs before every
 *  test, but a single test may seed more than one account (see the demoted-member
 *  payout test), and character names are not unique across them. An unscoped
 *  update would fault a second account's identically-named character silently —
 *  invisible here, and visible only as an unrelated test's mystery failure.
 *  `rowCount` is asserted for the same reason it is in `faultContacts` below: a
 *  name that matches nothing updates zero rows and leaves the STATUS column out
 *  of the DOM, which is the healthy layout passing a test written for a faulted
 *  one.
 *
 *  The main character stays first in the manifest (account-view.ts orders
 *  main, then alts by name), so `tbody tr:first-child` is still the ok row. */
async function faultOneAlt(accountId: string, altName: string) {
  const updated = await db
    .update(character)
    .set({ tokenStatus: "invalid" })
    .where(and(eq(character.accountId, accountId), eq(character.name, altName)));
  expect(updated.rowCount).toBe(1);
}

/** Faults named characters through their *contacts* result rather than their
 *  token, which is what makes them classify `attention` and render the full
 *  three-line STATUS stack. `faultOneAlt` above sets `tokenStatus` instead,
 *  which also mounts the column but fills the token line with the
 *  `re-authorize` control; both shapes are wanted, for different tests.
 *
 *  The result is a parameter because the STATUS column is content-sized and
 *  every code renders a different string, so "a faulted crew" is not one
 *  width but a range. Measured at 320px, forced scroll, the member-fixable
 *  codes (MEMBER_FIXABLE in account-health.ts, the ones that classify
 *  `attention`) run 275px for `label_mismatch` to 299px for `needs_reauth`.
 *  A geometry test must name which one it means and seed the widest, or it
 *  reports the narrowest case as though it were the column's worst.
 *
 *  Asserts the update actually hit every name: a typo silently updates zero
 *  rows, and a seed that faults nobody leaves the exception-only STATUS column
 *  out of the DOM entirely — which is the healthy layout, passing a width
 *  budget for the one reason the budget exists to rule out. Account-scoped for
 *  the reason given on `faultOneAlt`; without it the count would also be
 *  satisfiable by two half-matches across two accounts.
 *
 *  Separate from `faultOneAlt`, which faults the *token*: the two reach
 *  `attention` by different routes and only this one satisfies
 *  `hasContactRemedy`, so only this one gives a row remedy prose to render. */
async function faultContacts(
  accountId: string,
  names: string[],
  result: ContactSyncResult,
) {
  const updated = await db
    .update(contactSyncState)
    .set({ lastResult: result })
    .where(
      inArray(
        contactSyncState.characterId,
        db
          .select({ id: character.id })
          .from(character)
          .where(and(eq(character.accountId, accountId), inArray(character.name, names))),
      ),
    );
  expect(updated.rowCount).toBe(names.length);
}

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
    tier: "member",
    alts: ["Pilot Alt"],
  });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByText("Pilot Prime")).toBeVisible();
  await expect(page.getByText("(main)")).toBeVisible();
  // Exact: the character also appears as the `<strong>{name}:</strong>` prefix
  // on a set-as-main note when one is due for it (account/page.tsx), so a
  // substring match here is ambiguous about which element it found.
  await expect(page.getByText("Pilot Alt", { exact: true })).toBeVisible();
  // STANDINGS_LABEL is "authgd" in the e2e env, which the page echoes.
  await expect(page.locator("[data-field='tier']")).toContainText("Testers");
});

test("the contacts note describes the column via a table caption, and shows visible prose only where it explains something", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, {
    name: "Synced Main",
    tier: "member",
    alts: ["Unsynced Alt"],
  });
  // MEMBER, because only a member account's characters are contacts targets at
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
  // any cell in the STATUS column, unlike a `<th>`'s aria-describedby, which
  // only ever reached the header.
  const caption = page.locator("table.log caption");
  await expect(caption).toHaveText(/authGD owns the authgd contact label/);
  await expect(caption).toHaveClass(/visually-hidden/);
  await expect(page.locator("[title]")).toHaveCount(0);
  await expect(page.locator(".footnote")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Status" })).not.toHaveAttribute(
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
    /authGD owns the authgd contact label/,
  );
});

test("unlink is quiet at rest and lands on one vertical with the main control", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, {
    name: "Pilot Prime",
    tier: "alumni",
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
      // Named per character, like `unlink` beside it: nine buttons all
      // announcing a bare "main" gives a screen-reader or speech-input member
      // the word with no object, in the one place they cannot see which row
      // they are on. The visible "main" is contained in this name, which is
      // what WCAG 2.5.3 label-in-name requires.
      .getByRole("button", { name: "make Pilot Alt main" })
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
    tier: "alumni",
    alts: ["Pilot Alt"],
  });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  const altRow = page.locator("tr", { hasText: "Pilot Alt" });
  // Named, not bare "unlink": the character rows carry a `restName` of
  // "unlink <character>" so a screen-reader or speech-input member reaching the
  // control out of visual context is told which character it unlinks.
  const unlink = altRow.getByRole("button", { name: "unlink Pilot Alt", exact: true });
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
  await expect(
    altRow.getByRole("button", { name: "unlink Pilot Alt", exact: true }),
  ).toBeVisible();
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
  const acc = await seedMember(db, { name: "Pilot Prime", tier: "member" });
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

test("an associate is not told their first sync is pending", async ({
  page,
  context,
}) => {
  // The contacts job only ever writes MEMBER accounts' contact lists, so an
  // associate accrues no per-character result and never will. Reading that
  // absence as "not yet run" told most of the corp their first sync was
  // pending, permanently.
  const acc = await seedMember(db, { name: "Associate Pilot", tier: "associate" });
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
  // associate member's characters, so there is nothing for it to explain.
  await expect(page.locator("table.log caption")).toHaveClass(/visually-hidden/);
  await expect(page.locator("p.table-note", { hasText: "authGD owns the" })).toHaveCount(
    0,
  );
});

test("a member still sees the first-run notice", async ({ page, context }) => {
  // The notice is correct here and must survive: this account has a target
  // character, and it has no recorded result yet.
  const acc = await seedMember(db, { name: "Member Pilot", tier: "member" });
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
  const acc = await seedMember(db, { name: "Linked Pilot", tier: "member" });
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

/**
 * The Discord row says which account is linked, not just that one is. The
 * display name leads because it is what the member is called by the people they
 * play with; the @handle follows because it is what settles it when two people
 * go by the same nickname.
 *
 * Each half is independent — a member with no guild nickname and no global name
 * has only a handle, and a link made before the first roles sync has only a
 * handle too — so this walks all three shapes rather than the happy one. The
 * both-null case renders what shipped before either column existed: the unlink
 * control alone, which is why no backfill has to run before this is correct.
 */
test("the Discord row names the linked account, in whatever detail it has", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, { name: "Pilot", tier: "member" });
  await db.insert(discordLink).values({
    accountId: member.id,
    discordUserId: "duid-names",
    username: "guarzo",
    displayName: "Wardec Wally",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  const identity = page.locator(".discord-id");
  await page.goto("/account");
  await expect(identity).toHaveText("Wardec Wally@guarzo");

  // Handle but no display name: a link that has not been through a roles sync.
  await db.update(discordLink).set({ displayName: null });
  await page.reload();
  await expect(identity).toHaveText("@guarzo");

  // Neither. The row falls back to the control on its own.
  await db.update(discordLink).set({ username: null });
  await page.reload();
  await expect(identity).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "unlink Discord", exact: true }),
  ).toBeVisible();
});

test("a member can unlink their own Discord", async ({ page, context }) => {
  const member = await seedMember(db, { name: "Pilot", tier: "alumni" });
  await db.insert(discordLink).values({
    accountId: member.id,
    discordUserId: "duid-e2e",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await page.goto("/account");
  // The control has to say what it costs before it is pressed, not after: the
  // unlink strips every managed Discord role. Asserted through the button's
  // own aria-describedby rather than as loose page text, because the text is
  // only useful if it reaches a member who tabbed straight to the button —
  // it sits AFTER the control in reading order, so the association is the
  // whole point of it.
  const unlink = page.getByRole("button", { name: "unlink Discord", exact: true });
  const describedBy = await unlink.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  const cost = page.locator(`#${describedBy}`);
  await expect(cost).toContainText("Queues removal of the Discord roles authGD manages");

  // Present for AT from the start (above), but hidden from sighted readers
  // until the action is armed: a permanent explanation of an action almost
  // nobody takes does not belong on a page whose job is to show state.
  // Measured rather than asserted with toBeHidden(): `.visually-hidden` is a
  // 1px clip, not display:none, so Playwright counts it visible by design —
  // that is exactly what keeps it readable to a screen reader.
  const restWidth = (await cost.boundingBox())?.width ?? 0;
  expect(restWidth).toBeLessThanOrEqual(1);

  // Two clicks by design: ConfirmSubmit arms first, submits second.
  await unlink.click();
  await expect
    .poll(async () => (await cost.boundingBox())?.width ?? 0)
    .toBeGreaterThan(1);
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

  // Scoped to the meta line's tier field rather than a bare page-wide text
  // match: the word "pending" also appears in the first-sync copy elsewhere on
  // this page, and the claim here is about the tier value specifically. The
  // tier reads as its configured label ("Queued" in the e2e env), which is the
  // half a page-wide match could not tell from the unconfigured word.
  const standing = page.locator("[data-field='tier']");
  await expect(standing).toContainText("Queued");
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
  const [acc] = await db.insert(account).values({ tier: "alumni" }).returning();
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sync schedule" })).toHaveCount(0);
});

test("the manifest caption does not claim every character is healthy when there are none", async ({
  page,
  context,
}) => {
  // The caption's no-STATUS-column sentence is chosen by `showStatusColumn`,
  // which is a `.some()` over the characters — false for an empty crew as
  // readily as for a healthy one. Without its own branch the table would tell
  // a screen-reader user that every character is healthy on an account that
  // has no characters at all.
  const [acc] = await db.insert(account).values({ tier: "alumni" }).returning();
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  const caption = manifest(page).locator("caption");
  await expect(caption).toContainText("No characters are linked yet");
  await expect(caption).not.toContainText("Every character is healthy");
});

test("unlinking a character that already left the account lands on a styled notice, not the error boundary", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, {
    name: "Pilot Prime",
    tier: "alumni",
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
 * tier member. A member demoted out of member still gets the answer to "did I
 * get paid for that Thursday roam" — as plain text, because a link would
 * silently redirect them straight back to this page.
 */
test("a demoted member sees their payout row with no link to the operation", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Prime",
    tier: "member",
    status: "active",
  });
  const member = await seedMember(db, { name: "Demoted Pilot", tier: "alumni" });

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

test("a healthy character collapses to a single ok chip", async ({ page, context }) => {
  // Alumni: untargeted, so the only way this row could still expand is a bad
  // token — ruled out by markTokensHealthy below.
  const acc = await seedMember(db, {
    name: "Healthy Pilot",
    tier: "alumni",
    alts: ["Faulted Alt"],
  });
  await markTokensHealthy(acc.id);
  // A companion the column exists for: STATUS renders only when at least one
  // character is not `ok`, so an all-ok seed would leave this test asserting a
  // chip that correctly does not exist — and its `.status-line` count of 0
  // would pass for want of a cell rather than for want of expansion.
  await faultOneAlt(acc.id, "Faulted Alt");
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  const row = page.locator("table tbody tr").first();
  await expect(row.locator("[data-state='ok']")).toBeVisible();
  await expect(row.locator(".status-line")).toHaveCount(0);
});

test("a member-fixable result expands only its own row", async ({ page, context }) => {
  const acc = await seedMember(db, {
    name: "Main Pilot",
    tier: "member",
    alts: ["Alt Pilot"],
  });
  await markTokensHealthy(acc.id);
  const [alt] = await db.select().from(character).where(eq(character.name, "Alt Pilot"));
  await db.insert(contactSyncState).values({
    characterId: alt.id,
    lastResult: "missing_label",
  });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  // `:not(.drawer-row)` because a faulted character now renders a second `<tr>`
  // holding its remedy. Scoped rather than counted up to 3: the pin below only
  // works if this counts character rows, and a bare 3 would pass whether or not
  // it did.
  const rows = page.locator("table tbody tr:not(.drawer-row)");
  // Pinned so the two filtered assertions below can't both pass by matching
  // zero rows — `hasNotText` counting 0 `.status-line` proves nothing if the
  // filter itself matched nothing.
  await expect(rows).toHaveCount(2);
  // Three, not two: the `attention` arm keeps all three of today's existing
  // status lines (token / standings / map) verbatim. Expanding is the change,
  // not what an expanded row contains.
  await expect(
    rows.filter({ hasText: "label needed" }).locator(".status-line"),
  ).toHaveCount(3);
  // The neighbour must not have been dragged open with it.
  await expect(
    rows.filter({ hasNotText: "label needed" }).locator(".status-line"),
  ).toHaveCount(0);
});

// The case an earlier draft of the spec got wrong in both directions, so it is
// asserted on both axes: not expanded, and not claiming ok.
test("dry_run stays one line and never reads ok", async ({ page, context }) => {
  const acc = await seedMember(db, { name: "Dry Run Pilot", tier: "member" });
  await markTokensHealthy(acc.id);
  await db.insert(contactSyncState).values({
    characterId: acc.mainCharacterId!,
    lastResult: "dry_run",
  });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  const row = page.locator("table tbody tr").first();
  await expect(row.locator(".status-line")).toHaveCount(0);
  await expect(row.locator("[data-state='stalled']")).toContainText("sync disabled");
  await expect(row.locator("[data-state='ok']")).toHaveCount(0);
});

// The rule most likely to be "helpfully" broken by a later change.
test("map off alone does not expand a row", async ({ page, context }) => {
  // Alumni and no wanderer_acl_observation row at all: legitimately off the
  // map, and there is nothing this member could do about it from this page.
  const acc = await seedMember(db, {
    name: "Grounded Pilot",
    tier: "alumni",
    alts: ["Faulted Alt"],
  });
  await markTokensHealthy(acc.id);
  // A companion the column exists for: STATUS renders only when at least one
  // character is not `ok`, so an all-ok seed would leave this test asserting a
  // chip that correctly does not exist — and its `.status-line` count of 0
  // would pass for want of a cell rather than for want of expansion.
  await faultOneAlt(acc.id, "Faulted Alt");
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  const row = page.locator("table tbody tr").first();
  await expect(row.locator(".status-line")).toHaveCount(0);
  await expect(row.locator("[data-state='ok']")).toBeVisible();
});

// The alumni rows above are all untargeted. This is the ordinary production
// row — a member account whose contacts job has actually synced — and the
// only case where the collapsed chip's aria-label runs `standingsSummary`
// through `contactStateToken("ok")` rather than one of its two bespoke
// strings.
test("a targeted character with a synced result also collapses to ok", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, {
    name: "Synced Pilot",
    tier: "member",
    alts: ["Faulted Alt"],
  });
  await markTokensHealthy(acc.id);
  // A companion the column exists for: STATUS renders only when at least one
  // character is not `ok`, so an all-ok seed would leave this test asserting a
  // chip that correctly does not exist — and its `.status-line` count of 0
  // would pass for want of a cell rather than for want of expansion.
  await faultOneAlt(acc.id, "Faulted Alt");
  await db.insert(contactSyncState).values({
    characterId: acc.mainCharacterId!,
    lastResult: "ok",
  });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  const row = page.locator("table tbody tr").first();
  await expect(row.locator("[data-state='ok']")).toBeVisible();
  await expect(row.locator(".status-line")).toHaveCount(0);
  // Distinguishes this from the alumni tests above: an untargeted regression
  // would still show a bare "ok" chip, but its aria-label would read
  // "standings — not managed" instead of running the synced result through
  // `contactStateToken`.
  expect(await row.locator("[data-state='ok']").getAttribute("aria-label")).toMatch(
    /standings ok/,
  );
});

// Density must not be bought from screen-reader users: the collapsed chip's
// accessible name still carries all three facts.
test("the collapsed chip names token, standings and map", async ({ page, context }) => {
  const acc = await seedMember(db, {
    name: "Nameable Pilot",
    tier: "alumni",
    alts: ["Faulted Alt"],
  });
  await markTokensHealthy(acc.id);
  // A companion the column exists for: STATUS renders only when at least one
  // character is not `ok`, so an all-ok seed would leave this test asserting a
  // chip that correctly does not exist — and its `.status-line` count of 0
  // would pass for want of a cell rather than for want of expansion.
  await faultOneAlt(acc.id, "Faulted Alt");
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  const chip = page.locator("table tbody tr").first().locator("[data-state='ok']");
  const label = await chip.getAttribute("aria-label");
  expect(label).toMatch(/token/i);
  expect(label).toMatch(/standings/i);
  expect(label).toMatch(/map/i);
  expect(label).toMatch(/off/i);
});

// The name/chip pair is most likely to diverge on a stalled row, since its
// chip text comes from `contactStateToken` while the name is built alongside
// it in `standingsSummary` — a second, independent call.
test("a stalled chip's accessible name also carries the standings fact", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Stalled Pilot", tier: "member" });
  await markTokensHealthy(acc.id);
  await db.insert(contactSyncState).values({
    characterId: acc.mainCharacterId!,
    lastResult: "dry_run",
  });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");
  const chip = page.locator("table tbody tr").first().locator("[data-state='stalled']");
  const label = await chip.getAttribute("aria-label");
  expect(label).toMatch(/token/i);
  expect(label).toMatch(/standings/i);
  expect(label).toMatch(/sync disabled/i);
  expect(label).toMatch(/map/i);
});

// Scoped to the Scroller's own region, as location.spec.ts's `manifest`
// helper does: the payouts table on this same page (page.tsx renders it after
// the manifest, once seeded) shares `table tbody tr`, so an unscoped selector
// is only safe as long as no test below seeds a payout — which a future test
// here could quietly do.
const MANIFEST = "[aria-label='Your characters']";
const manifest = (page: Page) => page.locator(MANIFEST);

// 320px is this project's narrowest supported viewport (see the 320x720/900
// calls throughout admin.spec.ts and audit.spec.ts).
const NARROWEST = 320;

// Task 4 originally put name and location on one line — the design's
// riskiest step, since the name column sets the manifest's width and a
// structure name is member-supplied and can be long. That one-line layout is
// NOT what ships: see the CSS comment above `.char-line` (globals.css:1580)
// for the full account. In short, a flex row sums the
// name's width and the location's own (up to `.char__location`'s 22rem)
// instead of the stacked layout's `max(name, location)`, and at 320px that
// cost 203-267px of additional forced horizontal scroll against a 286px-wide
// scroll region — close to a full extra screen of blind scrolling to reach
// STATUS/ACTIONS. The plan's documented fallback was taken: `.char-line` is
// now the same stacked layout `.stack` is, two lines per character.
//
// The one-line prohibition is now guarded by two properties instead of a
// height band: the pitch ceiling at the end of this file (a flex row is one
// line, but the horizontal cost is what made it unshippable) and the
// ten-character horizontal gate below (413px flex vs ~137px stacked). What
// remains in these two tests is the location text itself — that the seed and
// the component actually render it — which every geometry test in this file
// depends on and none of them re-proves.
//
// A DOM count of zero `.status-line`s (the assertion style used elsewhere in
// this file) proves nothing about how many text lines a row wraps to, so
// these measure rendered row height instead — and derive the one-line
// reference from an in-page sibling row rather than a hardcoded constant, so
// the baseline can't go stale the way a number copied from a deleted scratch
// spec would.

test("characters with a location render the location text", async ({ page, context }) => {
  const acc = await seedMember(db, {
    name: "Main Pilot",
    tier: "alumni",
    alts: [
      // Sorts alphabetically first among the alts (account-view.ts:258-265
      // orders main first, then alts by name), so it lands at row index 1 —
      // right after main — regardless of how many other alts there are.
      // Left without a location reading on purpose: this is the in-page
      // one-line reference the other rows are measured against.
      "AAA No-Location Alt",
      "Alt Pilot One",
      "Alt Pilot Two",
      "Alt Pilot Three",
      "Alt Pilot Four",
      "Alt Pilot Five",
      "Alt Pilot Six",
      "Alt Pilot Seven",
      "Alt Pilot Eight",
      "Alt Pilot Nine",
    ],
  });
  await markTokensHealthy(acc.id);
  const crew = await db.select().from(character).where(eq(character.accountId, acc.id));
  const locatedIds = crew
    .filter((c) => c.name !== "AAA No-Location Alt")
    .map((c) => c.id);
  await placeCrew(locatedIds, 30000142, "Home Astrahus");
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  const rows = manifest(page).locator("tbody tr");
  await expect(rows).toHaveCount(11);
  // Fix 1: prove the seed actually put a location on the ten rows this test
  // claims render it — a bare row/column count passes just as well whether or
  // not the location text itself rendered.
  const locationTexts = await rows
    .filter({ hasNotText: "AAA No-Location Alt" })
    .locator(".char__location")
    .allTextContents();
  expect(locationTexts).toHaveLength(10);
  for (const t of locationTexts) expect(t).toBe("J30000142 — Home Astrahus");
});

test("a long structure name renders in full at the narrowest viewport", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, {
    name: "Vanity Pilot",
    tier: "alumni",
    alts: ["AAA No-Location Alt"],
  });
  await markTokensHealthy(acc.id);
  // No " - " in this name, so `shortenDock` (src/core/location.ts) returns it
  // unshortened: the realistic long case Task 3's shortening does not help,
  // and the stress-test case this test and the horizontal one below exist for.
  await placeCrew(
    [acc.mainCharacterId!],
    30000144,
    "Someone's Extremely Long Vanity Keepstar Name",
  );
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.setViewportSize({ width: NARROWEST, height: 900 });
  await page.goto("/account");

  const rows = manifest(page).locator("tbody tr");
  await expect(rows.first().locator(".char__location")).toHaveText(
    "J30000144 — Someone's Extremely Long Vanity Keepstar Name",
  );
});

// This is the design's actual gate: the
// vertical one above cannot fail by construction — `.char` is nowrap
// (globals.css:1551) and `.char__location` is nowrap + ellipsis + a 22rem cap
// (globals.css:1567-1578), so no string at any viewport wraps to a third
// line. The real, measured cost of a long name is horizontal, and this test
// is what forced the plan's documented fallback: reverting `.char-line` to
// the stacked layout it now is. If a future change reintroduces the flex row
// (see the CSS comment above `.char-line`, globals.css:1580, for the
// superseded attempt's numbers), this trips before the
// horizontal cost ships again.
test("a long structure name does not blow out the forced horizontal scroll at 320px", async ({
  page,
  context,
}) => {
  // A ten-character account, not a single character: the previous seed
  // measured this gate's threshold at a size no real account has. Placed on
  // the main alone so the stress case (an unshortened, member-supplied
  // structure name) still survives against the other nine nominal rows.
  const acc = await seedNominalCrew("Vanity Pilot");
  await placeCrew(
    [acc.mainCharacterId!],
    30000144,
    "Someone's Extremely Long Vanity Keepstar Name",
  );
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.setViewportSize({ width: NARROWEST, height: 900 });
  await page.goto("/account");

  // Fix 1 (round 2): this test is the load-bearing gate, so it needs its own
  // proof the seed actually rendered a location — the other two tests would
  // catch a broken seed too, but only as `h - reference` collapsing to ~0,
  // which reads as "the flex row came back," misdirecting the diagnosis.
  await expect(
    manifest(page).locator("tbody tr").first().locator(".char__location"),
  ).toHaveText("J30000144 — Someone's Extremely Long Vanity Keepstar Name");

  const pinned = await pinGeometry(
    page,
    MANIFEST,
    // Third cell, which is now ACTIONS: the STATUS column renders only on
    // exception and this seed is all-ok. The ratio below is a shape check
    // either way; `maxScrollLeft` is the actual gate.
    "tbody tr:first-child td:nth-child(3)",
    "right",
  );
  // House style (e2e/audit.spec.ts:1124), kept for shape — but this holds
  // just as true under the flex row (the ACTIONS cell's width and the
  // region's clientWidth are both unaffected by what the name column does),
  // so it is not a second independent check. `maxScrollLeft` below is the
  // actual gate.
  //
  // 0.6, not 0.5: on a ten-character account the main row's ACTIONS cell
  // holds a lone `unlink` button (no `main` button on main's own row) at
  // ~155px against this viewport's ~286px region — 0.54 — where the old
  // one-character seed never rendered `unlink` at all (`view.characters.length
  // > 1` gates it) and measured a bare STATUS chip instead. Still comfortably
  // a minority of the region; 0.6 both holds today and would still catch the
  // cell growing to dominate the row.
  expect(pinned.cellWidth / pinned.regionWidth).toBeLessThan(0.6);
  // Rules out "nothing to scroll at all" reading as success (e.g. if the
  // seed silently failed to render a location and the name column shrank
  // enough that nothing forces scroll) — a passing 0 would be exactly as
  // vacuous as the count-only check Fix 1 above replaced.
  expect(pinned.maxScrollLeft).toBeGreaterThan(0);
  // Measured on a ten-character account, which is the size this gate exists
  // for — the previous 250 was derived from a one-character seed and never
  // checked at scale. Today's stacked layout measures 258px before this plan
  // and ~137px after (STATUS column −82, `make main` → `main` −39). 170 sits
  // above the latter and far below the 413px the reverted flex row cost, so
  // this trips if the flex row or either removed column comes back.
  //
  // Not zero, and it cannot be: the floor is a 64px portrait plus a 196px name
  // cell plus a bare unlink cell at ~121px = 381px against a 286px region. No
  // arrangement that keeps a portrait, a name and an unlink fits 320px.
  expect(pinned.maxScrollLeft).toBeLessThan(170);
});

// The gate above measures a healthy crew, and a healthy crew is the case that
// does not need it: `showStatusColumn` (src/app/account/page.tsx) is
// exception-only, so on an all-ok seed the widest column in the manifest is not
// in the DOM at all. The member who actually has to reach STATUS and ACTIONS is
// the member with something wrong, and that is the layout nothing measured.
//
// `needs_reauth`, not `missing_label`, and the choice is the point. The STATUS
// column is content-sized, so its width is the rendered width of whichever
// string the seed happens to pick, and the member-fixable codes span 24px:
//
//   label_mismatch  "label wrong"     275px forced scroll
//   missing_label   "label needed"    283px
//   token_invalid   "token invalid"   291px
//   missing_scope   "scope missing"   291px
//   needs_reauth    "re-auth needed"  299px
//
// A gate seeded with `missing_label` passes at 283px and says nothing about
// the 299px a `needs_reauth` member is actually served. Seeding the widest is
// what makes this a bound rather than a sample.
//
// Two faulted characters, not one: one is enough to mount the column, but the
// widest cell is the `attention` stack, and seeding two proves the width comes
// from the stack rather than from whichever single row happened to be first.
// A third is faulted through its *token* instead, which renders the
// `re-authorize` control in the token line — the one grid item with a border
// box, and so the one that showed the `justify-items` default stretching it to
// the standings chip's width.
test("a faulted character does not blow out the forced horizontal scroll at 320px", async ({
  page,
  context,
}) => {
  const acc = await seedNominalCrew();
  await faultContacts(acc.id, ["Alt Pilot Two", "Alt Pilot Five"], "needs_reauth");
  await faultOneAlt(acc.id, "Alt Pilot Seven");
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.setViewportSize({ width: NARROWEST, height: 900 });
  await page.goto("/account");
  // Every number below is a text-advance measurement with a margin in the
  // single-digit px, and the page loads Archivo and IBM Plex Mono through
  // next/font (src/app/layout.tsx). A fallback-metrics measurement would be a
  // different layout than the one under test.
  await page.evaluate(() => document.fonts.ready);

  // The preconditions this test exists for. Without them it passes for the
  // exact reason the old gate did: no STATUS column in the DOM. A seed that
  // silently failed to fault anyone measures the healthy layout and reports it
  // as the faulted one.
  await expect(
    manifest(page).getByRole("columnheader", { name: "Status" }),
  ).toBeVisible();
  await expect(manifest(page).locator(".status-line")).toHaveCount(9);
  // Count alone would not notice the copy changing under it, and the copy is
  // the whole of what this column's width is. Assert the two strings the
  // measurement is of, by name.
  await expect(manifest(page).getByText("re-auth needed")).toHaveCount(2);
  await expect(manifest(page).getByRole("link", { name: "re-authorize" })).toHaveCount(1);
  // The same located-row precondition every other measurement in this file
  // carries: an unlocated row is narrower as well as shorter. By text, not by
  // count — a degraded `placeCrew` still renders a `.char__location`, just a
  // much shorter one, which narrows the NAME column and loosens every budget
  // below while the count stays 10.
  await expect(manifest(page).locator(".char__location").first()).toHaveText(
    "J30000142 — Home Astrahus",
  );

  const pinned = await pinGeometry(
    page,
    MANIFEST,
    // Fourth cell: with the STATUS column mounted, ACTIONS moves right by one.
    "tbody tr:first-child td:nth-child(4)",
    "right",
  );
  // Same anti-vacuity floor as the healthy gate — a passing 0 would mean the
  // region had nothing to scroll and the measurement said nothing.
  expect(pinned.maxScrollLeft).toBeGreaterThan(0);
  // The property this change actually controls, asserted directly so a
  // regression names itself instead of showing up only as a few px on the
  // total. This seed measured 240.2px when the labels carried a
  // `min-width: 5.5rem` gutter and 223.1px with the label column sized to
  // content; 232 sits between them, so putting the gutter back trips this
  // line rather than the softer total below.
  const status = await page.evaluate(() => {
    const td = document
      .querySelector("[aria-label='Your characters'] .status-line")!
      .closest("td") as HTMLElement;
    return td.getBoundingClientRect().width;
  });
  expect(status).toBeLessThan(232);
  // The `re-authorize` control at its own width, not the standings chip's.
  // `.status-lines` is a grid and `justify-items` defaults to `stretch`, which
  // sized this border box to the widest value in the column — 168px next to a
  // "token refresh failed" row. It measures 112.6px; 120 catches the stretch
  // without pinning the button's own metrics.
  const reauth = await page.evaluate(() => {
    const a = document.querySelector(
      "[aria-label='Your characters'] .status-lines a.btn",
    ) as HTMLElement;
    return a.getBoundingClientRect().width;
  });
  expect(reauth).toBeLessThan(120);
  // The member-facing total: 316px before this change, 299px after, against a
  // 286px region. Note what that does NOT say — 299 is still more than one
  // region-width, so the worst member-fixable state has not been brought
  // inside the fold and this line must not be read as claiming it was. 308
  // brackets before-and-after so the regression is caught; closing the last
  // 13px is a copy change, described below.
  expect(pinned.maxScrollLeft).toBeLessThan(308);
});

// What the two gates above do NOT claim, recorded so the next person does not
// re-derive it: the STATUS cell is already at its content floor, and it is not
// where the remaining width is.
//
// Measured at a 320px viewport (286px scroll region), ten characters, seeded
// `needs_reauth` as the gate above is:
//
//   portrait  56px   the image plus cell padding
//   name     151px   "J30000142 — Home Astrahus" is the binding string
//   status   223px   71px label column + 8px gap + 120px value column + 24px padding
//   actions  155px   `main` + `unlink`
//   -------------
//   table    585px  ->  299px forced scroll against the 286px region
//
// The 71px is the rendered width of "STANDINGS" (the widest of the three
// labels, so dropping the two `ok` lines would not narrow it) and the 120px is
// the rendered width of the "re-auth needed" chip. Both are content, and the
// 8px is --s-2. That is the whole cell: there is no padding left in it to
// remove, and deleting the STATUS column outright still leaves 362px of table
// against a 286px region. Four columns of genuine content do not fit 320px,
// and no arrangement that keeps a portrait, a name, a status and an unlink
// will.
//
// So the last 13px between 299px and one region-width is the copy. "re-auth
// needed" is the binding string, not "label needed" — the widest MEMBER_FIXABLE
// value, and the only one whose row exceeds the region by more than a rounding
// error. Shortening it is a real lever and is deliberately not taken here,
// because it changes what a member reads rather than how it is laid out, and
// the same strings render on the admin members drawer.
//
// One case is unbounded and no threshold here covers it: an unrecognized result
// code falls through to `result.replace(/_/g, " ")` (contact-state.tsx) and
// renders verbatim inside a `white-space: nowrap` chip in a content-sized
// column. A long enough code from an older deployment forces arbitrary
// horizontal scroll. That is an error path, not a layout one, and it is noted
// rather than gated.
//
// The other lever — dropping the two `ok` lines from the `attention` stack so
// only the fault shows — is worth measuring on its own terms. It does nothing
// for width, because "standings" is still the widest label, but it would take a
// faulted row from 86px back toward the 63px nominal pitch, which is the
// fold-count metric the density work is actually judged on.

// The round-1 failure written as a test. #167's band assertion measured a
// located row against a no-location row and required the difference to sit in
// 10-30px — which is a two-line row by definition, so it passed at 75px and
// would pass at 95px. The pitch is the property that decides how many
// characters clear the fold, so assert the pitch.
test("a located manifest row stays inside the 63px density budget", async ({
  page,
  context,
}) => {
  const acc = await seedNominalCrew();
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  // The precondition every row measurement in this file needs: a seed that
  // silently failed to place a location renders a one-line row, which passes
  // a height ceiling for exactly the wrong reason.
  const locations = manifest(page).locator(".char__location");
  await expect(locations).toHaveCount(10);
  for (const t of await locations.allTextContents()) {
    expect(t).toBe("J30000142 — Home Astrahus");
  }

  const heights = await rowHeights(page, `${MANIFEST} tbody tr`);
  expect(heights).toHaveLength(10);
  // 63px budget: padding 8 + name 22 + `.char-line` gap 4 + location 20 +
  // padding 8 + border 1. 65 leaves margin for platform font variance.
  for (const h of heights) expect(h).toBeLessThanOrEqual(65);
});

// The STATUS column reads "ok" on every row of the common account, costing a
// header, a column and 82px of a 320px viewport to say "nothing here". It
// renders only when at least one character is not `ok` — an exception column,
// so its presence is itself the signal.
test("an all-ok account renders no STATUS column and keeps the per-character facts", async ({
  page,
  context,
}) => {
  const acc = await seedNominalCrew();
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  const head = manifest(page).locator("thead > tr > th");
  await expect(head).toHaveCount(3);
  await expect(page.getByRole("columnheader", { name: "Status" })).toHaveCount(0);
  await expect(manifest(page).locator("[data-state]")).toHaveCount(0);

  // `map on|off` varies per character while the chip reads `ok` either way, so
  // the cell's accessible name was the only place it lived. Dropping the cell
  // must not drop the fact: it moves into the NAME cell, visually hidden, at
  // zero vertical cost.
  const summaries = manifest(page).locator("[data-status-summary]");
  await expect(summaries).toHaveCount(10);
  for (const t of await summaries.allTextContents()) {
    expect(t).toMatch(/token ok, standings ok, map (on|off)/);
  }
});

// The other half of the rule: one faulted character brings the column back for
// every row, so an `ok` row still says `ok` beside the row that does not.
//
// This one is GREEN before the change and green after — it asserts that today's
// behaviour survives on a mixed account, which is a regression guard, not a TDD
// step. Its red is proven by mutation in Step 8b instead. Do not try to make it
// fail first; the honest version of that is the mutation check.
test("one non-ok character brings the STATUS column back for every row", async ({
  page,
  context,
}) => {
  const acc = await seedNominalCrew();
  await db
    .update(character)
    .set({ tokenStatus: "invalid" })
    .where(eq(character.name, "Alt Pilot Nine"));
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
  await expect(manifest(page).locator("[data-state='ok']")).toHaveCount(9);
  await expect(manifest(page).locator("[data-state='attention']")).toHaveCount(1);
  // The hidden span is the column's substitute, not its companion: two copies
  // of the same sentence in one row is what the aria-label already avoids.
  await expect(manifest(page).locator("[data-status-summary]")).toHaveCount(0);
});

// `<dt>Tier</dt>` and `<dt>Discord</dt>` were the only thing naming these two
// values — the tier badge visibly reads "Testers", not "Tier: Testers" — so
// flattening the definition list deletes a label rather than restyling one.
// The deleted STANDING heading does not substitute: a heading groups, it does
// not name a field.
test("the page head's meta line keeps a programmatic label on each fact", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Labelled Pilot", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  const meta = page.locator(".page__meta");
  await expect(meta).toBeVisible();
  await expect(meta.locator("[data-field='tier']")).toContainText("Tier");
  await expect(meta.locator("[data-field='tier']")).toContainText("Testers");
  await expect(meta).toContainText("Discord");

  // Visually hidden, not absent: the mockup this design was approved from puts
  // the tokens on one line with no visible label. Measured, not asserted with
  // toBeHidden() or not.toBeInViewport() — `.visually-hidden` is a 1px clip,
  // not display:none, so Playwright counts it visible and in-viewport BY
  // DESIGN, which is exactly what keeps it readable to a screen reader. Same
  // idiom and same reason as the confirm-cost measurement at :491-498.
  const labelWidth = (await meta.locator(".visually-hidden").first().boundingBox())
    ?.width;
  expect(labelWidth ?? 0).toBeLessThanOrEqual(1);

  // The block this replaces is gone, not merely restyled.
  await expect(page.getByRole("heading", { name: "Standing" })).toHaveCount(0);
});

// #112, as geometry. Arming reveals the cost sentence; if that sentence lands
// as another flex item on the same line rather than taking its own, it grows
// the line box, `align-items: center` re-centres the button, and the button
// slides out from under a pointer that never moved — firing pointerLeave,
// which disarms the control the member just armed.
//
// ~700px on purpose: wide enough that the sentence would still FIT beside the
// button, which is the only band where the bug can happen. At 390px it wraps
// anyway and the test would pass with the CSS rule deleted.
test("arming the Discord unlink does not move it out from under the pointer", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Linked Pilot", tier: "member" });
  await db.insert(discordLink).values({
    accountId: acc.id,
    discordUserId: "duid-112-geometry",
  });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.setViewportSize({ width: 700, height: 900 });
  await page.goto("/account");

  const unlink = page.getByRole("button", { name: "unlink Discord", exact: true });
  const rest = await unlink.boundingBox();
  await unlink.click();

  const confirm = page.getByRole("button", {
    name: "confirm unlink Discord",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  const armed = await confirm.boundingBox();
  expect(armed?.y).toBe(rest?.y);
});

// The success criterion, written as an assertion. Round 1 shipped a change
// that collapsed a cell from three lines to one and moved this number by
// zero, because the metric it was measured against was lines per cell. This
// is the number that matters: how many characters a member can see without
// scrolling.
//
// All three viewports, not just the desktop one. 390x844 is the weakest
// target — its site header is 173px against 61px, and the meta line may wrap
// there — which is the reason to gate it, not a reason to skip it.
const FOLD_TARGETS = [
  { width: 1440, height: 900, expected: 8 },
  { width: 1280, height: 800, expected: 6 },
  { width: 390, height: 844, expected: 4 },
];

for (const { width, height, expected } of FOLD_TARGETS) {
  test(`at least ${expected} characters clear the fold at ${width}x${height}`, async ({
    page,
    context,
  }) => {
    const acc = await seedNominalCrew();
    await context.addCookies([await sessionCookieFor(db, acc.id)]);
    await page.setViewportSize({ width, height });
    await page.goto("/account");

    // The precondition, again: an unlocated row is 24px shorter, so a broken
    // seed makes this test pass for the wrong reason — the exact way #167's
    // band assertion passed.
    await expect(manifest(page).locator(".char__location")).toHaveCount(10);

    const visible = await page.evaluate(
      // Counted from `getBoundingClientRect().bottom` rather than with
      // `toBeInViewport`: that matcher reports any non-zero intersection, so a
      // row with one pixel showing under the fold would count as visible. The
      // criterion is a row a member can actually read.
      ({ sel, h }) =>
        Array.from(document.querySelectorAll(sel)).filter(
          (r) => r.getBoundingClientRect().bottom <= h,
        ).length,
      { sel: `${MANIFEST} tbody tr`, h: height },
    );
    expect(visible).toBeGreaterThanOrEqual(expected);
  });
}

test("a healthy account states its character count in a green chip", async ({
  page,
  context,
}) => {
  const acc = await seedNominalCrew();
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  // Tone and copy are one decision, so assert both. `.st--ok` is what makes
  // this read as a status rather than as the body prose beside it — the whole
  // complaint against the word `nominal` it replaces.
  const verdict = page.locator("p.verdict .st");
  await expect(verdict).toHaveText("10 characters — all healthy");
  await expect(verdict).toHaveClass(/st--ok/);
});

test("a healthy one-character account says character, singular", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Solo Pilot", tier: "member" });
  await markTokensHealthy(acc.id);
  // Token health alone is not account health. A `member`-tier character is a
  // contacts target (`src/services/desired.ts:20`), and `seedMember` writes no
  // `contactSyncState` row at all, so its result reads back as null
  // (`src/services/account-view.ts:307`) and `firstSyncPending` goes true
  // (`src/core/account-health.ts:172-174`). That branch renders
  // `first sync pending` at `page.tsx:262` — one branch ABOVE the healthy one
  // this task rewrites — so without this insert the test is red no matter what
  // Step 3 does. `seedNominalCrew`'s docblock (`e2e/account.spec.ts:74-79`)
  // seeds contacts for exactly this reason; this is the one-character case of
  // the same requirement.
  const [solo] = await db.select().from(character).where(eq(character.accountId, acc.id));
  await db.insert(contactSyncState).values({ characterId: solo.id, lastResult: "ok" });
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  await expect(page.locator("p.verdict .st")).toHaveText("1 character — healthy");
});

test("an account with no characters renders no verdict at all", async ({
  page,
  context,
}) => {
  const acc = await seedMember(db, { name: "Departing Pilot", tier: "member" });
  await db.update(account).set({ mainCharacterId: null }).where(eq(account.id, acc.id));
  await db.delete(character).where(eq(character.accountId, acc.id));
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  // Not "renders something quieter" — nothing. The empty state inside the
  // manifest is what speaks here.
  await expect(page.locator("p.verdict")).toHaveCount(0);
  await expect(page.locator(".log__empty")).toHaveCount(1);
});

test("the crew manifest is wider than the page's prose measure", async ({
  page,
  context,
}) => {
  const acc = await seedNominalCrew();
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/account");

  // Compared against a sibling that keeps the narrow cap rather than against a
  // hardcoded pixel figure: the point is that the manifest opts OUT of a cap
  // its neighbours still take, and a bare number would pass just as well if
  // `page--narrow` were deleted from the page wholesale — the change this
  // explicitly is not.
  const widths = await page.evaluate(() => {
    const frame = document.querySelector(".scroller-frame") as HTMLElement;
    const lede = document.querySelector(".page__lede") as HTMLElement;
    return {
      manifest: frame.getBoundingClientRect().width,
      lede: lede.getBoundingClientRect().width,
    };
  });
  expect(widths.manifest).toBeGreaterThan(widths.lede);
  expect(widths.manifest).toBeGreaterThan(960);
});

test("a faulted character's remedy renders in a sub-row under that character", async ({
  page,
  context,
}) => {
  const acc = await seedNominalCrew();
  await faultContacts(acc.id, ["Alt Pilot One"], "missing_label");
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  const subRows = manifest(page).locator("tbody tr.drawer-row");
  await expect(subRows).toHaveCount(1);

  // Adjacency is the whole point of the change: a note that renders anywhere
  // else on the page is the layout this replaced. Assert the DOM relationship,
  // not merely that the text exists somewhere.
  const owner = manifest(page).locator("tbody tr:not(.drawer-row)", {
    hasText: "Alt Pilot One",
  });
  const followsOwner = await page.evaluate(() => {
    const sub = document.querySelector("tr.drawer-row") as HTMLElement;
    const prev = sub.previousElementSibling as HTMLElement;
    return prev.textContent?.includes("Alt Pilot One") ?? false;
  });
  expect(followsOwner).toBe(true);
  await expect(owner).toHaveCount(1);

  // Spans the whole table, which is what keeps its height from wrapping
  // against one narrow column — the property the in-cell alternative did not
  // have.
  await expect(subRows.locator("td")).toHaveAttribute("colspan", "4");

  // The footnote copy is gone, not merely duplicated. Scoped to the remedy's
  // own id rather than to `.table-notes` as a whole: that container survives
  // for the "make main" consequence notes, which did not move.
  await expect(page.locator('.table-notes [id^="contact-remedy-"]')).toHaveCount(0);
  await expect(page.locator('[id^="contact-remedy-"]')).toHaveCount(1);
});

test("a faulted character's status cell is still described by its remedy", async ({
  page,
  context,
}) => {
  const acc = await seedNominalCrew();
  await faultContacts(acc.id, ["Alt Pilot One"], "missing_label");
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  // The reference and its target are gated on the same `hasContactRemedy`
  // predicate, so this proves the gate did not drift apart when the target
  // moved rows.
  const cell = manifest(page).locator("td[data-state='attention']");
  const describedBy = await cell.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`#${describedBy}`)).toHaveCount(1);
  await expect(page.locator(`#${describedBy}`)).toContainText("label");
});

test("a stalled character gets a sub-row too", async ({ page, context }) => {
  const acc = await seedNominalCrew();
  // `sync_failed` is stalled, not attention: it retries on its own and is not
  // the member's to fix. It still expands a row now — silence about standings
  // sitting stale reads as health, which is the rationale this change
  // supersedes in `classifyCharacter`'s docblock.
  await faultContacts(acc.id, ["Alt Pilot Two"], "sync_failed");
  await context.addCookies([await sessionCookieFor(db, acc.id)]);
  await page.goto("/account");

  await expect(manifest(page).locator("tbody tr.drawer-row")).toHaveCount(1);
});

// The fold cost of Decision 4, pinned so it cannot drift further. The block
// this replaced sat after the table and could not displace a row, so moving
// the prose inside the table is a deliberate regression on this metric — one
// row at every viewport. Pinned as a floor, not an equality: a future change
// that gets a row back should not have to edit this number. Values are the
// observed minimum across five consecutive runs per viewport (stable after
// the drawer-row margin fix and waiting on `document.fonts.ready` below —
// both removed sources of run-to-run variance in the raw measurement).
const FAULTED_FOLD_TARGETS = [
  { width: 1440, height: 900, expected: 7 },
  { width: 1280, height: 800, expected: 6 },
  { width: 390, height: 844, expected: 5 },
];

for (const { width, height, expected } of FAULTED_FOLD_TARGETS) {
  test(`at least ${expected} characters clear the fold at ${width}x${height} with two faults`, async ({
    page,
    context,
  }) => {
    const acc = await seedNominalCrew();
    // `faultContacts`, not `faultOneAlt`: this test measures the fold with
    // sub-rows present, and only a contacts fault renders one. Seeded with
    // `faultOneAlt` the page would render ten plain rows and "confirm" fold
    // targets that describe the layout this task replaces.
    await faultContacts(acc.id, ["Alt Pilot One", "Alt Pilot Two"], "missing_label");
    await context.addCookies([await sessionCookieFor(db, acc.id)]);
    await page.setViewportSize({ width, height });
    await page.goto("/account");

    // The precondition every row measurement in this file needs: an unlocated
    // row is 24px shorter, so a broken seed makes this pass for the wrong
    // reason — the exact way #167's band assertion passed.
    await expect(manifest(page).locator(".char__location")).toHaveCount(10);
    await expect(manifest(page).locator("tbody tr.drawer-row")).toHaveCount(2);

    // Without this the fold count races font loading: a row measured before
    // its font swaps in reports a shorter (or taller, on a re-layout mid-swap)
    // rect than the same row a frame later, which is what made this floor
    // flaky to pin exactly. Layout is settled once every font is.
    await page.evaluate(() => document.fonts.ready);

    const visible = await page.evaluate(
      ({ sel, h }) =>
        Array.from(document.querySelectorAll(sel)).filter(
          (r) => r.getBoundingClientRect().bottom <= h,
        ).length,
      { sel: `${MANIFEST} tbody tr:not(.drawer-row)`, h: height },
    );
    expect(visible).toBeGreaterThanOrEqual(expected);
  });
}

test("hovering the manifest's remedy sub-row leaves it untinted", async ({
  page,
  context,
}) => {
  const acc = await seedNominalCrew();
  // A contacts fault, not a token fault — `faultOneAlt` renders no sub-row and
  // this test has nothing to hover. See Task 3 Step 1's note on the two routes.
  await faultContacts(acc.id, ["Alt Pilot One"], "missing_label");
  await context.addCookies([await sessionCookieFor(db, acc.id)]);

  // Background-color transitions over --dur-color (140ms). Reading
  // getComputedStyle right after a hover can catch that mid-transition value
  // instead of the settled one. globals.css already collapses all
  // transitions to 0.01ms under prefers-reduced-motion (an accessibility
  // feature, not a test-only mechanism), so emulating it here makes the
  // hover-driven background deterministic without a sleep. See
  // `e2e/audit.spec.ts`'s "hovering the empty row" test for the same fix.
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.goto("/account");

  const sub = manifest(page).locator("tbody tr.drawer-row");
  await expect(sub).toHaveCount(1);

  // Compared against the row's own unhovered value rather than against a
  // literal colour: the tint is a `color-mix` of a custom property, so a
  // hardcoded rgb string would pin the theme rather than the behaviour.
  const before = await sub.evaluate((el) => getComputedStyle(el).backgroundColor);
  await sub.hover();
  const after = await sub.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(after).toBe(before);
});

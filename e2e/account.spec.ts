import { expect, test, type Page } from "@playwright/test";
import { eq, inArray, sql } from "drizzle-orm";
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
  await expect(page.getByText("Pilot Alt")).toBeVisible();
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

test("unlink is quiet at rest and lands on one vertical with make main", async ({
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

  // Scoped to the Standing row's own field rather than a bare page-wide text
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
  const acc = await seedMember(db, { name: "Healthy Pilot", tier: "alumni" });
  await markTokensHealthy(acc.id);
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
  const rows = page.locator("table tbody tr");
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
  const acc = await seedMember(db, { name: "Grounded Pilot", tier: "alumni" });
  await markTokensHealthy(acc.id);
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
  const acc = await seedMember(db, { name: "Synced Pilot", tier: "member" });
  await markTokensHealthy(acc.id);
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
  const acc = await seedMember(db, { name: "Nameable Pilot", tier: "alumni" });
  await markTokensHealthy(acc.id);
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
// These two tests now assert the fallback's actual shape (two lines, not
// one) and pin the horizontal measurement that forced the call, so a future
// change reintroducing the flex row without re-measuring trips a test rather
// than shipping silently.
//
// A DOM count of zero `.status-line`s (the assertion style used elsewhere in
// this file) proves nothing about how many text lines a row wraps to, so
// these measure rendered row height instead — and derive the one-line
// reference from an in-page sibling row rather than a hardcoded constant, so
// the baseline can't go stale the way a number copied from a deleted scratch
// spec would.

test("characters with a location render two text lines, not one, and the location text is present", async ({
  page,
  context,
}) => {
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
  // Fix 1: prove the seed actually put a location on the ten rows the height
  // assertion below claims render two lines — a bare height/count check
  // passes just as well whether or not the location rendered at all.
  const locationTexts = await rows
    .filter({ hasNotText: "AAA No-Location Alt" })
    .locator(".char__location")
    .allTextContents();
  expect(locationTexts).toHaveLength(10);
  for (const t of locationTexts) expect(t).toBe("J30000142 — Home Astrahus");

  const heights = await rowHeights(page, `${MANIFEST} tbody tr`);
  expect(heights).toHaveLength(11);
  // Row 0 is main (located, sorts first regardless of name); row 1 is "AAA
  // No-Location Alt" (the one-line reference, sorts first among alts); rows
  // 2-10 are the nine remaining located alts.
  const reference = heights[1];
  const located = [heights[0], ...heights.slice(2)];
  // Each line is ~18px at this font (56.5px one line vs 74.3-74.8px two,
  // measured while deriving SINGLE_LINE_MAX for the original one-line
  // attempt). >10 rules out "accidentally still one line"; <30 rules out a
  // three-line regression, with margin either side for platform variance.
  for (const h of located) {
    expect(h - reference).toBeGreaterThan(10);
    expect(h - reference).toBeLessThan(30);
  }
});

test("a long structure name renders two lines, not a horizontal blowout, at the narrowest viewport", async ({
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

  const heights = await rowHeights(page, `${MANIFEST} tbody tr`);
  expect(heights).toHaveLength(2);
  const [located, reference] = heights;
  expect(located - reference).toBeGreaterThan(10);
  expect(located - reference).toBeLessThan(30);
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
  const acc = await seedMember(db, { name: "Vanity Pilot", tier: "alumni" });
  await markTokensHealthy(acc.id);
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
    "tbody tr:first-child td:nth-child(3)",
    "right",
  );
  // House style (e2e/audit.spec.ts:1124), kept for shape — but this holds
  // just as true under the flex row (the STATUS cell's width and the
  // region's clientWidth are both unaffected by what the name column does),
  // so it is not a second independent check. `maxScrollLeft` below is the
  // actual gate.
  expect(pinned.cellWidth / pinned.regionWidth).toBeLessThan(0.5);
  // Rules out "nothing to scroll at all" reading as success (e.g. if the
  // seed silently failed to render a location and the name column shrank
  // enough that nothing forces scroll) — a passing 0 would be exactly as
  // vacuous as the count-only check Fix 1 above replaced.
  expect(pinned.maxScrollLeft).toBeGreaterThan(0);
  // Measured: the stacked (fallback) layout puts this stress-test name's
  // forced scroll at ~146px; the flex-row attempt this test replaced
  // measured 413px for the identical seed (see the CSS comment above
  // `.char-line`, globals.css:1580). 250 sits
  // comfortably above the former and well below the latter, so this trips if
  // the flex row (or something costing the same) comes back.
  expect(pinned.maxScrollLeft).toBeLessThan(250);
});

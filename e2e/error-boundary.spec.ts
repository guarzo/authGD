import { expect, test } from "@playwright/test";
import { sql } from "drizzle-orm";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

/**
 * The error boundary. Every test here drives it through a *real* throw rather
 * than rendering the component directly, because most of what is being pinned
 * is framework behaviour that only exists at runtime — which title wins, what
 * `reset()` does to component identity, what `usePathname()` resolves to
 * inside a boundary.
 *
 * The trigger throughout is a table renamed out from under a page, restored in
 * `finally`. It is picked so the *guard* still passes and only the page body
 * falls over, which is the exact shape this boundary exists for; and the table
 * is always one the page reads and `generateMetadata` does not, so a static
 * `metadata` export still resolves and there is something for the hoisted
 * `<title>` to actually compete with.
 *
 * An earlier draft used `/payouts/<not a uuid>`, relying on postgres raising
 * 22P02 on the uuid cast. #80 fixed that route to 404 — correctly; it was
 * sweep finding 7, and this spec's first version said in as many words that
 * the coupling was intended. The rename technique replaces it because it does
 * not depend on any URL being malformed, so the next validation fix cannot
 * quietly turn these tests into assertions about a 404 page.
 */

/** `/payouts` reads payout_operation in its body, after `requirePayoutReader`
 *  (which reads neither payouts table), and exports a static
 *  `metadata: { title: "Payouts" }` that resolves either way. `resetDb`
 *  truncates the table, so the rename is always undone.
 *
 *  payout_operation rather than loot_pool: `listPayoutOperations` skips its
 *  loot_pool and payout_participant child queries when the first page comes
 *  back empty (`payout-view.ts:125`), and these tests seed no operations — so
 *  renaming loot_pool stopped making the page throw at all. The operations
 *  query itself has no such short-circuit, which is the property this helper
 *  needs. */
async function breakPayoutsList<T>(run: () => Promise<T>): Promise<T> {
  await db.execute(sql`ALTER TABLE payout_operation RENAME TO payout_operation_probe`);
  try {
    return await run();
  } finally {
    await db.execute(sql`ALTER TABLE payout_operation_probe RENAME TO payout_operation`);
  }
}

const BROKEN_ROUTE = "/payouts";

test("the tab stops naming the page that failed", async ({ page, context }) => {
  const member = await seedMember(db, {
    name: "Link Follower",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await breakPayoutsList(async () => {
    await page.goto(BROKEN_ROUTE);
    await expect(page.getByRole("heading", { name: "Something broke" })).toBeVisible();

    // `payouts/page.tsx` exports a static `metadata.title = "Payouts"`, which
    // resolves whether or not the body throws, and this is the assertion that
    // the hoisted <title> beats it. Worth pinning precisely because the
    // segment-scoped `not-found.tsx` was measured going the other way — the
    // two boundaries genuinely differ, and a reader who knows one case will
    // guess the other one wrong.
    await expect(page).toHaveTitle("Something broke · Test Corp");
  });
});

test("focus lands in the boundary rather than on <body>", async ({ page, context }) => {
  const member = await seedMember(db, {
    name: "Link Follower",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await breakPayoutsList(async () => {
    await page.goto(BROKEN_ROUTE);
    await expect(page.getByRole("heading", { name: "Something broke" })).toBeVisible();

    const focused = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      text: document.activeElement?.textContent,
    }));
    expect(focused.tag).toBe("H1");
    expect(focused.text).toBe("Something broke");
  });
});

test("a retry that fails again re-announces instead of looking like a dead click", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, {
    name: "Link Follower",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await breakPayoutsList(async () => {
    await page.goto(BROKEN_ROUTE);
    const retry = page.getByRole("button", { name: /Try again|Trying/ });
    await expect(retry).toBeVisible();

    // Move focus off the heading first, so "focus is on the h1" afterwards can
    // only be the boundary having re-run its focus effect — not a leftover from
    // the initial render.
    await retry.focus();
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.tagName))
      .toBe("BUTTON");

    await retry.click();

    // The table is still renamed away, so the retry is deterministically going
    // to fail and the boundary comes back. What must be observable is that
    // *something happened*: the remount re-runs FocusHeading, which pulls focus
    // back to the h1 and gets the page re-announced. Without it a screen-reader
    // user gets no confirmation the press landed at all, and presses again.
    await expect
      .poll(
        async () =>
          page.evaluate(() => ({
            tag: document.activeElement?.tagName,
            text: document.activeElement?.textContent,
          })),
        { timeout: 10_000 },
      )
      .toEqual({ tag: "H1", text: "Something broke" });

    await expect(page.getByRole("heading", { name: "Something broke" })).toBeVisible();
  });
});

test("the boundary keeps an admin inside the admin section", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, {
    name: "Boss",
    tier: "member",
    status: "active",
    isAdmin: true,
  });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // Every admin page validates its own query params — `/admin/accounts` falls
  // back on an unknown `sort`, `/admin/audit` guards `before` with
  // `Number.isFinite` — so there is no URL that makes one of them throw, which
  // is the app being right rather than a gap. Same technique as the payouts
  // tests above: `/admin/sync` also reads `pgboss.version` for its worker
  // heartbeat, but that read is deliberately fail-open (`workerHeartbeat`,
  // @/services/health — a missing relation degrades to null rather than
  // throwing), so `sync_run` is still the one table whose absence takes the
  // page down. It is read *after* `requireAdminPage()`, so renaming it away
  // leaves the admin guard passing and takes down only the page body. Renamed
  // back in `finally` so the truncate in `beforeEach` still finds the table.
  await db.execute(sql`ALTER TABLE sync_run RENAME TO sync_run_probe`);
  try {
    await page.goto("/admin/sync");
    await expect(page.getByRole("heading", { name: "Something broke" })).toBeVisible();

    // The four admin destinations, under the nav's admin accessible name — not
    // the single "Your account" link a member gets. The wordmark follows the
    // same `admin` prop, which is the link that used to walk an admin out of
    // the section it promises to be "home" for.
    const nav = page.getByRole("navigation", { name: "Admin" });
    await expect(nav.getByRole("link", { name: "Members" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Audit log" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Sync" })).toBeVisible();
    await expect(page.locator(".shell__register")).toHaveText("Admin");
    await expect(page.locator("a.shell__mark")).toHaveAttribute(
      "href",
      "/admin/accounts",
    );

    // And the escape goes back to the section, not to /account.
    await expect(page.getByRole("link", { name: "Back to Members" })).toBeVisible();
  } finally {
    await db.execute(sql`ALTER TABLE sync_run_probe RENAME TO sync_run`);
  }
});

test("the boundary keeps a payouts reader inside payouts, and offers no admin links", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, {
    name: "Link Follower",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await breakPayoutsList(async () => {
    await page.goto(BROKEN_ROUTE);
    await expect(page.getByRole("heading", { name: "Something broke" })).toBeVisible();

    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Payouts" })).toBeVisible();
    // `access.isAdmin` is the one thing the boundary cannot read, so the admin
    // shortcut the real /payouts header offers conditionally is dropped rather
    // than guessed. A plain reader must not be shown a link that bounces.
    await expect(nav.getByRole("link", { name: "Members" })).toHaveCount(0);

    await expect(page.getByRole("link", { name: "Back to Payouts" })).toHaveAttribute(
      "href",
      "/payouts",
    );
  });

  // The escape is followed only after the table is back, so this asserts it
  // reaches a *working* list rather than bouncing off the same throw. The link
  // is a plain `<a href>`, so this is a document load.
  await page.getByRole("link", { name: "Back to Payouts" }).click();
  await expect(page).toHaveURL(/\/payouts$/);
  await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();
});

test("the reference is inside the instruction that asks for it", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, {
    name: "Link Follower",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await breakPayoutsList(async () => {
    await page.goto(BROKEN_ROUTE);
    const alert = page.locator("p.notice--bad");
    await expect(alert).toContainText("tell an admin what you were doing");

    // The point of the merge: a member who follows the instruction to the letter
    // now relays the digest, because it is in the same sentence. It used to be a
    // separate line below the alert with no instruction attached to it.
    await expect(alert).toContainText("quote reference");
    const digest = alert.locator("code.mono");
    await expect(digest).toBeVisible();
    expect((await digest.innerText()).trim()).not.toBe("");

    // Only the value is monospaced. The prose around it, "reference" included,
    // stays proportional — DESIGN.md's split, which the old `dim mono` line ran
    // backwards by setting a code face on an English word.
    const fonts = await alert.evaluate((el) => ({
      prose: getComputedStyle(el).fontFamily,
      value: getComputedStyle(el.querySelector("code")!).fontFamily,
    }));
    expect(fonts.value).toContain("Plex");
    expect(fonts.prose).not.toContain("Plex");
  });
});

test("the lede no longer claims the request didn't go through", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, {
    name: "Link Follower",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  await breakPayoutsList(async () => {
    await page.goto(BROKEN_ROUTE);
    const lede = page.locator("p.page__lede");

    // The sentence this page cannot support: a throw while enqueueing lands here
    // *after* the write it follows, so "didn't go through" is false in exactly
    // the case the file's own comment describes.
    await expect(lede).not.toContainText("didn't go through");
    await expect(lede).not.toContainText("didn’t go through");

    // The fault assignment is the best sentence on the surface and survives the
    // rewrite verbatim.
    await expect(lede).toContainText("a fault on this end, not something you did");
    await expect(lede).toContainText("check whether it took effect");
  });
});

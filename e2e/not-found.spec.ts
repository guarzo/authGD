import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import { payoutOperation } from "../src/db/schema";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

/**
 * The 404 boundaries. What these hold down is not the copy — it is that a
 * `notFound()` lands on *our* page rather than Next's built-in fallback, which
 * paints `#fff`, drops the fonts, and contains no links at all.
 *
 * The soft-navigation test below is the reason both files exist. It is the one
 * path a member actually takes into a 404, and the one where nothing about the
 * arrival is self-evident: no document load, so no browser spinner and no
 * automatic announcement, and the control that was pressed is unmounted out
 * from under the focus ring.
 */

test("a typed-in bad URL renders the app's own 404, not the framework's", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, { name: "Lost Pilot", tier: "alumni" });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  const res = await page.goto("/no-such-page");

  // The status has to survive having our own component: a not-found boundary
  // that 200s is a soft 404, which is worse than the framework page it
  // replaced.
  expect(res?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "Nothing at that address" }),
  ).toBeVisible();

  // The root boundary's `metadata` export does apply — no page segment matched,
  // so nothing competes with it. Worth pinning: the segment-scoped boundary is
  // the opposite case (see its comment), and the difference is not guessable.
  await expect(page).toHaveTitle("Not found · Test Corp");

  // The three things the framework fallback does not have. The header brings
  // the seal, the nav and the skip link with it.
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeAttached();
  await expect(page.locator("main#main")).toBeVisible();
  await expect(page.getByRole("link", { name: "Your account" })).toHaveCount(2);

  // The bar's exact membership, not just that one link is in it. This boundary
  // cleared no guard — an unrouted URL matched no page, so no layout ran and
  // nothing about this viewer is proven — and `nav-items.ts` renders that as
  // `navFor({canReadPayouts: false, isAdmin: false})`. Pinning the whole list
  // is what would catch a future change that taught this file to guess from
  // the URL: the seed above is tier `alumni`, so a guessed `Payouts` here
  // would be a link that redirects them straight back out.
  await expect(page.locator(".shell__nav").getByRole("link")).toHaveText([
    "Your account",
  ]);

  // Ground and type are the app's, not the injected `body{background:#fff}`.
  // Compared against `<body>`'s own computed value rather than a literal, so
  // this tracks `--void` if the token is ever retuned; the assertion is that
  // nothing overrode it, and that a white ground would fail.
  const body = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return { background: s.backgroundColor, font: s.fontFamily };
  });
  expect(body.background).not.toBe("rgb(255, 255, 255)");
  expect(body.font).toContain("Archivo");
});

test("the 404 is reachable signed out and routes to login rather than dead-ending", async ({
  page,
}) => {
  await page.goto("/no-such-page");
  await expect(
    page.getByRole("heading", { name: "Nothing at that address" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Your account" }).last().click();
  await expect(page).toHaveURL(/\/login/);
});

test("clicking a since-deleted operation announces the 404 and lands focus in it", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "List Reader",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  const [op] = await db
    .insert(payoutOperation)
    .values({
      name: "Thursday roam",
      occurredAt: new Date("2026-08-01"),
      corpSharePct: "0",
      createdBy: operator.id,
    })
    .returning();

  await page.goto("/payouts");
  const row = page.getByRole("link", { name: "Thursday roam" });
  await expect(row).toBeVisible();

  // The scenario exactly: the list is open and correct, and the operation goes
  // away behind it. Nothing about the page the member is looking at changes.
  await db.delete(payoutOperation).where(eq(payoutOperation.id, op.id));

  // `next/link`, so this is a client-side transition — no document load.
  await row.click();

  // The segment-scoped boundary, not the root one. This is what pays for the
  // second file: the exit points back at the list the member was reading.
  await expect(page.getByRole("heading", { name: "No such operation" })).toBeVisible();
  await expect(page.getByRole("link", { name: "All operations" })).toBeVisible();

  // Exactly two items, and the pair is the point. This boundary is reachable
  // only through `page.tsx`, which calls `requirePayoutReader()` before it
  // calls `notFound()` — so unlike the root 404 above, the payouts bit here is
  // proven rather than absent, and `Payouts` is offered. `isAdmin` is the bit
  // a payouts-scoped guard never checks, so the three admin destinations stay
  // out even for a viewer who would get them on a live page.
  await expect(page.locator(".shell__nav").getByRole("link")).toHaveText([
    "Your account",
    "Payouts",
  ]);

  // The tab agrees with the page. `page.tsx` exports `generateMetadata`, which
  // resolves the same lookup the page did, finds nothing, and titles the tab
  // after this heading rather than "Payout operation" — a title for an
  // operation that isn't there. Asserted on the soft-nav path specifically:
  // it is the one where the document is never reloaded, so a stale title
  // would simply persist.
  await expect(page).toHaveTitle("No such operation · Test Corp");

  // Focus is the half that is deterministic and ours. The pressed link is
  // gone; without `FocusHeading` this is `BODY`, and the member's next Tab
  // restarts at the top of a document they were never told they arrived at.
  const focused = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.textContent,
  }));
  expect(focused.tag).toBe("H1");
  expect(focused.text).toBe("No such operation");

  await page.getByRole("link", { name: "All operations" }).click();
  await expect(page).toHaveURL(/\/payouts$/);
});

test("a truncated operation id pasted in gets the operation 404, not the error boundary", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, {
    name: "Link Follower",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  // A well-formed uuid that resolves to nothing — the shape a link preview
  // leaves behind. `getPayoutOperationDetail` returns null and `page.tsx`
  // calls `notFound()`.
  const res = await page.goto("/payouts/00000000-0000-4000-8000-000000000000");

  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "No such operation" })).toBeVisible();
  // Not "Something broke": a mistyped id is not a fault on this end.
  await expect(page.getByText("Something broke")).toHaveCount(0);
});

test("a malformed operation id gets the operation 404, not the error boundary", async ({
  page,
  context,
}) => {
  const member = await seedMember(db, {
    name: "Typo Follower",
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, member.id)]);

  // Not a uuid in any form postgres accepts. Without the shape check in
  // `page.tsx` this reached the `uuid` column as a query parameter, postgres
  // rejected the cast (22P02), and the member was shown "Something broke" —
  // an apology for a server fault, for what is a mistyped or truncated URL.
  const res = await page.goto("/payouts/not-a-uuid");

  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "No such operation" })).toBeVisible();
  await expect(page.getByText("Something broke")).toHaveCount(0);
  await expect(page).toHaveTitle("No such operation · Test Corp");
});

test("the payouts 404 stays behind the payouts guard", async ({ page, context }) => {
  const alumnus = await seedMember(db, { name: "Outsider", tier: "alumni" });
  await context.addCookies([await sessionCookieFor(db, alumnus.id)]);

  // `requirePayoutReader()` runs before `notFound()`, so a member without read
  // access is redirected out rather than being shown a payouts-flavoured 404
  // that offers them a `/payouts` link they cannot follow.
  await page.goto("/payouts/00000000-0000-4000-8000-000000000000");
  await expect(page).toHaveURL(/\/account/);
});

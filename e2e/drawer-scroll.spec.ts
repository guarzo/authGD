import { expect, test, type Locator, type Page } from "@playwright/test";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

/**
 * The members drawer's horizontal overflow — what this spec can and can't
 * prove.
 *
 * The bug (design doc, "Members drawer scroll — diagnose first"): opening a
 * drawer relaxes the region's height cap from `100svh - 29rem` to `80svh`
 * (globals.css:1236). A drawer taller than that gives the region a vertical
 * scrollbar, and on a classic (width-consuming) scrollbar platform that bar
 * takes ~15px out of `clientWidth` the moment it appears — tipping a table
 * already sized near the full region width into *horizontal* scroll as a
 * side effect. `scrollbar-gutter: stable` on `.scroller--tall`
 * (globals.css:1132-1157) reserves that width unconditionally, so crossing
 * the vertical-overflow threshold no longer changes the content-box width.
 *
 * This project has no jsdom, so a drawer can only be exercised against a real
 * engine via Playwright — and every attempt to *measure* the horizontal
 * overflow directly, in this environment, came back uninterpretable: headless
 * Chromium renders scrollbars as zero-width overlays regardless of host OS or
 * `--disable-features=OverlayScrollbar` (confirmed against a trivial,
 * unconditionally-overflowing test element, not just this drawer), so
 * `offsetWidth - clientWidth` never reflects a real scrollbar's width here.
 * That means **this spec cannot regress-test the horizontal-overflow fix
 * itself** — no CI run in this environment will ever see the symptom the
 * user reported, on a real Windows/WSL2 Chrome session with classic
 * scrollbars, appear or disappear.
 *
 * What it asserts instead, and why each one is still meaningful:
 *   - The vertical-overflow *threshold* the fix is keyed to: a
 *     many-character drawer crosses `.scroller--tall`'s cap and a
 *     few-character one does not. That's real geometry, independent of
 *     scrollbar rendering, and it's the exact behavior Task 12 (a location
 *     line added to every drawer row) is about to make more rows cross.
 *   - That `scrollbar-gutter: stable` is actually the computed value on the
 *     scroll container, so the fix can't silently regress via a future
 *     refactor of this rule even though nothing here can observe its visual
 *     effect.
 *
 * The horizontal-overflow fix is therefore unverified by automated test in
 * this repo and needs confirmation in a real classic-scrollbar browser.
 */

const ROWS = ".log--dense > tbody > tr:not(.drawer-row)";
const rowFor = (page: Page, name: string) => page.locator(ROWS, { hasText: name });
const drawerOf = (row: Locator) => row.locator("xpath=following-sibling::tr[1]");
const toggleOf = (row: Locator) => row.locator(".row-toggle");

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

/** Region geometry needed to assert the vertical threshold and the CSS fix. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const sc = document.querySelector(".scroller--tall") as HTMLElement;
    const doc = document.documentElement;
    return {
      scrollWidth: sc.scrollWidth,
      clientWidth: sc.clientWidth,
      scrollHeight: sc.scrollHeight,
      clientHeight: sc.clientHeight,
      scrollbarGutter: getComputedStyle(sc).getPropertyValue("scrollbar-gutter"),
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
    };
  });
}

test("a many-character drawer crosses the region's vertical-overflow threshold; a few-character one does not", async ({
  page,
  context,
}) => {
  const admin = await seedMember(db, { name: "Aaa Boss", tier: "member", isAdmin: true });
  // Twelve characters: past the eight the globals.css:1219 comment measured
  // 709px against, so the drawer certainly exceeds the relaxed 80svh cap at
  // 900px tall and the region certainly gains a vertical scrollbar.
  await seedMember(db, {
    name: "Big Fleet",
    tier: "member",
    alts: Array.from({ length: 11 }, (_, i) => `Big Alt ${String(i).padStart(2, "0")}`),
  });
  await seedMember(db, { name: "Solo Pilot", tier: "member" });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);

  // 1280x900 is the viewport the -29rem chrome figure was measured at
  // (globals.css:1150), so the cap arithmetic exercised here is the arithmetic
  // that comment describes rather than some other viewport's.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/admin/accounts");
  await page.waitForSelector(".scroller--tall tbody tr");

  const closed = await measure(page);
  expect(closed.scrollbarGutter, "the reserved gutter is in effect closed too").toBe(
    "stable",
  );
  expect(
    closed.scrollWidth,
    "the collapsed table does not scroll horizontally",
  ).toBeLessThanOrEqual(closed.clientWidth + 1);

  const bigRow = rowFor(page, "Big Fleet");
  await toggleOf(bigRow).click();
  await expect(drawerOf(bigRow)).toBeVisible();
  const openMany = await measure(page);

  // The threshold this whole fix is keyed to: a many-character drawer really
  // does exceed the region's height cap and force a vertical scrollbar
  // situation. This is real geometry — it doesn't depend on how (or whether)
  // this environment renders that scrollbar's width.
  expect(
    openMany.scrollHeight,
    "the many-character drawer overflows the region vertically",
  ).toBeGreaterThan(openMany.clientHeight);
  expect(
    openMany.scrollbarGutter,
    "scrollbar-gutter: stable is the computed value while the drawer is open",
  ).toBe("stable");

  await toggleOf(bigRow).click();
  await expect(drawerOf(bigRow)).toBeHidden();

  const soloRow = rowFor(page, "Solo Pilot");
  await toggleOf(soloRow).click();
  await expect(drawerOf(soloRow)).toBeVisible();
  const openFew = await measure(page);

  // The other half of the threshold: a drawer with nothing but a solo main
  // character never gets tall enough to reach the cap at all, so there is no
  // vertical scrollbar situation for the reserved gutter to react to.
  expect(
    openFew.scrollHeight,
    "the few-character drawer does not overflow the region vertically",
  ).toBeLessThanOrEqual(openFew.clientHeight);
});

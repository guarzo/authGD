import { expect, test } from "@playwright/test";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";
import { payoutOperation } from "../src/db/schema";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

/**
 * The submit buttons stopped disabling themselves while their form is in
 * flight: disabling the element the member just pressed moves focus to
 * `<body>`, and every one of these actions ends in a server-action
 * `redirect()` — a client navigation, with no document load to put focus back.
 * `useSubmitGuard` is what replaced `disabled` as the re-entry stop, and this
 * is the case that made it non-negotiable rather than merely tidy: creating an
 * operation is not idempotent and nothing in the app can delete one, so a
 * double-click that got through would leave a permanent duplicate on the
 * payouts list and no way to clean it up.
 *
 * `dblclick` rather than two awaited `click`s. Two awaited clicks let React
 * commit the pending render in between, which is the state `useFormStatus`
 * would have caught on its own; the whole reason the guard holds a ref instead
 * is the pair of clicks that land inside one commit, and `dblclick` is how
 * Playwright dispatches that pair.
 */
test("double-clicking Create operation makes one operation, not two", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Doubletap",
    tier: "flygd",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Doubletap roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Corp share %").fill("10");
  await page.getByRole("button", { name: "Create operation" }).dblclick();

  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);
  const rows = await db.select().from(payoutOperation);
  expect(rows.map((r) => r.name)).toEqual(["Doubletap roam"]);
});

/**
 * The other half of dropping `disabled`: the control the member pressed has to
 * still be there to hear the answer. A disabled button is not focusable, so the
 * browser moves focus to `<body>` the moment the pending render commits — and a
 * screen reader that was on the button is then somewhere with no name, on a
 * page that has not navigated yet.
 */
test("the pressed button keeps focus while its form is in flight", async ({
  page,
  context,
}) => {
  const operator = await seedMember(db, {
    name: "FC Focus",
    tier: "flygd",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Focus roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Corp share %").fill("0");

  const create = page.getByRole("button", { name: "Create operation" });
  await create.focus();
  await create.press("Enter");

  // Whichever side of the navigation this lands on, focus must never have been
  // dumped on <body>: before it, the button is busy and still focused; after
  // it, `FocusHeading` on the operation page has taken focus to the h1.
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}:${el.getAttribute("aria-busy") ?? ""}` : "none";
  });
  expect(focused).not.toBe("BODY:");
  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);
});

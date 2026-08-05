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
    tier: "member",
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
    tier: "member",
    status: "active",
  });
  await context.addCookies([await sessionCookieFor(db, operator.id)]);

  await page.goto("/payouts/new");
  await page.getByLabel("Name").fill("Focus roam");
  await page.getByLabel("Date").fill("2026-08-01");
  await page.getByLabel("Corp share %").fill("0");

  // Recorded rather than sampled. Reading `document.activeElement` once after
  // the press races the client navigation: land after it and focus is already
  // on the operation page's h1, which passes whether or not the button was
  // blurred on the way there. These two listeners are installed before the
  // press and survive it, because a server-action redirect is a client
  // navigation in the same document.
  await page.evaluate(() => {
    const w = window as unknown as { busy: boolean; lost: boolean };
    w.busy = false;
    w.lost = false;
    // Proves the form actually reached its pending state, so a submit that
    // never fired can't pass this test vacuously.
    new MutationObserver((records) => {
      for (const r of records) {
        if ((r.target as Element).getAttribute("aria-busy") === "true") w.busy = true;
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-busy"],
    });
    // The regression itself, and only it. Focus reaching `<body>` is not on its
    // own a defect: the navigation unmounts this whole form, and there is an
    // unavoidable moment between React removing the button and `FocusHeading`
    // taking the operation page's h1. What must never happen is focus leaving a
    // control that is *still there* — that is what `disabled` does, and it
    // strands the member on a nameless body for the whole round trip, on a page
    // that has not navigated yet. So the blurred element is checked for still
    // being in the document.
    document.addEventListener(
      "focusout",
      (e) => {
        const from = e.target as Element;
        queueMicrotask(() => {
          if (document.activeElement === document.body && from.isConnected) {
            w.lost = true;
          }
        });
      },
      true,
    );
  });

  const create = page.getByRole("button", { name: "Create operation" });
  await create.focus();
  await create.press("Enter");
  await expect(page).toHaveURL(/\/payouts\/[0-9a-f-]+$/);

  const { busy, lost } = await page.evaluate(() => {
    const w = window as unknown as { busy: boolean; lost: boolean };
    return { busy: w.busy, lost: w.lost };
  });
  expect(busy).toBe(true);
  expect(lost).toBe(false);
});

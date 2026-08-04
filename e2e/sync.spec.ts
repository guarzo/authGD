import { expect, test } from "@playwright/test";
import { syncRun } from "../src/db/schema";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

const T0 = new Date("2026-08-03T03:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

/**
 * A healthy page with exactly one job broken — the state the strip exists to
 * make obvious. membership carries a real change, purge a fully zero result,
 * wanderer the failure.
 */
async function seedRuns() {
  await db.insert(syncRun).values([
    {
      jobType: "membership",
      startedAt: at(0),
      finishedAt: at(1200),
      status: "ok",
      counts: {
        checked: 12,
        promoted: 1,
        demoted: 0,
        invalid: 0,
        unresolved: 0,
        stale: 0,
      },
    },
    {
      jobType: "wanderer",
      startedAt: at(2000),
      finishedAt: at(2900),
      status: "failed",
      errorSummary: "acl read failed: 502 from wanderer",
      counts: null,
    },
    {
      jobType: "purge",
      startedAt: at(4000),
      finishedAt: at(4300),
      status: "ok",
      counts: { sessions: 0, oauthTransactions: 0, outbox: 0 },
    },
  ]);
}

async function asAdmin(context: import("@playwright/test").BrowserContext) {
  const admin = await seedMember(db, { name: "Boss", tier: "flygd", isAdmin: true });
  await context.addCookies([await sessionCookieFor(db, admin.id)]);
  return admin;
}

test("the strip answers per job, and only the unhealthy one is open", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const rows = page.locator(".strip__disc > summary");
  await expect(rows).toHaveCount(3);

  // Health and cadence sit on the summary row, so the answer is readable
  // without opening anything.
  const wanderer = page
    .locator(".strip__job", { hasText: "wanderer" })
    .locator(".strip__disc > summary");
  await expect(wanderer).toContainText("failed");
  await expect(wanderer).toContainText("hourly :10");

  const membership = page
    .locator(".strip__job", { hasText: "membership" })
    .first()
    .locator(".strip__disc > summary");
  await expect(membership).toContainText("ok");
  await expect(membership).toContainText("every 30m");

  // The failure is expanded; the healthy jobs are not.
  await expect(wanderer).toHaveAttribute("aria-expanded", "true");
  await expect(membership).toHaveAttribute("aria-expanded", "false");
});

test("a collapsed job opens from the keyboard", async ({ page, context }) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const purge = page
    .locator(".strip__job", { hasText: "purge" })
    .locator(".strip__disc > summary");
  await expect(purge).toHaveAttribute("aria-expanded", "false");
  await purge.focus();
  await page.keyboard.press("Enter");
  await expect(purge).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(purge).toHaveAttribute("aria-expanded", "false");
});

test("counts become columns, an all-zero run collapses to one token", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const membership = page.locator(".strip__job", { hasText: "membership" }).first();
  await membership.locator(".strip__disc > summary").click();
  const headers = membership.locator("thead th");
  // checked and promoted moved; demoted/invalid/unresolved/stale were zero on
  // every run in the window and so earn no column.
  await expect(headers).toHaveText([
    "Started",
    "Took",
    "Status",
    "checked",
    "promoted",
    "Raw",
  ]);
  await expect(membership.locator("tbody td").nth(1)).toHaveText("1.2s");

  const purge = page.locator(".strip__job", { hasText: "purge" });
  await purge.locator(".strip__disc > summary").click();
  await expect(purge.locator("tbody")).toContainText("no change");
  // Full payload still reachable behind the disclosure.
  await purge.locator("tbody summary").click();
  await expect(purge.locator(".json__full")).toContainText('"sessions": 0');
});

test("no permanently empty error column; the error rides the status cell", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const wanderer = page.locator(".strip__job", { hasText: "wanderer" });
  await expect(wanderer.locator("thead th", { hasText: "Error" })).toHaveCount(0);
  await expect(wanderer.locator("tbody tr").first()).toContainText(
    "acl read failed: 502 from wanderer",
  );
  // One timestamp and a duration, not two timestamps. Asserted on the wide
  // rendering rather than the cell: the cell also carries the narrow
  // rendering (`display: none` above 40rem), and `toHaveText` reads
  // textContent, which includes a subtree that is not being rendered.
  await expect(wanderer.locator("tbody td").first().locator(".only-wide")).toHaveText(
    "2026-08-03 03:00:02",
  );
  await expect(wanderer.locator("tbody td").nth(1)).toHaveText("900ms");
});

test("sync everything now reports back", async ({ page, context }) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  await page.getByRole("button", { name: "Sync everything now" }).click();
  const notice = page.getByRole("status");
  await expect(notice).toContainText("Sync queued for every account");
  await expect(page).toHaveURL(/queued=all/);
});

/**
 * The runs table's 44rem floor is a 704px floor — ~384px of forced horizontal
 * scroll inside a 320px screen, on the page an admin opens *because* something
 * looks wrong. The ISO stamp in Started is the widest cell in the row and the
 * least of its meaning at that width, so below 40rem it reads as elapsed time
 * and the floor comes off.
 */
test("the runs table gives up its width floor and its ISO stamp at 320px", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/sync");

  const wanderer = page.locator(".strip__job", { hasText: "wanderer" });
  const started = wanderer.locator("tbody tr").first().locator("td").first();

  // Visibility, not text: `toHaveText` reads textContent, which includes the
  // `display: none` subtree, so a text assertion on the cell passes at both
  // widths and asserts nothing about the breakpoint. `useInnerText` does not
  // rescue it either — innerText falls back to textContent for an element that
  // is not being rendered.
  await expect(started.locator(".only-wide")).toBeHidden();
  await expect(started.locator(".only-narrow")).toBeVisible();
  await expect(started.locator("time")).toHaveText(/ago|running/);

  // Reflow (WCAG 1.4.10) is not permission to destroy data: the exact stamp
  // stays in the accessibility tree even though the visible text is relative.
  // `title` would not do — VoiceOver and TalkBack do not announce it, and touch
  // cannot reach it.
  await expect(started.locator(".visually-hidden")).toHaveText(
    /^started \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/,
  );

  // The thing an admin actually feels: the region's overflow at 320px. A 44rem
  // floor against a ~286px region is ~418px of forced scroll; releasing the
  // floor and the stamp cuts it to well under a screenful, so half a region is
  // a threshold neither font drift nor a new counter column can flip.
  const fit = await wanderer.locator(".scroller").evaluate((el) => ({
    overflow: el.scrollWidth - el.clientWidth,
    clientWidth: el.clientWidth,
  }));
  expect(fit.overflow, "forced horizontal scroll at 320px").toBeLessThan(
    fit.clientWidth * 0.5,
  );

  // ...and the floor itself is gone, not merely out-measured by a lucky seed.
  const width = await wanderer
    .locator(".log--runs")
    .evaluate((el) => getComputedStyle(el).minWidth);
  expect(width).toBe("0px");

  // Above the breakpoint the exact stamp is what is rendered, unchanged.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(started.locator(".only-narrow")).toBeHidden();
  await expect(started.locator(".only-wide")).toBeVisible();
  await expect(started.locator(".only-wide")).toHaveText(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  );
});

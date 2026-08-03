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
  // One timestamp and a duration, not two timestamps.
  await expect(wanderer.locator("tbody td").first()).toHaveText("2026-08-03 03:00:02");
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

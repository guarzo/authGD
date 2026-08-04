/**
 * SEED TIMES HERE MUST BE RELATIVE TO `Date.now()`, NEVER A LITERAL DATE.
 *
 * Every row on this page now takes its health from how long ago the job ran
 * measured against its own cadence, so a run pinned to a fixed instant ages
 * out of whatever state the test meant it to be in. A `status: "ok"` row
 * seeded at a hardcoded date is `ok` on the day it is written and `overdue`
 * forever after — and it fails as a stale assertion in an unrelated test
 * months later, which is a long way from the line that caused it. Use `ago()`.
 */
import { expect, test } from "@playwright/test";
import { auditLog, outbox, syncRun } from "../src/db/schema";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

/** The seven jobs JOB_CRON schedules; every one of them earns a row. */
const JOB_COUNT = 7;

/**
 * A healthy page with exactly one job broken — the state the strip exists to
 * make obvious. membership carries a real change, purge a fully zero result,
 * wanderer the failure. The four jobs with no rows here are the never-run
 * case, and they appear too.
 */
async function seedRuns() {
  await db.insert(syncRun).values([
    {
      jobType: "membership",
      startedAt: ago(5 * MIN),
      finishedAt: ago(5 * MIN - 1200),
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
      startedAt: ago(4 * MIN),
      finishedAt: ago(4 * MIN - 900),
      status: "failed",
      errorSummary: "acl read failed: 502 from wanderer",
      counts: null,
    },
    {
      jobType: "purge",
      startedAt: ago(2 * MIN),
      finishedAt: ago(2 * MIN - 300),
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

const summaryFor = (page: import("@playwright/test").Page, job: string) =>
  page
    .locator(`.strip__job:has(.strip__name:text-is("${job}"))`)
    .locator("> .strip__disc > summary");

test("the strip answers per job, and only the unhealthy one is open", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const rows = page.locator(".strip__disc > summary");
  await expect(rows).toHaveCount(JOB_COUNT);

  // Health and cadence sit on the summary row, so the answer is readable
  // without opening anything.
  const wanderer = summaryFor(page, "wanderer");
  await expect(wanderer).toContainText("failed");
  await expect(wanderer).toContainText("hourly :10");

  const membership = summaryFor(page, "membership");
  await expect(membership).toContainText("ok");
  await expect(membership).toContainText("every 30m");

  // The failure is expanded; the healthy jobs are not.
  await expect(wanderer).toHaveAttribute("aria-expanded", "true");
  await expect(membership).toHaveAttribute("aria-expanded", "false");
});

/**
 * A job JOB_CRON schedules but that has no rows at all. Before this it was an
 * absent row, and an absent row is the hardest thing on a page for an eye to
 * catch.
 */
test("a scheduled job that has never run gets a row saying so", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const contacts = summaryFor(page, "contacts");
  await expect(contacts).toContainText("no runs");
  await expect(contacts).toContainText("hourly :05");
  // "never", not "running": a null timestamp used to format as an in-flight
  // run, so this row would have announced itself as working.
  await expect(contacts).toContainText("never");
  // Nothing to diagnose, so nothing to open.
  await expect(contacts).toHaveAttribute("aria-expanded", "false");

  // ...and it is not a `<time>` with no machine value.
  await expect(contacts.locator("time")).toHaveCount(0);

  await contacts.click();
  await expect(page.locator(".strip__job", { hasText: "contacts" })).toContainText(
    "No runs recorded for this job yet.",
  );
});

test("a collapsed job opens from the keyboard", async ({ page, context }) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const purge = summaryFor(page, "purge");
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
  await membership.locator("> .strip__disc > summary").click();
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
  await purge.locator("> .strip__disc > summary").click();
  await expect(purge.locator("tbody")).toContainText("no change");
  // Full payload still reachable behind the disclosure.
  await purge.locator("tbody summary").click();
  await expect(purge.locator(".json__full")).toContainText('"sessions": 0');
});

/**
 * The Raw disclosure is a control on every run row, and `.json` gave it type
 * but no box — 18.6px, under WCAG 2.5.8's 24px floor and under both sizes
 * DESIGN.md commits to. It sits in a table cell, not in a sentence, so the
 * inline-target exception does not cover it.
 */
test("the raw-payload disclosure clears the 24px hit target", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const purge = page.locator(".strip__job", { hasText: "purge" });
  await purge.locator("> .strip__disc > summary").click();
  const box = await purge.locator("tbody summary").first().boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
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
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  );
  await expect(wanderer.locator("tbody td").nth(1)).toHaveText("900ms");
});

/* --- The time model ------------------------------------------------------ */

/**
 * The page's one job, and the case it used to answer wrong: with the worker
 * dead every row still renders whatever it last succeeded at, so the strip
 * alone cannot say the process stopped.
 */
test("the worker line reports liveness, and a dead worker says so", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const worker = page.locator(".worker");
  await expect(worker).toHaveText(/worker · last run \d+m ago/i);
  // Healthy is a quiet line, not a notice.
  await expect(page.locator(".notice--bad")).toHaveCount(0);

  // Nothing has run in four hours: the strip's newest row is old, so the
  // process itself is the finding.
  await resetDb(db);
  await asAdmin(context);
  await db.insert(syncRun).values({
    jobType: "membership",
    startedAt: ago(240 * MIN),
    finishedAt: ago(239 * MIN),
    status: "ok",
    counts: null,
  });
  await page.goto("/admin/sync");
  await expect(page.locator(".notice--bad .worker")).toHaveText(/worker · no run in 4h/i);
});

/**
 * A dead worker puts every row overdue at once. Opening on overdue would
 * expand all seven drawers together and destroy exactly the "this one job
 * needs you" signal auto-open exists to create — so overdue is a visible
 * state and not an actionable one.
 */
test("an overdue job is flagged amber but does not open itself", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await db.insert(syncRun).values({
    // Four hours since a 30-minute job last succeeded.
    jobType: "membership",
    startedAt: ago(240 * MIN),
    finishedAt: ago(239 * MIN),
    status: "ok",
    counts: null,
  });
  await page.goto("/admin/sync");

  const membership = summaryFor(page, "membership");
  await expect(membership).toContainText("overdue");
  await expect(membership.locator(".st--warn")).toHaveCount(1);
  await expect(membership).toHaveAttribute("aria-expanded", "false");

  // ...and no other row opened either: overdue never auto-expands.
  await expect(page.locator('.strip__disc > summary[aria-expanded="true"]')).toHaveCount(
    0,
  );
});

/**
 * A run that started and never came back. It used to read `running` in neutral
 * grey identically at four seconds and at four days.
 *
 * How long it has been wedged still has to be on the row — but it is the
 * ticking `.ago` that carries it, not the status word. The label deliberately
 * holds no number: a server-rendered "stuck 2h" beside a client-ticking "2h
 * ago" is two clocks describing one instant, and they disagree within the
 * hour on a tab left open.
 */
test("a wedged run reads stuck, with its elapsed time, and opens", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await db.insert(syncRun).values([
    {
      jobType: "membership",
      startedAt: ago(120 * MIN),
      finishedAt: null,
      status: null,
      counts: null,
    },
    // A second job in flight for four seconds, to prove the threshold is a
    // threshold and not "anything unfinished is stuck".
    {
      jobType: "contacts",
      startedAt: ago(4000),
      finishedAt: null,
      status: null,
      counts: null,
    },
  ]);
  await page.goto("/admin/sync");

  const membership = summaryFor(page, "membership");
  await expect(membership.locator(".st")).toHaveText("stuck");
  // The duration is not optional — it is the whole finding. An unfinished run
  // has no finishedAt, so the row's time element is the age of its start.
  await expect(membership.locator(".ago")).toHaveText("2h ago");
  await expect(membership).toHaveAttribute("aria-expanded", "true");

  const contacts = summaryFor(page, "contacts");
  await expect(contacts.locator(".st")).toHaveText("running");
  await expect(contacts.locator(".ago")).toHaveText(/^\d+s ago$/);
  await expect(contacts).toHaveAttribute("aria-expanded", "false");
});

/* --- Controls ------------------------------------------------------------ */

test("the fan-out reports back, and Refresh clears the flag", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  // The live region is in the DOM before the press, so the announcement is an
  // update to a registered region rather than an inserted one.
  await expect(page.getByRole("status")).toHaveCount(1);

  await page
    .getByRole("button", { name: "Sync membership, contacts, map, Discord" })
    .click();
  const notice = page.getByRole("status");
  await expect(notice).toContainText("Membership, contacts, map and Discord queued");
  await expect(page).toHaveURL(/queued=all/);

  // Refresh drops ?queued=, so a reload hours later does not re-show a stale
  // "queued a few seconds ago".
  await page.getByRole("link", { name: "Refresh" }).click();
  await expect(page).toHaveURL(/\/admin\/sync$/);
  await expect(page.getByRole("status")).toHaveText("");
  await expect(page.locator(".btn-row__stamp")).toHaveText(
    /checked \d{2}:\d{2}:\d{2} UTC/i,
  );
});

/**
 * The lever a failed row actually wants: before this, retrying wanderer after
 * a 502 meant a fan-out that also re-ran three jobs that were fine.
 */
test("a failed row re-runs its own job", async ({ page, context }) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  // wanderer is already open — that is the whole point of auto-open.
  await page.getByRole("button", { name: "Re-run wanderer" }).click();
  await expect(page).toHaveURL(/queued=wanderer/);
  await expect(page.getByRole("status")).toContainText("wanderer queued");

  const queued = await db.select().from(outbox);
  expect(queued.map((r) => r.payload)).toEqual([{ kind: "job", jobType: "wanderer" }]);

  // The audit row names the job rather than the literal "all", and keeps the
  // action string the audit page's prefix filter already matches.
  const audit = await db.select().from(auditLog);
  expect(audit.map((r) => [r.action, r.target])).toEqual([
    ["sync.requested", "wanderer"],
  ]);
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
  await expect(started.locator("time")).toHaveText(/ago/);

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

  // The new per-row control must not reintroduce what that breakpoint removed:
  // the page itself still does not scroll sideways.
  const doc = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(doc.scroll, "page-level horizontal scroll at 320px").toBeLessThanOrEqual(
    doc.client,
  );

  // Above the breakpoint the exact stamp is what is rendered, unchanged.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(started.locator(".only-narrow")).toBeHidden();
  await expect(started.locator(".only-wide")).toBeVisible();
  await expect(started.locator(".only-wide")).toHaveText(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  );
});

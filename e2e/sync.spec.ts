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
import { JOB_CRON } from "../src/core/schedules";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();
test.afterAll(() => pool.end());
test.beforeEach(() => resetDb(db));

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

/**
 * Every job JOB_CRON schedules earns a row. Read from the schedules table
 * itself rather than restated as a number: `getSyncStatus` seeds from that same
 * table, so a hand-written count here would be a fourth enumeration of the job
 * list — and one that passes on the day a job is added and fails as an
 * off-by-one in an unrelated-looking test.
 */
const JOB_COUNT = Object.keys(JOB_CRON).length;

/** The page's own Started-column format (see `fmt` in page.tsx). */
const stamp = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

/**
 * A healthy page with exactly one job broken — the state the strip exists to
 * make obvious. membership carries a real change, purge a fully zero result,
 * wanderer the failure. The four jobs with no rows here are the never-run
 * case, and they appear too.
 *
 * Returns the instants it seeded, so assertions can pin the exact value a cell
 * renders instead of a shape regex that any timestamp would satisfy.
 */
async function seedRuns() {
  const seeded = {
    membership: { startedAt: ago(5 * MIN), finishedAt: ago(5 * MIN - 1200) },
    wanderer: { startedAt: ago(4 * MIN), finishedAt: ago(4 * MIN - 900) },
    // Newest by insertion order, so this is the row the worker line reports.
    purge: { startedAt: ago(2 * MIN), finishedAt: ago(2 * MIN - 300) },
  };
  await db.insert(syncRun).values([
    {
      jobType: "membership",
      ...seeded.membership,
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
      ...seeded.wanderer,
      status: "failed",
      errorSummary: "acl read failed: 502 from wanderer",
      counts: null,
    },
    {
      jobType: "purge",
      ...seeded.purge,
      status: "ok",
      counts: { sessions: 0, oauthTransactions: 0, outbox: 0 },
    },
  ]);
  return seeded;
}

async function asAdmin(context: import("@playwright/test").BrowserContext) {
  const admin = await seedMember(db, { name: "Boss", tier: "member", isAdmin: true });
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
 * The fact the primary button's own label used to spell out ("Sync
 * membership, contacts, wanderer, discord-roles") and now doesn't, on the
 * strength of the strip carrying it instead — asserted on the accessibility
 * tree, not just on the page's visible text, since a group label painted on
 * with `aria-hidden` would look identical here to a sighted reviewer while
 * losing the fact for anyone using a screen reader. One `role="list"` per
 * group, each one's accessible name its own visible heading, and each job
 * still reachable inside it.
 */
test("the strip's three groups are three named lists, not one flat one with the labels painted over", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  // sweep: membership, contacts, wanderer, discord-roles.
  const sweep = page.getByRole("list", { name: "Sweep" });
  await expect(sweep).toBeVisible();
  await expect(sweep.getByRole("listitem")).toHaveCount(4);

  // on-demand: membership-recheck alone.
  const onDemand = page.getByRole("list", { name: "On-demand" });
  await expect(onDemand.getByRole("listitem")).toHaveCount(1);

  // housekeeping: token-health, purge.
  const housekeeping = page.getByRole("list", { name: "Housekeeping" });
  await expect(housekeeping.getByRole("listitem")).toHaveCount(2);

  // Every job is reachable from inside its own group's list, not just from
  // the page as a whole.
  await expect(sweep.locator(".strip__job", { hasText: "membership" })).toHaveCount(1);
  await expect(housekeeping.locator(".strip__job", { hasText: "purge" })).toHaveCount(1);

  // The visible label itself renders as ordinary text — not aria-hidden —
  // since it is what names the list an assistive technology user reaches.
  const sweepHeading = page.locator(".strip__group", { hasText: "Sweep" });
  await expect(sweepHeading).not.toHaveAttribute("aria-hidden", "true");
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

/**
 * The scroll region inside a collapsed row measures 0×0, so it correctly holds
 * no tab stop while shut — and getting the stop back when the drawer opens
 * rests entirely on the ResizeObserver firing. That is engine-dependent:
 * Chromium hides closed `<details>` content with `content-visibility: hidden`
 * rather than `display: none`, which puts the observed element in skipped
 * contents. If the observation is missed the runs table's overflow is
 * permanently unreachable by keyboard, with nothing on screen saying so — the
 * edge fades are suppressed by the same 0×0 measurement.
 */
test("opening a healthy row hands its scroll region a tab stop", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  // Narrow enough that the runs table genuinely overflows: at desktop width it
  // fits, and a region that fits is meant to have no stop.
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/sync");

  const membership = summaryFor(page, "membership");
  await expect(membership).toHaveAttribute("aria-expanded", "false");

  const region = page
    .locator(".strip__job", { hasText: "membership" })
    .locator(".scroller");
  await membership.click();
  await expect(membership).toHaveAttribute("aria-expanded", "true");
  await expect(region).toHaveAttribute("tabindex", "0");

  // ...and it is reachable, not merely marked: the region is the next stop
  // after the summary that opened it.
  await membership.focus();
  await page.keyboard.press("Tab");
  await expect(region).toBeFocused();
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
  const seeded = await seedRuns();
  await page.goto("/admin/sync");

  const wanderer = page.locator(".strip__job", { hasText: "wanderer" });
  await expect(wanderer.locator("thead th", { hasText: "Error" })).toHaveCount(0);
  await expect(wanderer.locator("tbody tr").first()).toContainText(
    "acl read failed: 502 from wanderer",
  );
  // One timestamp and a duration, not two timestamps. The exact seeded instant,
  // not a shape: a regex for "some ISO-ish stamp" passes just as happily on the
  // finished time, on another run's time, or on `Date.now()`. Asserted on the
  // wide rendering rather than the cell: the cell also carries the narrow
  // rendering (`display: none` above 40rem), and `toHaveText` reads
  // textContent, which includes a subtree that is not being rendered.
  await expect(wanderer.locator("tbody td").first().locator(".only-wide")).toHaveText(
    stamp(seeded.wanderer.startedAt),
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
  // "2m", not `\d+m`: purge is the newest seeded run at 2 minutes old, and a
  // digit-agnostic regex passes just as happily on membership's 5m — which is
  // exactly the bug this line exists to catch, since reporting the OLDEST run
  // as the worker's liveness would make a dead worker look alive.
  await expect(worker).toHaveText("worker · last run 2m ago");
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

  await page.getByRole("button", { name: "Sync now" }).click();
  const notice = page.getByRole("status");
  await expect(notice).toContainText(
    "membership, contacts, wanderer and discord-roles queued for every account",
  );
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
  const admin = await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  // wanderer is already open — that is the whole point of auto-open.
  await page.getByRole("button", { name: "Re-run wanderer" }).click();
  await expect(page).toHaveURL(/queued=wanderer/);
  await expect(page.getByRole("status")).toContainText("wanderer queued");

  const queued = await db.select().from(outbox);
  expect(queued.map((r) => r.payload)).toEqual([{ kind: "job", jobType: "wanderer" }]);

  // The audit row names the job rather than the literal "all", keeps the action
  // string the audit page's prefix filter already matches, and attributes the
  // press to the admin who made it — dropping the actor from this assertion
  // would let the row be written as "system" and still pass, which is the one
  // field an audit log exists for.
  const audit = await db.select().from(auditLog);
  expect(audit.map((r) => [r.actor, r.action, r.target])).toEqual([
    [admin.id, "sync.requested", "wanderer"],
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
  const seeded = await seedRuns();
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
    `started ${stamp(seeded.wanderer.startedAt)} UTC`,
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
    stamp(seeded.wanderer.startedAt),
  );
});

/* --- Queued ---------------------------------------------------------------- */

/**
 * An undispatched outbox row that fans out to a job is a fact about the job,
 * not about the health token that already sits on that row — `queued` is not
 * a `RowHealth` member (see run-health.ts), so the row must still read its own
 * status (here: healthy, and closed) while separately marking that something
 * is coming. Also proves the marker never opens a drawer on its own — the same
 * "visible, not actionable" rule `overdue` already gets.
 */
test("a job with work queued for it gets a marker, and it does not open the drawer", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  // Targets exactly one job type — see jobsFor's "job" arm.
  await db.insert(outbox).values({ payload: { kind: "job", jobType: "contacts" } });
  await page.goto("/admin/sync");

  const contacts = summaryFor(page, "contacts");
  await expect(contacts.locator(".strip__queued")).toHaveCount(1);
  await expect(contacts.locator(".visually-hidden", { hasText: "queued" })).toHaveCount(
    1,
  );
  await expect(contacts).toHaveAttribute("aria-expanded", "false");

  // A job with nothing queued for it carries no marker at all.
  const membership = summaryFor(page, "membership");
  await expect(membership.locator(".strip__queued")).toHaveCount(0);
});

/**
 * A member-triggered fan-out (an account merge, a Discord link) reaches the
 * same jobs the same way an admin's own "Sync now" does, and counts as
 * queued identically — the marker names the job, never the requester.
 */
test("an account-kind payload queues its jobs the same as an admin fan-out", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await db.insert(outbox).values({
    payload: { kind: "account", accountId: "11111111-1111-1111-1111-111111111111" },
  });
  await page.goto("/admin/sync");

  // account fans out to membership, contacts, wanderer and discord-roles.
  for (const job of ["membership", "contacts", "wanderer", "discord-roles"]) {
    await expect(summaryFor(page, job).locator(".strip__queued")).toHaveCount(1);
  }
  await expect(summaryFor(page, "purge").locator(".strip__queued")).toHaveCount(0);
});

/**
 * The dispatcher polls the outbox every ~2s, so a marker under that age is
 * the normal gap between an enqueue and the next poll — quiet on purpose.
 * Once it has sat unpicked for a while, the accessible text says how long,
 * and past 15 minutes the ring itself escalates: at that distance the
 * dispatcher (`startDispatcher`) is wedged, not merely busy.
 */
test("a queue that has sat unpicked for a while says so, and escalates past 15 minutes", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await db.insert(outbox).values([
    { payload: { kind: "job", jobType: "contacts" }, createdAt: ago(5 * MIN) },
    { payload: { kind: "job", jobType: "membership" }, createdAt: ago(20 * MIN) },
  ]);
  await page.goto("/admin/sync");

  const contacts = summaryFor(page, "contacts");
  await expect(contacts.locator(".strip__queued")).toHaveCount(1);
  await expect(contacts.locator(".strip__queued--stuck")).toHaveCount(0);
  await expect(contacts.locator(".visually-hidden", { hasText: "queued" })).toHaveText(
    ", queued 5m ago",
  );

  const membership = summaryFor(page, "membership");
  await expect(membership.locator(".strip__queued--stuck")).toHaveCount(1);
  await expect(membership.locator(".visually-hidden", { hasText: "queued" })).toHaveText(
    ", queued 20m ago",
  );
});

/* --- Run collapsing --------------------------------------------------------- */

/**
 * Four consecutive runs sharing one outcome collapse to a single row that
 * still carries how many runs it stands for — as cell text, not as a count a
 * screen reader has to infer from a shape — and the range they span.
 * `collapseRuns` never folds a still-running run into a finished one's row,
 * so the newest, in-flight run stays its own row above the group. Four, not
 * five: `getSyncStatus` windows each job to its newest 5 runs, and a fifth
 * finished run here would silently fall outside that window rather than
 * testing the collapse itself.
 */
test("consecutive identical runs collapse to one row; an in-flight run never joins one", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  const finished = Array.from({ length: 4 }, (_, i) => ({
    jobType: "purge",
    startedAt: ago((10 - i) * MIN),
    finishedAt: ago((10 - i) * MIN - 500),
    status: "ok" as const,
    counts: { sessions: 0, oauthTransactions: 0, outbox: 0 },
  }));
  await db.insert(syncRun).values([
    ...finished,
    // Newest row: still running, identical shape aside from finishedAt/status
    // — the one difference `sameOutcome` exists to catch.
    {
      jobType: "purge",
      startedAt: ago(30_000),
      finishedAt: null,
      status: null,
      counts: null,
    },
  ]);
  await page.goto("/admin/sync");

  const purge = page.locator(".strip__job", { hasText: "purge" });
  await purge.locator("> .strip__disc > summary").click();
  const rows = purge.locator("tbody tr");
  // The in-flight run plus one collapsed row for the four finished runs.
  await expect(rows).toHaveCount(2);

  await expect(rows.nth(0)).toContainText("still running");

  const group = rows.nth(1);
  await expect(group).toContainText("4 runs");
  // The count now lives in Started (cell 1) beside the range, not in Took —
  // Took's own header promises a duration, and a screen reader in
  // table-navigation mode used to hear the count under that column's
  // header instead.
  const startedCell = group.locator("td").first();
  await expect(startedCell.locator(".strip__group-count")).toHaveText("4 runs");
  // The count is not the only thing that says "several": the row also states
  // the span of time it covers, readable straight from the cell.
  await expect(startedCell.locator(".only-wide")).toContainText("–");
  // All four seeded runs take exactly 500ms, so Took shows the single value,
  // not a degenerate "500ms – 500ms" range.
  await expect(group.locator("td").nth(1)).toHaveText("500ms");
});

/**
 * Below 40rem the group row's Started cell swaps to `RelativeTime` plus a
 * visually-hidden precise stamp — same swap the single-run branch makes. That
 * hidden text used to name only the group's start, so the group's END, and
 * the count beside it, were unreachable in the accessibility tree entirely
 * below this breakpoint.
 */
test("a collapsed row's hidden text carries both ends, and the count exactly once", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  const finished = Array.from({ length: 3 }, (_, i) => ({
    jobType: "purge",
    startedAt: ago((10 - i) * MIN),
    finishedAt: ago((10 - i) * MIN - 500),
    status: "ok" as const,
    counts: { sessions: 0, oauthTransactions: 0, outbox: 0 },
  }));
  await db.insert(syncRun).values(finished);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/sync");

  const purge = page.locator(".strip__job", { hasText: "purge" });
  await purge.locator("> .strip__disc > summary").click();
  const group = purge.locator("tbody tr").first();
  const startedCell = group.locator("td").first();

  await expect(startedCell.locator(".only-wide")).toBeHidden();
  await expect(startedCell.locator(".only-narrow")).toBeVisible();
  await expect(startedCell.locator(".visually-hidden")).toHaveText(
    `started ${stamp(finished[0].startedAt)} UTC, ended ${stamp(finished[2].finishedAt)} UTC`,
  );
  // The count reaches a screen reader from `.strip__group-count`, which is
  // unconditional, so it must NOT also appear in the visually-hidden text
  // beside it — at this width that span and this one are the only two things
  // in the cell still in the accessibility tree, and restating the count
  // there announced "3 runs" twice.
  await expect(startedCell.locator(".strip__group-count")).toBeVisible();
  await expect(startedCell.locator(".strip__group-count")).toHaveText("3 runs");
});

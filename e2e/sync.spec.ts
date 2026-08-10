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
import { sql } from "drizzle-orm";
import { auditLog, outbox, syncRun } from "../src/db/schema";
import { JOB_CRON } from "../src/core/schedules";
import { resetDb, seedMember, sessionCookieFor, testDb } from "./helpers";

const { db, pool } = testDb();

/**
 * Whether `setHeartbeat` built the pgboss objects, and so whether this file is
 * the one that has to remove them.
 *
 * Deleting the sentinel row is not enough on its own. `resetDb` truncates this
 * app's tables and pgboss is not one of them, so what this file creates outlives
 * it — and an existing-but-empty `pgboss.version` is worse to leave behind than
 * the fake row, because `boss.start()` reads that table to decide whether its
 * schema is already installed and an empty one sends it down the migrate path
 * for tables it never created. Restore what was here; drop what was not.
 */
const pgboss = {
  probed: false,
  createdSchema: false,
  createdVersionTable: false,
  hadRow: false,
};

test.afterAll(async () => {
  try {
    if (pgboss.createdSchema) {
      await db.execute(sql`drop schema pgboss cascade`);
    } else if (pgboss.createdVersionTable) {
      await db.execute(sql`drop table pgboss.version`);
    } else if (pgboss.probed && !pgboss.hadRow) {
      await db.execute(sql`delete from pgboss.version where version = 999999`);
    }
  } finally {
    // Always, whatever the cleanup did: a leaked pool hangs the run on open
    // handles instead of reporting whatever the tests actually found.
    await pool.end();
  }
});
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

/**
 * Controls the worker-liveness signal the top-of-page line and its alarm
 * Notice now read (`workerHeartbeat`, @/services/health): pg-boss's own
 * `pgboss.version.maintained_on`, not `sync_run` — see the "the worker line
 * reports liveness" test below for why. pg-boss creates that schema itself
 * on a real worker's `boss.start()` (node_modules/pg-boss/src/plans.js), and
 * e2e never starts a real worker (dry-run, `next dev` only), so it does not
 * exist here until a test asks for it — hence `IF NOT EXISTS` on both. Not
 * touched by `resetDb`, which only truncates this app's own tables, so a
 * test that calls `resetDb` between two heartbeats still has to set the
 * second one explicitly rather than relying on the first having been cleared.
 *
 * Records what it had to build, so `afterAll` above can put the database back
 * exactly as it found it rather than guessing.
 */
async function setHeartbeat(at: Date) {
  // Probed once, on the first call only. A second probe would see the schema,
  // table and row this function itself created a test earlier and conclude they
  // were pre-existing — which is precisely backwards, and would leave the fake
  // row behind for the next run to trip over.
  if (!pgboss.probed) {
    pgboss.probed = true;
    const schema = await db.execute(
      sql`select 1 from information_schema.schemata where schema_name = 'pgboss'`,
    );
    pgboss.createdSchema = schema.rows.length === 0;
    if (!pgboss.createdSchema) {
      const table = await db.execute(
        sql`select 1 from information_schema.tables
            where table_schema = 'pgboss' and table_name = 'version'`,
      );
      pgboss.createdVersionTable = table.rows.length === 0;
      if (!pgboss.createdVersionTable) {
        const row = await db.execute(
          sql`select 1 from pgboss.version where version = 999999`,
        );
        pgboss.hadRow = row.rows.length > 0;
      }
    }
  }

  await db.execute(sql`create schema if not exists pgboss`);
  await db.execute(sql`
    create table if not exists pgboss.version (
      version int primary key,
      maintained_on timestamptz,
      cron_on timestamptz,
      monitored_on timestamptz
    )
  `);
  await db.execute(sql`
    insert into pgboss.version (version, maintained_on)
    values (999999, ${at})
    on conflict (version) do update set maintained_on = excluded.maintained_on
  `);
}

const summaryFor = (page: import("@playwright/test").Page, job: string) =>
  page
    .locator(`.strip__job:has(.strip__name:text-is("${job}"))`)
    .locator("> .strip__disc > summary");

/**
 * Opens the housekeeping strip's own collapsed line (5.3) if it is not open
 * already, so `purge` and `token-health` become reachable for the tests that
 * still address those two rows directly. Closed `<details>` content is not
 * merely off-screen — Chromium marks it `content-visibility: hidden`, which
 * Playwright treats the same as `display: none` for click/focus targeting —
 * so a test seeding a healthy purge run and then clicking its own disclosure
 * without this first would fail on an element it never made visible. A no-op
 * when a seeded fault already auto-opened the group, which is why this checks
 * `open` rather than unconditionally clicking (a second click on an
 * already-open `<details>` would close it again).
 */
async function openHousekeeping(page: import("@playwright/test").Page) {
  const group = page.locator(".strip__group-disc");
  if ((await group.getAttribute("open")) === null) {
    await group.locator("> summary").click();
  }
}

/**
 * R4, both directions, on the one column that now splits its meaning across
 * the two channels. Moving "UTC" out of eight per-row strings and into the
 * column header (5.2) is only sound while every row that needs the word still
 * carries it in its accessible name: `.strip__head` is `aria-hidden="true"`,
 * so the header cannot supply it to anyone using a screen reader, and a row
 * reading "daily 03:00" with no timezone anywhere in the AT channel would be
 * information living only in the visual one.
 *
 * Asserted here rather than trusted to `splitCadenceUtc`'s unit tests: that
 * function is pure and correct in isolation, but what R4 constrains is the
 * *rendered accessible name*, which is a concatenation this file is the only
 * place able to see. A refactor that dropped the `visually-hidden` span, or
 * that let it collapse against the neighbouring text into "03:00UTC", would
 * leave every unit test green.
 *
 * Both fixed-hour cadences are covered — `membership-recheck` (weekly, plain)
 * and `token-health` (daily, inside the collapsed housekeeping group) — plus
 * an interval row, which must NOT gain the word: `every 30m` means the same
 * thing in every timezone, and a hidden "UTC" there would be the opposite
 * defect, stating something to screen readers that is not true of the value.
 */
test("a fixed-hour cadence keeps UTC in its accessible name, and an interval one never gains it", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  // The header carries it visually, exactly once, for sighted readers.
  await expect(page.locator(".strip__h-cadence")).toHaveText("Cadence (UTC)");

  // What a sighted reader actually sees in the cell: the same subtree with
  // its visually-hidden spans removed. `textContent`/`toHaveText` would count
  // the hidden " UTC" as visible — it is clipped, not `display: none` — and
  // would pass whether or not 5.2 ever removed the suffix from the visible
  // string, which is the exact regression this test exists to catch.
  const seenText = (row: ReturnType<typeof summaryFor>) =>
    row.locator(".strip__cadence").evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll(".visually-hidden").forEach((n) => n.remove());
      return (copy.textContent ?? "").trim();
    });

  const recheck = summaryFor(page, "membership-recheck");
  // Visible text has shed the suffix — that is the whole point of 5.2 …
  expect(await seenText(recheck)).toContain("Sun 04:00");
  expect(await seenText(recheck)).not.toContain("UTC");
  // … and the accessible name has not.
  await expect(recheck).toHaveAccessibleName(/Sun 04:00 UTC/);

  await openHousekeeping(page);
  const tokenHealth = summaryFor(page, "token-health");
  expect(await seenText(tokenHealth)).toContain("daily 03:00");
  expect(await seenText(tokenHealth)).not.toContain("UTC");
  await expect(tokenHealth).toHaveAccessibleName(/daily 03:00 UTC/);

  // A timezone-invariant cadence stays timezone-free in both channels.
  const membership = summaryFor(page, "membership");
  expect(await seenText(membership)).toContain("every 30m");
  await expect(membership).not.toHaveAccessibleName(/UTC/);
});

/**
 * The separation between an interval row's two cadence values, pinned. The
 * cell is a four-value concatenation split across a line break — "every 30m" /
 * "next HH:MM" — and the two must not run together into "every 30mnext 14:30"
 * in the AT channel, where the aria-hidden column header cannot help.
 *
 * Two sources could be supplying that gap: the explicit `{" "}` in the source
 * and Chromium's own accessible-name handling of the `<br>`. Measured by
 * deleting each in turn — without the space the name still reads "every 30m
 * next 17:30"; without the `<br>` it collapses to "every 30mnext 17:30". So
 * the break is what holds them apart today and the space is redundant, which
 * is exactly why this assertion is here rather than left to a comment: it
 * fails if a rewrite drops both.
 *
 * Deliberately not asserted on `textContent`: `visually-hidden` here is
 * clipped rather than `display: none`, so hidden text counts and the
 * assertion would pass either way. And `toHaveAccessibleName` normalises
 * whitespace, so this distinguishes one space from none — the whole question —
 * but not one from two.
 */
/**
 * The same defect as `/admin/access-lists`, on the denser of the two surfaces.
 * A `<summary>`'s accessible name is computed from its contents, and one of
 * these contents is `RelativeTime` — a client component on a shared 30s ticker
 * — so every job row's toggle renamed itself twice a minute with nothing about
 * the job having changed: SC 4.1.2 for a screen reader that re-announces a
 * control it sees renamed, SC 3.2.4 for a voice user whose remembered phrase
 * stops matching the page.
 *
 * Stability only. What the name *contains* is pinned by the three
 * `toHaveAccessibleName` cases above, which is the half that catches the
 * pre-built label drifting away from the visible content — the standing risk
 * of fixing this with `aria-label`, since the label replaces the computed name
 * outright and anything not restated leaves the assistive channel (R4).
 */
test("a job row's toggle does not rename itself as its timestamp ages", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  // Before `goto`: the clock has to be in place while the page's scripts load,
  // or the ticker captures the real timers on the way past.
  await page.clock.install();
  await page.goto("/admin/sync");

  const summary = summaryFor(page, "membership");
  const nameOf = () => summary.evaluate((el) => el.getAttribute("aria-label") ?? "");
  const before = await nameOf();
  // Non-empty, or the two reads would agree vacuously.
  expect(before).not.toBe("");
  expect(before).toContain("membership");

  // The visible "ago" moving is what proves the tick landed; without it this
  // would pass on a page where nothing ticked at all.
  const stamp = summary.locator(".ago");
  const stampBefore = await stamp.innerText();
  await page.clock.fastForward("05:00");
  await expect(stamp).not.toHaveText(stampBefore);

  expect(await nameOf(), "the toggle renamed itself as the clock moved").toBe(before);
});

test("an interval row's cadence and its next-run time stay separate words", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  await expect(summaryFor(page, "membership")).toHaveAccessibleName(
    /every 30m next \d{2}:\d{2}/,
  );
});

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
test("the strip's four groups are four named lists, not one flat one with the labels painted over", async ({
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

  // member-facing: location alone. Split out of housekeeping because a
  // member notices a stale location, where token-health and purge answer to
  // nobody but the admin reading this page.
  const memberFacing = page.getByRole("list", { name: "Member-facing" });
  await expect(memberFacing.getByRole("listitem")).toHaveCount(1);

  // on-demand: membership-recheck and access-lists, each reachable from a
  // dedicated control other than the fan-out.
  const onDemand = page.getByRole("list", { name: "On-demand" });
  await expect(onDemand.getByRole("listitem")).toHaveCount(2);

  // housekeeping: token-health, purge. Still a `role="list"` of 2 items once
  // opened — `getByRole` reads the accessibility tree, and Chromium excludes
  // a closed `<details>`'s content from it exactly the way it already does
  // for every job's own run-history drawer on this page, so the list has to
  // be opened first rather than merely present in the DOM.
  await openHousekeeping(page);
  const housekeeping = page.getByRole("list", { name: "Housekeeping" });
  await expect(housekeeping.getByRole("listitem")).toHaveCount(2);

  // Every job is reachable from inside its own group's list, not just from
  // the page as a whole.
  await expect(sweep.locator(".strip__job", { hasText: "membership" })).toHaveCount(1);
  await expect(memberFacing.locator(".strip__job", { hasText: "location" })).toHaveCount(
    1,
  );
  await expect(housekeeping.locator(".strip__job", { hasText: "purge" })).toHaveCount(1);

  // The visible label itself renders as ordinary text — not aria-hidden —
  // since it is what names the list an assistive technology user reaches.
  const sweepHeading = page.locator(".strip__group", { hasText: "Sweep" });
  await expect(sweepHeading).not.toHaveAttribute("aria-hidden", "true");
});

/**
 * Housekeeping's own line is the only surface a token-health or purge fault
 * has anywhere in the product (5.3) — a screen reader landing on this page
 * with the group still shut must still hear that something is wrong, and a
 * sighted admin must not have to open anything to see it either.
 */
test("housekeeping's collapsed line auto-expands when one of its jobs is failing", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await db.insert(syncRun).values({
    jobType: "token-health",
    startedAt: ago(2 * MIN),
    finishedAt: ago(2 * MIN - 300),
    status: "failed",
    errorSummary: "token refresh failed for 3 accounts",
    counts: null,
  });
  await page.goto("/admin/sync");

  const group = page.locator(".strip__group-disc");
  await expect(group).toHaveAttribute("open", "");
  const summary = group.locator("> summary");
  // Names the faulted job and its own health word, the same word the row
  // itself carries once the group is open — not a bare count, and not colour
  // alone: `Status` renders a tone AND this text together.
  await expect(summary).toContainText("token-health failed");
  await expect(summary.locator(".st--bad")).toHaveCount(1);

  // purge is clean and unaffected, but still reachable now that the group
  // opened on token-health's fault.
  const purge = summaryFor(page, "purge");
  await expect(purge).toBeVisible();
});

/**
 * The clean state states health, not just a count — "2 jobs" alone answers
 * "how many are folded behind this line" and leaves the actual question (is
 * anything wrong) for the admin to go find out.
 */
test("housekeeping's collapsed line states health when nothing needs attention", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns(); // purge: ok. token-health: no rows at all ("never", not a fault).
  await page.goto("/admin/sync");

  const group = page.locator(".strip__group-disc");
  await expect(group).not.toHaveAttribute("open", "");
  const summary = group.locator("> summary");
  await expect(summary).toHaveText("2 jobs · nothing needs attention");
  await expect(summary.locator(".st--ok")).toHaveCount(1);
});

/**
 * The collapsed line is the only place the flagged member names appear while
 * the group is shut, and it is a sentence rendered as a `Status` — so it
 * inherited `.st`'s `white-space: nowrap`, which is written for a one-word
 * token in a table cell. At 320px that held ~41 unbreakable characters on one
 * line and pushed them out of the panel.
 *
 * Both jobs faulted, because that is the longest the sentence gets and the
 * state in which it matters most: an admin who cannot read past "token-health
 * fai…" has to open the group to learn what the line exists to tell them.
 * Wrapping, never truncating — the names are the payload.
 */
test("housekeeping's collapsed line wraps inside the panel at 320px", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await db.insert(syncRun).values([
    {
      jobType: "token-health",
      startedAt: ago(2 * MIN),
      finishedAt: ago(2 * MIN - 300),
      status: "failed",
      errorSummary: "token refresh failed for 3 accounts",
      counts: null,
    },
    {
      jobType: "purge",
      startedAt: ago(3 * MIN),
      finishedAt: ago(3 * MIN - 300),
      status: "failed",
      errorSummary: "purge could not acquire its lock",
      counts: null,
    },
  ]);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/sync");

  const summary = page.locator(".strip__group-disc > summary");
  // Whole sentence, both names, nothing elided.
  await expect(summary).toHaveText("2 jobs · token-health failed, purge failed");

  // The measurement, not the rule: the sentence's own painted box stays inside
  // the strip that contains it. Measured on the `.st`, not on the `<summary>`
  // — an overflowing flex item spills past its container's edge without
  // growing it, so the summary's own right edge sits at the panel boundary
  // whether the line fits or not, and asserting on it passes vacuously.
  const fit = await summary.locator(".st").evaluate((el) => ({
    right: el.getBoundingClientRect().right,
    limit: el.closest(".strip")!.getBoundingClientRect().right,
  }));
  expect(fit.right, "collapsed line overflows the strip at 320px").toBeLessThanOrEqual(
    Math.ceil(fit.limit),
  );

  // And it wrapped to get there rather than being narrow enough all along.
  // Measured against the rule it overrides: put `.st`'s own `white-space:
  // nowrap` back on the element and the line demands more width than it was
  // given. That comparison is what makes this a test of the media-query rule
  // rather than of the seed happening to be short — it fails if the rule is
  // dropped, and it also fails if the rule never did anything.
  const width = await summary.locator(".st").evaluate((el) => {
    const wrapped = el.getBoundingClientRect().width;
    const prev = el.style.whiteSpace;
    el.style.whiteSpace = "nowrap";
    const nowrap = el.getBoundingClientRect().width;
    el.style.whiteSpace = prev;
    return { wrapped, nowrap };
  });
  expect(width.nowrap, "the line fits at 320px even unwrapped").toBeGreaterThan(
    width.wrapped,
  );

  // The page itself still does not scroll sideways (WCAG 1.4.10).
  const doc = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(doc.scroll, "page-level horizontal scroll at 320px").toBeLessThanOrEqual(
    doc.client,
  );
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
 * A run's counters are a row of mono figures of equal weight, and one of them
 * means the opposite of the rest: `addFailed: 3` is three members who did NOT
 * get map access, sitting in the same ink as the `added: 4` beside it. The
 * status cell already says `partial`, so the fact is not missing — the
 * quantity just wasn't weighted. `isFailureKey` (@/core/run-summary) decides
 * which keys get the emphasis, and `notInGuild` is the control: a state the
 * job reports rather than something it tried and failed at.
 */
test("a non-zero failure counter is weighted apart from the successes beside it", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await setHeartbeat(ago(2 * MIN));
  await db.insert(syncRun).values([
    {
      jobType: "wanderer",
      startedAt: ago(3 * MIN),
      finishedAt: ago(3 * MIN - 400),
      status: "partial",
      errorSummary: "3 adds rejected by wanderer",
      counts: { added: 4, removed: 0, addFailed: 3, removeFailed: 0, unblockFailed: 0 },
    },
    {
      jobType: "discord-roles",
      startedAt: ago(2 * MIN),
      finishedAt: ago(2 * MIN - 200),
      status: "ok",
      counts: { changed: 2, notInGuild: 5, failed: 0 },
    },
  ]);
  await page.goto("/admin/sync");

  // `partial` is `degraded`, which `NEEDS_ATTENTION` opens on render — so the
  // row is already expanded and clicking it here would shut it.
  await expect(summaryFor(page, "wanderer")).toHaveAttribute("aria-expanded", "true");
  const wanderer = page.locator(".strip__job", { hasText: "wanderer" });
  // `countColumns` only gives a column to a counter that moved somewhere in
  // the window, so the zero-valued failure keys have no cell to weight here.
  await expect(wanderer.locator("td.num.warn")).toHaveText(["3"]);

  // `notInGuild: 5` is non-zero and still not a failure — the emphasis has to
  // be earned by the key, not by the figure being large.
  await summaryFor(page, "discord-roles").click();
  const roles = page.locator(".strip__job", { hasText: "discord-roles" });
  await expect(roles.locator("td.num.warn")).toHaveCount(0);
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
  // purge sits behind housekeeping's own collapsed line (5.3); seedRuns'
  // purge run is clean so it does not auto-open on its own.
  await openHousekeeping(page);

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

  // purge sits behind housekeeping's own collapsed line (5.3).
  await openHousekeeping(page);
  const purge = page.locator(".strip__job", { hasText: "purge" });
  await purge.locator("> .strip__disc > summary").click();
  await expect(purge.locator("tbody")).toContainText("no change");
  // Full payload still reachable behind the disclosure. Compact, not
  // pretty-printed (5.5, RunPayload in page.tsx) — `"sessions":0` with no
  // space after the colon, unlike `Json`'s own `JSON.stringify(value, null,
  // 2)` used elsewhere on this page's audit counterpart.
  await purge.locator("tbody summary").click();
  await expect(purge.locator(".json__full")).toContainText('"sessions":0');
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

  // purge sits behind housekeeping's own collapsed line (5.3).
  await openHousekeeping(page);
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
 * alone cannot say the process stopped — and reading liveness off `sync_run`
 * (whether any JOB has fired lately) couldn't either, since a live worker
 * between two due jobs and a dead one both go quiet for the same reason to
 * that signal. The worker line reads pg-boss's own maintenance heartbeat
 * instead (`setHeartbeat` above), which ticks on a fixed ~120s cadence with
 * no job involved at all.
 */
test("the worker line reports liveness, and a dead worker says so", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await setHeartbeat(ago(2 * MIN));
  await page.goto("/admin/sync");

  const worker = page.locator(".worker");
  await expect(worker).toHaveText("worker · alive, checked in 2m ago");
  // Healthy is a quiet line, not a notice.
  await expect(page.locator(".notice--bad")).toHaveCount(0);

  // A live worker and a live deployment are separate facts, and this is the
  // page where the second one used to be unstated: every outbound write can be
  // suppressed at the client boundary while the line above still reads
  // "alive". `playwright.config.ts:54` runs the whole suite under
  // SYNC_MODE=dry-run, so the banner is present on every page of this run —
  // which is exactly the deployment shape the finding describes.
  await expect(page.locator(".notice--warn")).toContainText(/SYNC_MODE=dry-run/);

  // No heartbeat in four hours — far past HEARTBEAT_STALE_AFTER_MS's 6
  // minutes (@/core/health), so this is a worker that has actually stopped,
  // not one merely between two due jobs.
  await resetDb(db);
  await asAdmin(context);
  await setHeartbeat(ago(240 * MIN));
  await page.goto("/admin/sync");
  await expect(page.locator(".notice--bad .worker")).toHaveText(
    /worker · no heartbeat in 4h/i,
  );
});

/**
 * `workerHeartbeat` (@/services/health) reads `maintained_on` as pg's own raw
 * text output, not a driver-parsed `Date` — see that function's own comment.
 * Postgres accepts `timestamptz`'s special value `'infinity'`, which is a
 * real, reachable string on that raw-text path and which `new Date(...)`
 * does not understand (`Invalid Date`, not a throw). This is the "error"
 * branch, not "never": pg-boss's own maintenance loop DID write something,
 * so the honest claim is "the check failed to make sense of it", not "no
 * heartbeat has ever been recorded" — the exact regression `workerLine`'s
 * exhaustive switch (page.tsx) exists to make a compile error if a future
 * variant reintroduces it by accident.
 */
test("an unparseable heartbeat value renders as a failed check, not as no heartbeat recorded", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await setHeartbeat(ago(2 * MIN)); // creates/tracks pgboss.version for cleanup
  await db.execute(sql`
    update pgboss.version set maintained_on = 'infinity' where version = 999999
  `);
  // `finally`, not a trailing statement: a failing `goto` or assertion would
  // otherwise exit before the restore and leak 'infinity' into every later
  // test in the file — turning one real failure into a cascade of unrelated
  // ones and hiding which test actually broke.
  try {
    await page.goto("/admin/sync");
    await expect(page.locator(".notice--bad .worker")).toHaveText(
      "worker · heartbeat check failed — unknown whether the worker is running",
    );
  } finally {
    await restoreInheritedStaleHeartbeat();
  }
});

/**
 * `resetDb` (the per-test `beforeEach`) does not touch `pgboss`, so an
 * unrestored heartbeat leaks into every test that runs after it in this file,
 * not just the next one — and several of them (e.g. "an overdue job...")
 * never call `setHeartbeat` themselves and rely on inheriting a STALE,
 * not-fresh heartbeat from the immediately preceding test.
 *
 * So this restores exactly that inherited state — what "the worker line
 * reports liveness" above leaves behind, 240 minutes stale — rather than a
 * fresh one, which would silently flip `worker.fresh` for everything after it.
 * Caught failing "an overdue job..." during review, which is a same-file
 * example of why this file is this careful about what each test leaves behind.
 */
async function restoreInheritedStaleHeartbeat() {
  await setHeartbeat(ago(240 * MIN));
}

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

// Refresh changes nothing on the server. `Recheck invalid affiliations` puts a
// job on the queue. They were both plain `.btn`, 8px apart, in the same control
// row at the foot of the page — identical weight, identical box, and nothing
// but the label to tell an admin that one of them is free and the other is not.
//
// The grade axis was unavailable: `.btn--quiet` carries `min-height: 1.75rem`,
// and DESIGN.md R1 scopes that 28px grade by the reason for it, to rows that
// each carry a control set and are read many at a time. A single control is not
// that. So this is fixed by adjacency instead — Refresh moved to the strip's
// section header, beside the "checked … UTC" stamp, which is the thing it
// actually replaces.
//
// Asserted structurally rather than by coordinates: the header wraps at narrow
// widths and the stamp is `--ink-faint` mono, so a geometric assertion would
// either be brittle or pass on a control that had merely drifted near.
test("Refresh sits with the stamp it replaces, not with the controls that queue work", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const aside = page.locator(".rule-head__aside");
  // Anti-vacuity: every containment check below would pass against an empty
  // locator, and `.rule-head__aside` only exists if `RuleHead` got an `aside`.
  await expect(aside).toHaveCount(1);
  await expect(aside.locator(".btn-row__stamp")).toContainText("checked");
  await expect(aside.getByRole("link", { name: "Refresh" })).toBeVisible();

  // The other half of the finding: it is no longer a peer of the two controls
  // that enqueue. Both of those stay, so this is not asserting on an empty row.
  const controls = page.locator(".btn-row--controls");
  await expect(controls.getByRole("button", { name: "Sync now" })).toBeVisible();
  await expect(
    controls.getByRole("button", { name: "Recheck invalid affiliations" }),
  ).toBeVisible();
  await expect(controls.getByRole("link", { name: "Refresh" })).toHaveCount(0);
});

test("the fan-out reports back, moves focus to the confirmation, and Refresh clears the flag", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  // The confirmation slot is in the DOM before the press — an empty
  // `ConfirmNotice` — so the text arriving on press is a mutation of an
  // existing node rather than one appearing fresh. Scoped to `ConfirmNotice`'s
  // own wrapping div, and to a DIRECT child of `<main>`: the worker-liveness
  // Notice above the strip is also `.notice` (or `.notice--bad`) whenever the
  // test database carries no pg-boss heartbeat, which is the default here, and
  // every job drawer now carries its own `ConfirmGroup`-owned notice slot
  // (`_components/confirm-group.tsx`) nested well below `<main>`'s direct
  // children — a bare `div[tabindex="-1"] > p.notice-slot` matches those too.
  const notice = page.locator(
    'main > div[tabindex="-1"] > p.notice, main > div[tabindex="-1"] > p.notice-slot',
  );
  await expect(notice).toHaveCount(1);
  // `live={false}`: this slot carries no ARIA role at all. The enqueue
  // buttons sit below seven job rows and however many drawers are open, so
  // nothing here relies on a live-region mutation to be heard — focus moving
  // to the slot's wrapper (asserted below) is what carries the announcement,
  // for a sighted admin scrolled to the bottom of the page as much as for AT.
  await expect(notice).not.toHaveAttribute("role", /.+/);
  // `ConfirmNotice` puts the `tabIndex={-1}` that actually receives focus on
  // the wrapping div matched above, not on the `<p>` itself.
  const noticeFocusTarget = notice.locator("xpath=..");

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(notice).toContainText(
    "membership, contacts, wanderer and discord-roles queued for every account",
  );
  await expect(page).toHaveURL(/queued=all/);
  // Focus lands on the confirmation itself, not on wherever the pressed
  // button (now off the bottom of the viewport again after the redirect)
  // happened to be.
  await expect(noticeFocusTarget).toBeFocused();

  // Refresh drops ?queued=, so a reload hours later does not re-show a stale
  // "queued a few seconds ago".
  await page.getByRole("link", { name: "Refresh" }).click();
  await expect(page).toHaveURL(/\/admin\/sync$/);
  await expect(page.locator('main > div[tabindex="-1"] > p.notice-slot')).toHaveText("");
  await expect(page.locator(".btn-row__stamp")).toHaveText(
    /checked \d{2}:\d{2}:\d{2} UTC/i,
  );
});

/**
 * A second "Sync now" press produces the identical sentence but a new `at`,
 * and focus has to move again rather than staying wherever the first press
 * left it — the same repeat-press hazard `queuedNotice`'s own `at` argument
 * exists to close for the text, now closed for focus too.
 */
test("a second identical press moves focus again", async ({ page, context }) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  // Scoped to a direct child of `<main>` — see the fan-out test above for why
  // a bare `div[tabindex="-1"]` now also matches every job drawer's own
  // `ConfirmGroup` notice slot.
  const noticeFocusTarget = page
    .locator(
      'main > div[tabindex="-1"] > p.notice, main > div[tabindex="-1"] > p.notice-slot',
    )
    .locator("xpath=..");
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(noticeFocusTarget).toBeFocused();

  // Move focus elsewhere, then press again: if the second press didn't
  // re-trigger the effect, focus would stay on the Refresh link instead of
  // returning to the notice.
  await page.getByRole("link", { name: "Refresh" }).focus();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(noticeFocusTarget).toBeFocused();
});

/**
 * The lever a failed row actually wants: before this, retrying wanderer after
 * a 502 meant a fan-out that also re-ran three jobs that were fine.
 *
 * This is also the regression test for the drawer-collapse bug: `wanderer`'s
 * row auto-opens because it's failing, and `syncJobAction` used to redirect
 * back to this same route on success — which reset `Disclosure`'s own
 * `useState` and closed the very drawer this button lives inside, on the
 * first press. The button now returns its confirmation through
 * `useActionState` (`ConfirmingForm`/`ConfirmGroup`,
 * `@/app/_components/confirm-group`) with no navigation at all, so the
 * assertion on `aria-expanded` staying `"true"` — and the URL never gaining
 * `?queued=` — is the thing that catches a reintroduced redirect.
 */
test("a failed row re-runs its own job, and its own drawer stays open", async ({
  page,
  context,
}) => {
  const admin = await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const wanderer = summaryFor(page, "wanderer");
  // wanderer is already open — that is the whole point of auto-open.
  await expect(wanderer).toHaveAttribute("aria-expanded", "true");

  const drawer = page.locator(".strip__job", { hasText: "wanderer" });
  await drawer.getByRole("button", { name: "Re-run wanderer" }).click();
  // Settles whether the press soft-navigated (the bug this guards against) or
  // not, so the assertions below read the final state rather than racing a
  // navigation still in flight.
  await page.waitForLoadState("networkidle");

  // The confirmation lands inside the drawer itself, not in the page-level
  // `ConfirmNotice` two of this page's three enqueue actions still use — see
  // `syncJobAction`'s own docblock.
  await expect(drawer).toContainText("wanderer queued");

  // The drawer the button lives inside must still be open after the press —
  // this is what a redirect used to break on the very first click.
  await expect(wanderer).toHaveAttribute("aria-expanded", "true");
  // No navigation at all: the redirect-shaped siblings (`syncAllAction`,
  // `recheckInvalidAction`) land on `?queued=...`, and this control must not.
  await expect(page).toHaveURL(/\/admin\/sync$/);

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
 * The same regression as above, from the other side: a healthy row an admin
 * had to open by hand rather than one auto-opened by the page. Covers the
 * ordinary path (open a closed drawer, press its button) rather than the
 * already-open one the failing-row test exercises.
 */
test("opening a healthy row's drawer by hand and pressing its enqueue control leaves it open", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  // purge sits behind housekeeping's own collapsed line (5.3).
  await openHousekeeping(page);
  const purge = summaryFor(page, "purge");
  await expect(purge).toHaveAttribute("aria-expanded", "false");
  await purge.click();
  await expect(purge).toHaveAttribute("aria-expanded", "true");

  const drawer = page.locator(".strip__job", { hasText: "purge" });
  await drawer.getByRole("button", { name: "Re-run purge" }).click();
  // Settles whether the press soft-navigated (the bug this guards against) or
  // not, so the aria-expanded check below reads the final state rather than
  // racing a navigation still in flight.
  await page.waitForLoadState("networkidle");
  // Checked first: this is the exact assertion a reintroduced redirect fails —
  // a redirect back to this same route replaces the whole route tree and
  // resets `Disclosure`'s `useState`, collapsing a healthy row's drawer (which
  // does not auto-reopen the way a failing row's does) on the very click that
  // enqueued its re-run.
  await expect(purge).toHaveAttribute("aria-expanded", "true");
  await expect(drawer).toContainText("purge queued");
  await expect(page).toHaveURL(/\/admin\/sync$/);
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

  // purge sits behind housekeeping's own collapsed line (5.3); an in-flight
  // run does not auto-open it (`groupNeedsAttention` reuses `needsAttention`,
  // which excludes `inflight` for the same reason a single in-flight row
  // does not auto-open on its own — see NEEDS_ATTENTION's own comment).
  await openHousekeeping(page);
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

  // purge sits behind housekeeping's own collapsed line (5.3).
  await openHousekeeping(page);
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
  // All three seeded runs share one outcome, so the table's own "3 runs"
  // cell already states the window's full depth — the caption underneath
  // would only restate it (5.7), and does not render at all.
  await expect(purge.locator(".strip__window")).toHaveCount(0);
});

/**
 * The window caption states a fact the table's own cells do not, so it is
 * expected to survive: an in-flight run above a collapsed group is two rows,
 * neither of which states the window's own depth on its own (5.7).
 */
test("the window caption survives when the table's own rows don't state its depth", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  // membership has exactly one seeded run — collapseRuns never turns a
  // single row into a "group", so this is the plainest case where nothing
  // in the table states how deep the window goes. `.first()`: "membership"
  // is also a substring of "membership-recheck".
  const membership = page.locator(".strip__job", { hasText: "membership" }).first();
  await membership.locator("> .strip__disc > summary").click();
  await expect(membership.locator(".strip__window")).toHaveText("last run");
});

/**
 * The Re-run control's size, which nothing else on this page pins.
 *
 * It carried `.btn--micro` until this sweep. DESIGN.md rations the 28px grade
 * to the in-row controls of the admin tables, and this one sits in a drawer
 * strip below the runs table rather than in a row of it — so it belongs at the
 * standalone 36px grade, alongside `Sync now` at the top of the same page.
 *
 * Written because the fix was otherwise invisible to the suite: every
 * assertion on this button addresses it by accessible name, and a regression
 * putting `btn--micro` back on `page.tsx` would leave the whole file green
 * while the control quietly shrank below the hit target its placement earns.
 */
test("a drawer's Re-run control sits at the standalone grade, not the in-row one", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  // purge sits behind housekeeping's own collapsed line (5.3).
  await openHousekeeping(page);
  const purge = summaryFor(page, "purge");
  await purge.click();
  await expect(purge).toHaveAttribute("aria-expanded", "true");

  const rerun = page
    .locator(".strip__job", { hasText: "purge" })
    .getByRole("button", { name: "Re-run purge" });
  // `Sync now`: the same page's own standalone button, and the comparison that
  // makes the number below mean something rather than restate a constant.
  const syncNow = page.getByRole("button", { name: "Sync now" });

  const [rerunBox, syncNowBox] = await Promise.all([
    rerun.boundingBox(),
    syncNow.boundingBox(),
  ]);

  expect(Math.round(syncNowBox!.height)).toBe(36);
  expect(Math.round(rerunBox!.height)).toBe(Math.round(syncNowBox!.height));
});

/**
 * 5.5: opening a run's Raw payload used to stretch its whole row to fit
 * `Json`'s one-key-per-line pretty print — 227px for a 6-counter run whose
 * other five cells are one line each (52.5px), 174.75px of it (77%) blank in
 * every cell but Raw's. `RunPayload` (page.tsx) renders the same payload
 * compact instead, wrapped by `.json__full`'s own 40ch cap rather than broken
 * one key per line, and the row comes to well under half its old height.
 */
test("opening a run's Raw payload no longer stretches its row past half its old height", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const membership = page.locator(".strip__job", { hasText: "membership" }).first();
  await membership.locator("> .strip__disc > summary").click();

  const row = membership.locator("tbody tr").first();
  const before = await row.boundingBox();
  await row.locator("summary").first().click();
  const after = await row.boundingBox();

  // Measured before this fix: 52.5px closed, 227.25px open (pretty-printed,
  // 4.3x) — after: ~134px (2.6x). The regression this guards is the ratio
  // creeping back toward the old one, not the exact open height, which still
  // grows with however many counters a job reports.
  expect(after!.height).toBeLessThan(before!.height * 3);
  expect(after!.height).toBeLessThan(140);

  // Compact, not pretty: no newline inside the rendered payload.
  const text = await membership.locator(".json__full").first().innerText();
  expect(text).not.toContain("\n");
});

/**
 * 5.6: `.log--runs`'s own `max-width: max-content` (globals.css) already
 * stops the runs table at its own content width rather than stretching it
 * into a wide strip — but `.scroller` around it used to stay a full-width
 * block box regardless, so its border kept going another ~445px past the
 * table's own edge on a 6-counter job at this page's 1200px strip: one
 * border ending at the content, a second, wider one drawn around the empty
 * space past it. `.scroller:has(.log--runs)` (globals.css) is `width: 100%;
 * max-width: max-content`, the same pairing `.log--runs` itself already uses,
 * so the two now end at the same place — the table's own edge is the only
 * border, wherever the content stops.
 */
test("the runs table's scroller doesn't outrun the table's own edge", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.goto("/admin/sync");

  const membership = page.locator(".strip__job", { hasText: "membership" }).first();
  await membership.locator("> .strip__disc > summary").click();

  const [scrollerBox, tableBox] = await Promise.all([
    membership.locator(".scroller").first().boundingBox(),
    membership.locator(".log--runs").first().boundingBox(),
  ]);

  // The scroller's border sits right against the table (its own 1px border
  // on each side, no more) rather than however much wider the strip is.
  const gap = scrollerBox!.x + scrollerBox!.width - (tableBox!.x + tableBox!.width);
  expect(gap).toBeLessThan(4);
});

/**
 * The fix above is `width: 100%; max-width: max-content` rather than the bare
 * `fit-content` keyword precisely to leave this test alone: a `fit-content`
 * scroller measured its own available width from the table's full max-content
 * demand instead of the region on screen, at 320px, which silently starved it
 * of the overflow "opening a healthy row hands its scroll region a tab stop"
 * (above) exists to require.
 */
test("the runs table still overflows its scroller at 320px, tab stop and all", async ({
  page,
  context,
}) => {
  await asAdmin(context);
  await seedRuns();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/admin/sync");

  const membership = summaryFor(page, "membership");
  await membership.click();
  const region = page
    .locator(".strip__job", { hasText: "membership" })
    .locator(".scroller");
  await expect(region).toHaveAttribute("tabindex", "0");

  const dims = await region.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(dims.scrollWidth).toBeGreaterThan(dims.clientWidth);
});

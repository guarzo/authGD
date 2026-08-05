import type { RowHealth } from "@/core/run-health";
import type { SyncRunStatus } from "@/db/schema";
import { cronFor, isJobType, nextRunAt } from "@/core/schedules";
import type { Tone } from "@/app/_components/ui";

/**
 * The pure decisions behind the admin sync strip.
 *
 * Separate from `page.tsx` only so they can be unit-tested: five of these lived
 * as module-private functions inside a server component, where the only way to
 * reach them was to render the page, seed a database and drive a browser. Two
 * of them (`queuedNotice`, `nextRunFor`) validate or degrade untrusted input,
 * which is precisely the kind of branch that wants a cheap test per case.
 */

/**
 * Colour for one *recorded* historical run in the drawer's table, which is a
 * different question from the summary row's live health: this one has no model
 * of time and is not supposed to have one. Typed against the schema enum, so
 * adding a status there is a compile error here rather than a silently grey
 * badge. A null status is a run still in flight: not a failure and not inactive
 * either, so it stays neutral rather than borrowing the warn colour PRODUCT.md
 * reserves for things the admin can and should fix.
 */
export function tone(status: SyncRunStatus | null): Tone {
  switch (status) {
    case "ok":
      return "ok";
    case "partial":
      return "warn";
    case "failed":
      return "bad";
    case null:
      return "neutral"; // still running
  }
}

/**
 * Colour for a row's live health. Keyed off `RowHealth` and not off the run
 * status, so "the last run succeeded six hours ago on a 30-minute cadence" can
 * be amber while "the last run succeeded four minutes ago" is green.
 *
 * `overdue`, `stuck` and `missing` are warn, not bad: nothing has reported a
 * failure, the schedule has simply not been kept. `never` is off rather than
 * warn for the same reason PRODUCT.md keeps alumni tier and a dead token out of
 * alarm colour — a job that has not run yet, on a worker too young to say it
 * should have, is a state and not a fault.
 */
export const HEALTH_TONE: Record<RowHealth, Tone> = {
  fresh: "ok",
  degraded: "warn",
  failing: "bad",
  inflight: "neutral",
  stuck: "warn",
  overdue: "warn",
  missing: "warn",
  never: "off",
  unknown: "warn",
};

/**
 * The word beside the glyph, so colour is never the only carrier. Deliberately
 * only the word: `inflight` and `stuck` differ from each other only in how long
 * they have held the same shape, and the obvious answer — baking the elapsed
 * time into the label — puts a second, frozen clock on a row that already
 * carries a ticking one. The `.ago` beside this reads the *start* time of an
 * in-flight run (`latestAt` falls back to `startedAt` when `finishedAt` is
 * null) and re-renders every 30s, so it is already the duration this label
 * would have restated. One number per row, and it stays true on a tab left
 * open for an hour.
 *
 * A `Record` rather than a switch: a new `RowHealth` member is a compile error
 * here and in `HEALTH_TONE` and `NEEDS_ATTENTION`, so the three cannot fall out
 * of step with the type or with each other.
 */
export const HEALTH_LABEL: Record<RowHealth, string> = {
  fresh: "ok",
  degraded: "partial",
  failing: "failed",
  inflight: "running",
  stuck: "stuck",
  overdue: "overdue",
  missing: "not running",
  never: "no runs",
  unknown: "cadence unknown",
};

/**
 * Which rows open on their own. "Not healthy" is read as "actionable", which
 * rules out three states that look unhealthy but are not one job's problem:
 *
 * `inflight` resolves on its own within seconds, and expanding on it would mean
 * the page flaps open and shut through every sweep instead of pointing at the
 * one job that needs an admin. `stuck` is the same shape held far too long, so
 * that one does open.
 *
 * `overdue` is excluded for a bigger reason: when the worker dies, every row
 * goes overdue at once, so opening on it would expand all seven drawers
 * together and destroy exactly the "this one job needs you" signal auto-open
 * exists to create. A dead worker is a page-level condition and it is the
 * worker line above the strip that says so. `missing` is safe to open despite
 * that, because `rowHealth` only reaches it when the worker is demonstrably
 * alive and recording other jobs.
 *
 * `unknown` stays shut: the fault is in the cron expression, and the drawer
 * holds run history, which has nothing to say about it.
 */
const NEEDS_ATTENTION: Record<RowHealth, boolean> = {
  fresh: false,
  degraded: true,
  failing: true,
  inflight: false,
  stuck: true,
  overdue: false,
  missing: true,
  never: false,
  unknown: false,
};

export function healthLabel(health: RowHealth): string {
  return HEALTH_LABEL[health];
}

export function needsAttention(health: RowHealth): boolean {
  return NEEDS_ATTENTION[health];
}

/**
 * True when the cron's hour field is a fixed number rather than `*` or a
 * step. When it is, the cadence string `formatCadence` prints already names a
 * wall-clock time (`daily 03:00 UTC`, `Sun 04:00 UTC`) and a next-run line
 * under it would either repeat that number or, worse, read as "soon" for a job
 * that only fires once a week. Read off the raw expression rather than the
 * humanized cadence string, so a rewording of `formatCadence` can't silently
 * break this.
 *
 * Deliberately looser than `formatCadence`'s own test, which also requires a
 * numeric minute: for a stepped minute on a fixed hour that function falls
 * back to printing the raw expression while this one still suppresses the
 * next-run line. Nothing in JOB_CRON has that shape, and suppressing a
 * decoration is the safe side to err on.
 */
export function cadenceNamesTime(cron: string): boolean {
  const hour = cron.trim().split(/\s+/)[1];
  return /^\d+$/.test(hour ?? "");
}

/**
 * The "next HH:MM" decoration under a cadence, or null when it would say
 * nothing the cadence has not already said. `nextRunAt` owns the degradation:
 * an unsupported or absent cadence is "we don't know when", never a throw that
 * takes the whole page down over a decoration.
 */
export function nextRunFor(jobType: string, now: Date): Date | null {
  const cron = cronFor(jobType);
  if (cron === null || cadenceNamesTime(cron)) return null;
  return nextRunAt(jobType, now);
}

/**
 * `HH:MM:SS.mmm UTC` for the enqueue instant carried in `?at=`, or null when
 * the value is anything else. Same posture as `queuedNotice`'s own validation:
 * the query string is untrusted input reaching copy, so a non-numeric or
 * absurd value drops the clause rather than being echoed.
 *
 * Milliseconds, not whole seconds, and they are the entire point rather than a
 * flourish. This stamp exists to make a repeat press announce, and `Submit` is
 * deliberately not disabled while its form is in flight — so the second press
 * lands the instant the first round-trip completes, which on localhost is
 * inside the same wall-clock second. At second precision those two presses
 * produce a byte-identical string again and the live region goes quiet, which
 * is the bug this was added to close.
 *
 * The length check is on the ISO string, not on the digit count, because the
 * two disagree in exactly the range a hand-edited `?at=` reaches first. `Date`
 * happily represents year 33658, and `toISOString` prints it in the extended
 * form `+033658-09-27T…` — three characters wider, because the year field goes
 * from four digits to seven — so a fixed slice silently returns `27T01:46:39`
 * instead of a clock. Neither the regex nor `Number.isNaN` sees anything wrong
 * with that value; only the width does.
 */
export function queuedStamp(at: string | undefined): string | null {
  if (at === undefined || !/^\d{1,15}$/.test(at)) return null;
  const d = new Date(Number(at));
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  if (iso.length !== 24) return null;
  return `${iso.slice(11, 23)} UTC`;
}

/**
 * The one-line outcome of the press that got us here. Per-job re-runs redirect
 * with the job type itself, and that value is checked against the schedules
 * table before it is echoed: a hand-typed `?queued=` is untrusted input, and
 * this is copy, not a lookup that fails safe on its own.
 *
 * `at` is what makes a *second* press of the same button say something. The
 * page mounts one permanent `role="status"` region and the redirect target for
 * a given job is otherwise constant, so pressing `Re-run wanderer` twice
 * produced a byte-identical string, React wrote nothing to the text node, and
 * the live region — which announces on mutation — stayed silent about an
 * enqueue that really happened. The instant differs per press, so the text
 * does. It also retires the stale-notice hazard the Refresh anchor was
 * carrying alone: a notice still on screen an hour later now says when.
 *
 * "reload this page", not "use Refresh": Refresh is the last control below
 * seven job rows and however many open drawers, while this text renders at the
 * top of the page, and nothing in the copy said which direction to go. The
 * browser reload is what an admin reaches for anyway, and naming it costs the
 * page nothing — the anchor's `?queued=`-dropping behaviour still matters, but
 * only for the canonical URL, which a reload of *this* URL is not.
 */
export function queuedNotice(
  queued: string | undefined,
  at?: string,
  // Defaults to fresh so every existing caller and test keeps the promise
  // the copy always made. The worker line above the strip is the one thing
  // on the page that knows whether that promise is still true — a queue
  // enqueued behind a worker that has not run in 4h will not be picked up
  // "within a few seconds", and the notice repeating that unconditionally is
  // exactly the reassurance PRODUCT.md's "state before action" rules out.
  workerFresh = true,
): string {
  const stamp = queuedStamp(at);
  const when = stamp === null ? "" : ` at ${stamp}`;
  // Plurality is the fan-out's alone: "all" queues four distinct jobs, so the
  // freshness clause it shares with the three singular callers below still
  // needs to say "them" rather than "it" for that one caller.
  const pickup = (plural: boolean): string =>
    workerFresh
      ? `The worker picks ${plural ? "them" : "it"} up within a few seconds`
      : "The worker is not running right now, so this waits until it is";
  if (queued === "all") {
    // The four job keys the fan-out actually enqueues, spelled the way the
    // strip above spells them, so the nouns are findable in the column the
    // admin is looking at rather than translated into a second vocabulary.
    return `membership, contacts, wanderer and discord-roles queued for every account${when}. ${pickup(true)}; reload this page to see the runs land.`;
  }
  if (queued === "recheck") {
    return `Affiliation recheck queued${when}. ${pickup(false)}; reload this page to see the run land.`;
  }
  if (isJobType(queued)) {
    return `${queued} queued${when}. ${pickup(false)}; reload this page to see the run land.`;
  }
  return "";
}

/**
 * The earliest instant the worker is known to have been recording runs, or null
 * when nothing says it currently is.
 *
 * `rowHealth` needs this to tell "this job has not run yet" from "this job is
 * not running": the second is only knowable by seeing the worker do other work
 * for longer than this job's own cadence. The oldest run in the page's window
 * is a LOWER bound on that uptime (the window holds a handful of runs per job,
 * not all of history), which errs toward saying "never" for longer — the quiet
 * side.
 *
 * Null when the worker is not fresh, deliberately: a dead worker would
 * otherwise flip every never-run row to `missing` at once, and that is the
 * page-level condition the worker line already reports.
 */
export function evidenceSince(
  workerFresh: boolean,
  groups: Array<{ runs: Array<{ startedAt: Date | null }> }>,
): Date | null {
  if (!workerFresh) return null;
  let oldest: Date | null = null;
  for (const g of groups) {
    for (const r of g.runs) {
      if (r.startedAt !== null && (oldest === null || r.startedAt < oldest)) {
        oldest = r.startedAt;
      }
    }
  }
  return oldest;
}

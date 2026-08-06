import type { RowHealth } from "@/core/run-health";
import type { SyncRunStatus } from "@/db/schema";
import { cronFor, isJobType, nextRunAt } from "@/core/schedules";
import type { Tone } from "@/app/_components/ui";
import { elapsedShort } from "@/app/_components/format-ago";

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
 * The one-line outcome of the press that got us here.
 *
 * Two calling shapes reach this, and they don't hand it the same arguments.
 * `syncAllAction` and `recheckInvalidAction` still redirect
 * (`/admin/sync?queued=...&at=...`), and `queued` there is untrusted input —
 * a hand-typed value is checked against the schedules table before it is
 * echoed, since this is copy, not a lookup that fails safe on its own. Their
 * `at` is what makes a *second* press of the same button say something: this
 * text is rendered through `ConfirmNotice` (`@/app/_components/confirm-notice`),
 * which moves focus to it on every `at` change rather than relying on a live
 * region to announce a text mutation, and the redirect target for a given
 * action is otherwise constant, so pressing "Sync now" twice would produce a
 * byte-identical string and, without `at` in the dependency list, only the
 * FIRST press would move focus. It also retires the stale-notice hazard the
 * Refresh anchor was carrying alone: a notice still on screen an hour later
 * now says when.
 *
 * `syncJobAction`'s per-job re-run does NOT redirect — its control sits inside
 * that job's own `Disclosure`, and a redirect would reset the drawer (see
 * `actions.ts`'s own docblock on it). It calls this function directly with a
 * job type it already validated and no `at` at all: `undefined` degrades
 * `queuedStamp` to null, dropping the "at HH:MM:SS" clause, and the repeat-press
 * problem `at` exists to solve doesn't arise there in the first place —
 * `_components/confirm-group.tsx`'s `ConfirmGroup` re-focuses on a monotonic
 * counter, not on this string, so a second press of "Re-run wanderer"
 * producing the identical sentence still moves focus again.
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
  at: string | undefined,
  // Required, not defaulted: a default here would let a forgetful caller
  // silently borrow whatever string the default implies, which is exactly
  // how this used to assert a "few seconds" pickup regardless of whether the
  // worker had checked in 90 minutes or 4 hours ago. The caller already
  // computes this for the worker line above the strip (`workerAge` in
  // page.tsx), so passing it is one extra argument, not a lookup.
  workerAge: string | null,
  // Also required, also not defaulted, and for the same reason: collapsing
  // "the read failed" into "no heartbeat recorded" is a positive claim about
  // the database's history made when the code only knows a query didn't
  // answer. See `WorkerHeartbeat` (@/services/health) for the three states
  // this narrows from — `heartbeatErrored` is true only for `"error"`, never
  // for `"never"`, which still reads as "no heartbeat recorded".
  heartbeatErrored: boolean,
): string {
  const stamp = queuedStamp(at);
  const when = stamp === null ? "" : ` at ${stamp}`;
  // State the age, not a verdict about it. The old boolean read as a checked
  // fact ("the worker is not running right now") when the check behind it
  // could not actually support that: `workerAge` used to come from the
  // newest `sync_run` row, and a live worker between two due jobs and a dead
  // one look identical to that signal for up to 90 minutes. `workerAge` is
  // now pg-boss's own maintenance heartbeat (`workerHeartbeat`,
  // @/services/health) — unconditional on job activity — so the ~10-minute
  // gap this comment used to warn about no longer exists, but the reasoning
  // for stating an age rather than a verdict still holds: a `null` age (no
  // heartbeat recorded at all — a fresh deploy, or a database no worker has
  // ever started against) collapses into the same "not running" claim from
  // the absence of any evidence either way, and fresh/stale still don't need
  // separate strings or a second threshold constant here.
  //
  // `heartbeatErrored` is checked first: a failed READ is a different claim
  // again, one the "no heartbeat recorded yet" sentence doesn't cover either
  // — that sentence says something about the database's history, and a
  // permissions or connectivity fault says nothing about history at all.
  const worker = heartbeatErrored
    ? "The worker's heartbeat could not be checked just now, so its status is unknown"
    : workerAge === null
      ? "No heartbeat has been recorded yet, so there is nothing to date the worker by"
      : `The worker last checked in ${workerAge} ago`;
  if (queued === "all") {
    // The four job keys the fan-out actually enqueues, spelled the way the
    // strip above spells them, so the nouns are findable in the column the
    // admin is looking at rather than translated into a second vocabulary.
    return `membership, contacts, wanderer and discord-roles queued for every account${when}. ${worker}; reload this page to see the runs land.`;
  }
  if (queued === "recheck") {
    return `Affiliation recheck queued${when}. ${worker}; reload this page to see the run land.`;
  }
  if (isJobType(queued)) {
    return `${queued} queued${when}. ${worker}; reload this page to see the run land.`;
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

/**
 * The dispatcher polls the outbox every ~2s (`startDispatcher`,
 * src/worker/dispatcher.ts), so a queued marker under this age is the normal
 * gap between an enqueue and the next poll, not a finding — every "Sync now"
 * press spends a moment here, and stating an age on it would manufacture
 * urgency out of routine latency.
 */
export const QUEUED_AGE_NOTABLE_MS = 2 * 60 * 1000;

/**
 * Ten times `QUEUED_AGE_NOTABLE_MS`: past this the dispatcher is not merely
 * behind its ~2s poll, it is wedged. `startDispatcher` swallows a dispatch
 * failure into `console.error` and retries forever rather than surfacing it
 * anywhere else on this page, so the marker is the only thing that can.
 */
export const QUEUED_AGE_STUCK_MS = 15 * 60 * 1000;

/**
 * Whether the queued ring's own shape should escalate past the quiet outline
 * every row with work queued already gets. Kept separate from
 * `queuedMarkerText` below only so the visible (aria-hidden) dot and the
 * accessible sentence can each read the one instant they need without
 * duplicating the threshold between them.
 *
 * A null `queuedSince` is a row known to have work queued whose age did not
 * survive the read (see `undispatchedSummary`). It never escalates: escalation
 * is a claim about how long something has waited, and an unknown age cannot
 * support one.
 */
export function queuedMarkerStuck(queuedSince: Date | null, now: Date): boolean {
  if (queuedSince === null) return false;
  return now.getTime() - queuedSince.getTime() >= QUEUED_AGE_STUCK_MS;
}

/**
 * The accessible words beside the ring. Below `QUEUED_AGE_NOTABLE_MS` this is
 * the bare ", queued" the marker has always carried — the common case, work
 * that has not yet had its next ~2s dispatcher poll, and naming an age on it
 * would be noise on every healthy row it appears on. Past it, the age is the
 * finding: "queued 5m ago" says the dispatcher is behind, and past
 * `QUEUED_AGE_STUCK_MS` it says so about a process that is not coming back on
 * its own.
 *
 * A null `queuedSince` falls back to the bare ", queued": the row still has
 * work waiting and must still say so — losing the age is not a reason to lose
 * the marker — but there is no dated claim to make about it.
 */
export function queuedMarkerText(queuedSince: Date | null, now: Date): string {
  if (queuedSince === null) return ", queued";
  const ageMs = now.getTime() - queuedSince.getTime();
  if (ageMs < QUEUED_AGE_NOTABLE_MS) return ", queued";
  return `, queued ${elapsedShort(ageMs)} ago`;
}

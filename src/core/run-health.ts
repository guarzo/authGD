import type { SyncRunStatus } from "@/db/schema";
import { nextFire, SCAN_WINDOW_MS } from "@/core/schedules";

/**
 * Per-row health for the admin sync table.
 *
 * The page previously coloured each row from the last recorded run status
 * alone, which has no model of time: a dead worker renders fully green (its
 * last run succeeded), and a run wedged for four days looks exactly like one
 * that started four seconds ago. This module adds the time-based verdicts that
 * fixes — "overdue" (it succeeded, but should have run again by now), "stuck"
 * (it started and never came back) and "missing" (it has never run at all, on a
 * worker that has demonstrably been running other things for longer than this
 * job's own cadence).
 *
 * Deliberately NOT reusing `STALE_AFTER_MS` from `@/core/health`: that is one
 * global 90-minute threshold tuned to the 30-minute membership job, and the
 * weekly membership-recheck would be "stale" by it ~99% of the time. Per-row
 * thresholds are derived from each job's own cadence instead. `core/health`
 * still owns the page-level worker-liveness line.
 *
 * Pure: `now` is a parameter, every comparison is UTC, and nothing here reads
 * a clock or touches I/O.
 */

/**
 * How late a scheduled job may be before the row reads "overdue". Absorbs the
 * gap between a cron tick and the run row landing, plus normal run duration,
 * so an on-time job never flickers amber between its due minute and its
 * recorded start.
 */
export const OVERDUE_GRACE_MS = 5 * 60 * 1000;

/** A run is "stuck" once it has been in flight for MORE than this many cadences. */
export const STUCK_MULTIPLIER = 3;

/**
 * Floor for the stuck threshold. It binds only when the cadence is unknown: the
 * shortest scheduled cadence is membership's 30 minutes, so the smallest
 * derived threshold is already 90. An unscheduled/on-demand run has no cadence
 * at all, and no job here legitimately runs for a quarter of an hour.
 */
export const STUCK_FLOOR_MS = 15 * 60 * 1000;

/**
 * The vocabulary is deliberately disjoint from `SyncRunStatus` ("ok" /
 * "partial" / "failed"). A superset would make `HEALTH_TONE[run.status]`
 * typecheck silently and reproduce the status-only colouring this module exists
 * to replace, from a call site twenty lines away in the same file.
 */
export type RowHealth =
  /** Succeeded, and not yet due again. */
  | "fresh"
  /** Last run reported `partial` — some of its work failed. */
  | "degraded"
  /** Last run reported `failed`. */
  | "failing"
  /** Started, no outcome recorded, still inside the stuck threshold. */
  | "inflight"
  /** In flight far longer than its own cadence allows. */
  | "stuck"
  /** Succeeded, but the schedule says it should have run again by now. */
  | "overdue"
  /** Never run, on a worker that has been recording other jobs for longer. */
  | "missing"
  /** Never run, and nothing yet says it should have. */
  | "never"
  /** Scheduled, but its cron cannot be read — we cannot judge it either way. */
  | "unknown";

/**
 * The gap between two consecutive fires of `cron`.
 *
 * `atLeast` is the honest answer for a cadence longer than the schedule
 * module's scan window: we do not know the interval, but we know a lower bound
 * for it, and using that bound beats falling back to the 15-minute floor and
 * calling a monthly job stuck after a quarter of an hour.
 */
type Cadence =
  | { kind: "exact"; ms: number }
  | { kind: "atLeast"; ms: number }
  | { kind: "unreadable" };

/**
 * Derived by asking `nextFire` twice rather than by evaluating the expression
 * here, so `nextFire` stays the only thing in the codebase that decides when a
 * cron fires. (`formatCadence` and the sync page's `cadenceNamesTime` do read
 * cron *fields*, but neither computes a fire time.)
 *
 * `nextFire` THROWS on grammar outside its supported subset. This module
 * renders a page, so it must degrade rather than propagate.
 */
function readCadence(cron: string, from: Date): Cadence {
  let first;
  try {
    first = nextFire(cron, from);
  } catch {
    return { kind: "unreadable" };
  }
  if (first.kind === "unsatisfiable") return { kind: "unreadable" };
  if (first.kind === "beyond-window") return { kind: "atLeast", ms: SCAN_WINDOW_MS };
  const second = nextFire(cron, first.at);
  if (second.kind !== "at") return { kind: "atLeast", ms: SCAN_WINDOW_MS };
  return { kind: "exact", ms: second.at.getTime() - first.at.getTime() };
}

type Due =
  /** The job was due at this instant. */
  | { kind: "at"; at: Date }
  /** Satisfiable, but not due inside the scan window — nowhere near late. */
  | { kind: "far" }
  | { kind: "unreadable" };

function dueAfter(cron: string, from: Date): Due {
  let fire;
  try {
    fire = nextFire(cron, from);
  } catch {
    return { kind: "unreadable" };
  }
  if (fire.kind === "unsatisfiable") return { kind: "unreadable" };
  if (fire.kind === "beyond-window") return { kind: "far" };
  return { kind: "at", at: fire.at };
}

/** True when `due` has passed by more than the grace window. */
function isLate(due: Due, now: Date): boolean {
  return due.kind === "at" && now.getTime() - due.at.getTime() > OVERDUE_GRACE_MS;
}

export function rowHealth(input: {
  status: SyncRunStatus | null; // null = run in flight
  startedAt: Date | null;
  finishedAt: Date | null;
  cron: string | null; // null = unscheduled / on-demand
  now: Date;
  /**
   * The earliest instant we have evidence the worker was recording runs, or
   * null when we have no such evidence (no runs at all, or a worker the page
   * already believes is dead).
   *
   * This is the only anchor a never-run job has. Without it "never" is a
   * terminal state that no elapsed time escalates: a job whose handler was
   * never registered reads identically on day 1 and day 90, in the calmest
   * colour, in the row that never opens itself. Passing null when the worker
   * is not fresh is deliberate — a dead worker puts every row in this state at
   * once, and that is a page-level condition the worker line already reports.
   */
  seenSince?: Date | null;
}): RowHealth {
  const { status, startedAt, finishedAt, cron, now, seenSince = null } = input;

  // Nothing has ever run. getSyncStatus seeds a row for every scheduled job
  // precisely so this state is visible instead of being an absent row.
  if (startedAt === null) {
    if (cron === null || seenSince === null) return "never";
    const due = dueAfter(cron, seenSince);
    if (due.kind === "unreadable") return "unknown";
    // The worker has been recording for longer than one full cadence of this
    // job, and this job still has nothing. That is not "not yet".
    return isLate(due, now) ? "missing" : "never";
  }

  // In flight: started, no outcome recorded. finishSyncRun writes a status
  // alongside finishedAt (services/sync-run), so a null status with a
  // finishedAt cannot happen today — and if it ever does it is a half-written
  // finish, not a success. Keying purely on `status === null` is the fail-safe
  // reading: that shape reports inflight/stuck (amber, worth a look) instead of
  // falling through to a green "fresh" for a run whose outcome nobody knows.
  if (status === null) {
    const cadence = cron === null ? null : readCadence(cron, startedAt);
    // An unreadable cron falls back to the floor, which errs toward flagging
    // stuck early. That is the safe direction here: the row is visible either
    // way, and a wedged run is the more urgent of the two facts.
    const threshold =
      cadence === null || cadence.kind === "unreadable"
        ? STUCK_FLOOR_MS
        : Math.max(STUCK_FLOOR_MS, cadence.ms * STUCK_MULTIPLIER);
    return now.getTime() - startedAt.getTime() > threshold ? "stuck" : "inflight";
  }

  if (status === "failed") return "failing";
  if (status === "partial") return "degraded";

  // Succeeded — but a job that succeeded and then never ran again is the
  // failure mode a status-only page cannot see.
  if (cron !== null) {
    const due = dueAfter(cron, finishedAt ?? startedAt);
    // An unreadable cadence used to degrade to a green "ok" here while the
    // stuck path above degraded toward amber. Same input, opposite direction,
    // and the green one was indistinguishable from a job that ran four minutes
    // ago — exactly the conflation this module exists to end.
    if (due.kind === "unreadable") return "unknown";
    if (isLate(due, now)) return "overdue";
  }

  return "fresh";
}

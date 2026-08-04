import type { syncRunStatusEnum } from "@/db/schema";
import { nextOccurrence } from "@/core/schedules";

type SyncRunStatus = (typeof syncRunStatusEnum.enumValues)[number];

/**
 * Per-row health for the admin sync table.
 *
 * The page previously coloured each row from the last recorded run status
 * alone, which has no model of time: a dead worker renders fully green (its
 * last run succeeded), and a run wedged for four days looks exactly like one
 * that started four seconds ago. This module adds the two time-based verdicts
 * that fixes — "overdue" (it succeeded, but should have run again by now) and
 * "stuck" (it started and never came back).
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

export type RowHealth =
  "ok" | "partial" | "failed" | "running" | "stuck" | "overdue" | "never";

/**
 * The gap between two consecutive fires of `cron`, or null when that cannot be
 * determined (unsupported grammar, or an unsatisfiable expression such as
 * Feb 30). Derived by asking `nextOccurrence` twice rather than by evaluating
 * the expression here, so `nextOccurrence` stays the only thing in the
 * codebase that decides when a cron fires. (`formatCadence` and this page's
 * `cadenceNamesTime` do read cron *fields*, but neither computes a fire time.)
 *
 * `nextOccurrence` THROWS on grammar outside its supported subset. This module
 * renders a page, so it must degrade rather than propagate: an unreadable cron
 * simply means "cadence unknown".
 */
function cadenceIntervalMs(cron: string, from: Date): number | null {
  try {
    const first = nextOccurrence(cron, from);
    if (!first) return null;
    const second = nextOccurrence(cron, first);
    if (!second) return null;
    return second.getTime() - first.getTime();
  } catch {
    return null;
  }
}

/**
 * True when `cron` says the job should have fired more than OVERDUE_GRACE_MS
 * ago, measured from its own last run. An unreadable or unsatisfiable cron is
 * never overdue — a paraphrase we cannot compute must not become an alarm.
 */
function isOverdue(cron: string, lastRunAt: Date, now: Date): boolean {
  let due: Date | null;
  try {
    due = nextOccurrence(cron, lastRunAt);
  } catch {
    return false;
  }
  if (!due) return false;
  return now.getTime() - due.getTime() > OVERDUE_GRACE_MS;
}

export function rowHealth(input: {
  status: SyncRunStatus | null; // null = run in flight
  startedAt: Date | null;
  finishedAt: Date | null;
  cron: string | null; // null = unscheduled / on-demand
  now: Date;
}): RowHealth {
  const { status, startedAt, finishedAt, cron, now } = input;

  // Nothing has ever run. getSyncStatus seeds a row for every scheduled job
  // precisely so this state is visible instead of being an absent row.
  if (startedAt === null) return "never";

  // In flight: started, no outcome recorded. finishSyncRun writes a status
  // alongside finishedAt (services/sync-run), so a null status with a
  // finishedAt cannot happen today — and if it ever does it is a half-written
  // finish, not a success. Keying purely on `status === null` is the fail-safe
  // reading: that shape reports running/stuck (amber, worth a look) instead of
  // falling through to a green "ok" for a run whose outcome nobody knows.
  if (status === null) {
    const cadence = cron === null ? null : cadenceIntervalMs(cron, startedAt);
    const threshold =
      cadence === null
        ? STUCK_FLOOR_MS
        : Math.max(STUCK_FLOOR_MS, cadence * STUCK_MULTIPLIER);
    return now.getTime() - startedAt.getTime() > threshold ? "stuck" : "running";
  }

  if (status === "failed") return "failed";
  if (status === "partial") return "partial";

  // Succeeded — but a job that succeeded and then never ran again is the
  // failure mode a status-only page cannot see.
  if (status === "ok" && cron !== null) {
    if (isOverdue(cron, finishedAt ?? startedAt, now)) return "overdue";
  }

  return "ok";
}

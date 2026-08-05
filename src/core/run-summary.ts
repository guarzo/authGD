import type { SyncRunStatus } from "@/db/schema";

/**
 * Pure shaping for the admin sync history tables. The rule these helpers exist
 * to enforce: a column earns its width by carrying information. A counter that
 * is zero on every run in the window says nothing that "no change" does not
 * already say, so it does not get a column — the same reasoning that folded
 * the permanently-empty error column into the status cell.
 */

export type RunLike = {
  startedAt: Date | null;
  finishedAt: Date | null;
  counts: Record<string, number> | null;
};

/**
 * Preferred left-to-right order per job type. Only ordering and inclusion
 * priority live here; membership of the column set is decided by the data. A
 * key a job starts emitting without being listed still gets a column, sorted
 * after these — new information is never silently dropped, only re-ordered.
 */
const COLUMN_ORDER: Record<string, string[]> = {
  membership: ["checked", "promoted", "demoted", "invalid", "unresolved", "stale"],
  "membership-recheck": [
    "checked",
    "promoted",
    "demoted",
    "invalid",
    "unresolved",
    "stale",
  ],
  contacts: ["targets", "added", "updated", "removed", "failed", "skipped"],
  wanderer: [
    "added",
    "wouldAdd",
    "removed",
    "wouldRemove",
    "unblocked",
    "wouldUnblock",
    "addFailed",
    "removeFailed",
    "unblockFailed",
  ],
  "discord-roles": [
    "changed",
    "wouldChangeRoles",
    "rolesRemoved",
    "wouldRemoveRoles",
    "relinkResync",
    "notInGuild",
    "failed",
    "skipped",
  ],
  "token-health": ["refreshed", "needsReauth", "invalid", "unlinked", "skipped"],
  purge: ["sessions", "oauthTransactions", "outbox"],
};

/**
 * The count keys that deserve a column for this window of runs: every key seen
 * with a non-zero value in at least one run. A job whose window is entirely
 * quiet yields no columns at all, and every row collapses to "no change".
 */
export function countColumns(jobType: string, runs: RunLike[]): string[] {
  const live = new Set<string>();
  for (const r of runs) {
    if (!r.counts) continue;
    for (const [k, v] of Object.entries(r.counts)) {
      if (typeof v === "number" && v !== 0) live.add(k);
    }
  }
  const preferred = COLUMN_ORDER[jobType] ?? [];
  const ordered = preferred.filter((k) => live.has(k));
  const rest = [...live].filter((k) => !preferred.includes(k)).sort();
  return [...ordered, ...rest];
}

/** True when the run recorded counts and every one of them was zero. */
export function isNoChange(counts: Record<string, number> | null): boolean {
  if (!counts) return false;
  const values = Object.values(counts);
  return values.length > 0 && values.every((v) => v === 0);
}

/**
 * `needsReauth` → `needs reauth`. The table header styling uppercases it, so
 * the words are what matter here, not the case.
 */
export function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

/**
 * How long the run took, at a precision that stays readable across the four
 * orders of magnitude these jobs span — sub-second purges through multi-minute
 * membership sweeps. Null while a run is still in flight, which the caller
 * renders as running rather than as a zero duration.
 */
export function formatDuration(
  started: Date | null,
  finished: Date | null,
): string | null {
  if (!started || !finished) return null;
  const ms = finished.getTime() - started.getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return formatDurationMs(ms);
}

/**
 * The ms/s/m/h ladder `formatDuration` uses, pulled out so a caller with an
 * already-computed span (the min/max group duration below, which has no
 * single start/finish pair to hand `formatDuration`) can format it without
 * duplicating the rounding rules — in particular the "round to whole seconds
 * once, then decompose" step, since rounding each part separately let 5m 59.6s
 * come out as "5m 60s".
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  const total = Math.round(s);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${total % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/* --- Run collapsing ------------------------------------------------------- */

/**
 * A run row the drawer can collapse. `status` and `id` join `RunLike`'s fields
 * because both matter to collapsing: identical counts on a `failed` and an
 * `ok` run are still two different facts, and `id` gives the page a stable
 * React key per group without re-deriving one from a range of timestamps.
 * `errorSummary` is required, not optional: `syncRun.errorSummary` is `text()`,
 * so `$inferSelect` yields `string | null`, never `undefined` — every real
 * producer already has a value here, so a caller that types it optional is
 * making room for a case that cannot happen from the database.
 */
export type CollapsibleRun = RunLike & {
  id: number;
  status: SyncRunStatus | null;
  errorSummary: string | null;
};

/**
 * One row of the (possibly collapsed) runs drawer: either a single run
 * rendered as-is, or a run of consecutive runs that recorded the same
 * outcome, collapsed to save the ~187px five identical `19 / 19 / OK` rows
 * would otherwise spend saying nothing changed. (`.log td` is `--s-3` (12px)
 * padding top and bottom plus a 1px `border-top`, around a `--t-data`
 * (0.875rem = 14px) line box at the body's 1.55 line-height — 14 * 1.55 ≈
 * 21.7px — for ~46.7px per row; four collapsed rows save ~187px.)
 */
export type CollapsedRun<T extends CollapsibleRun = CollapsibleRun> =
  | { kind: "run"; run: T }
  | {
      kind: "group";
      /** The runs the group stands in for, in the order they were given. */
      runs: T[];
      count: number;
      status: SyncRunStatus | null;
      counts: Record<string, number> | null;
      errorSummary: string | null;
      /** Earliest `startedAt` in the group, or null if none is recorded. */
      from: Date | null;
      /** Latest `finishedAt` in the group. Never null: every run inside a
       * group has finished — see `sameOutcome` below. */
      to: Date;
      /** Shortest/longest run duration in the group, in ms. Both null only
       * when no run in the group recorded a `startedAt` — `finishedAt` is
       * guaranteed by `sameOutcome`, but `startedAt` can still be null (see
       * `RunLike`). Collapsing folds five "OK, same counts" runs into one row
       * and, with it, the one detail that made a single run stand out: a
       * 47-minute run during an ESI slowdown reads identically to a 2-minute
       * one once only status/counts survive. `sameOutcome` deliberately never
       * compares duration (durations are near-never equal, so that would stop
       * anything from ever collapsing) — this carries the span forward
       * instead of hiding it. */
      minDurationMs: number | null;
      maxDurationMs: number | null;
    };

/**
 * `Record<string, number>` equality by value, not reference: two runs from
 * separate rows never share a `counts` object, so `===` would never collapse
 * anything. `null` only equals `null` — a run with no recorded counts is a
 * different fact from one that recorded all zeros.
 */
function sameCounts(
  a: Record<string, number> | null,
  b: Record<string, number> | null,
): boolean {
  if (a === null || b === null) return a === b;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, i) => k === bKeys[i] && a[k] === b[k]);
}

/**
 * Whether two runs recorded the same outcome and may collapse together. A run
 * still in flight (`finishedAt === null`) never matches anything, itself
 * included: it has no final counts to compare, and a still-running run must
 * never be folded into a finished one's row — the one case this module exists
 * to get right, since a stuck run reads very differently from a healthy one.
 *
 * `errorSummary` matters even when status and counts agree: `contacts.ts`,
 * `wanderer.ts` and `discord-roles.ts` all build it from per-target error
 * text (`errors.slice(0, 5).join("; ")`) that `counts` never reflects — two
 * `partial` runs can both show `failed: 1` while a different character failed
 * for a different reason each time. Collapsing those would silently hide the
 * second run's diagnostics behind the first's, in exactly the view an admin
 * opened to read them. Refusing to merge is the safe direction.
 */
function sameOutcome(a: CollapsibleRun, b: CollapsibleRun): boolean {
  return (
    a.finishedAt !== null &&
    b.finishedAt !== null &&
    a.status === b.status &&
    sameCounts(a.counts, b.counts) &&
    a.errorSummary === b.errorSummary
  );
}

function earliest(dates: Array<Date | null>): Date | null {
  const known = dates.filter((d): d is Date => d !== null);
  if (known.length === 0) return null;
  return known.reduce((min, d) => (d < min ? d : min));
}

function latest(dates: Array<Date | null>): Date | null {
  const known = dates.filter((d): d is Date => d !== null);
  if (known.length === 0) return null;
  return known.reduce((max, d) => (d > max ? d : max));
}

function toGroup<T extends CollapsibleRun>(runs: T[]): CollapsedRun<T> {
  // Every run reaching here matched its neighbour via sameOutcome, which
  // requires finishedAt !== null on both sides of every comparison — so by
  // the time a run is IN a group (of any size), its own finishedAt is known,
  // and `latest` over the group can never come back null.
  const to = latest(runs.map((r) => r.finishedAt));
  if (to === null) {
    throw new Error("toGroup invariant violated: a grouped run has no finishedAt");
  }
  const durations = runs
    .filter((r): r is T & { startedAt: Date } => r.startedAt !== null)
    .map((r) => r.finishedAt!.getTime() - r.startedAt.getTime());
  return {
    kind: "group",
    runs,
    count: runs.length,
    status: runs[0].status,
    counts: runs[0].counts,
    errorSummary: runs[0].errorSummary,
    from: earliest(runs.map((r) => r.startedAt)),
    to,
    minDurationMs: durations.length > 0 ? Math.min(...durations) : null,
    maxDurationMs: durations.length > 0 ? Math.max(...durations) : null,
  };
}

/**
 * Collapses CONSECUTIVE runs sharing an identical outcome (same status, same
 * counts, same error text, both finished) into one group entry. Order is not
 * assumed beyond "consecutive" — `getSyncStatus` hands these back
 * newest-first, but nothing here reads that direction into the result,
 * `from`/`to` are computed as the min/max over whatever the group contains.
 *
 * A run differing in status, counts, or error text breaks the run and starts
 * a new one. A single run that matches nothing around it comes back as
 * `{ kind: "run" }`, not a one-element group, so the page never has to
 * special-case a group of one.
 */
export function collapseRuns<T extends CollapsibleRun>(runs: T[]): CollapsedRun<T>[] {
  const out: CollapsedRun<T>[] = [];

  for (const run of runs) {
    const last = out[out.length - 1];
    if (last?.kind === "group" && sameOutcome(last.runs[last.runs.length - 1], run)) {
      out[out.length - 1] = toGroup([...last.runs, run]);
      continue;
    }
    if (last?.kind === "run" && sameOutcome(last.run, run)) {
      out[out.length - 1] = toGroup([last.run, run]);
      continue;
    }
    out.push({ kind: "run", run });
  }

  return out;
}

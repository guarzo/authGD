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
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  // Round to whole seconds once, then decompose. Rounding each part separately
  // lets the remainder carry past its own unit — 5m 59.6s came out as "5m 60s".
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
 */
export type CollapsibleRun = RunLike & {
  id: number;
  status: SyncRunStatus | null;
};

/**
 * One row of the (possibly collapsed) runs drawer: either a single run
 * rendered as-is, or a run of consecutive runs that recorded the same
 * outcome, collapsed to save the ~440px five identical `19 / 19 / OK` rows
 * would otherwise spend saying nothing changed.
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
      /** Earliest `startedAt` in the group, or null if none is recorded. */
      from: Date | null;
      /** Latest `finishedAt` in the group. Never null: every run inside a
       * group has finished — see `sameOutcome` below. */
      to: Date | null;
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
 */
function sameOutcome(a: CollapsibleRun, b: CollapsibleRun): boolean {
  return (
    a.finishedAt !== null &&
    b.finishedAt !== null &&
    a.status === b.status &&
    sameCounts(a.counts, b.counts)
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
  return {
    kind: "group",
    runs,
    count: runs.length,
    status: runs[0].status,
    counts: runs[0].counts,
    from: earliest(runs.map((r) => r.startedAt)),
    to: latest(runs.map((r) => r.finishedAt)),
  };
}

/**
 * Collapses CONSECUTIVE runs sharing an identical outcome (same status, same
 * counts, both finished) into one group entry. Order is not assumed beyond
 * "consecutive" — `getSyncStatus` hands these back newest-first, but nothing
 * here reads that direction into the result, `from`/`to` are computed as the
 * min/max over whatever the group contains.
 *
 * A run differing in status or counts breaks the run and starts a new one. A
 * single run that matches nothing around it comes back as `{ kind: "run" }`,
 * not a one-element group, so the page never has to special-case a group of
 * one.
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

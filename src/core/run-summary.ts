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

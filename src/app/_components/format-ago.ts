/**
 * "3m" style, coarse on purpose: the point is freshness, not precision. The
 * bare elapsed string is its own export because the sync page needs the same
 * vocabulary in two grammars — "4m ago" in the time column and "no run in 4h"
 * on the worker line — and two separate formatters would drift into
 * disagreeing about the same instant.
 */
export function elapsedShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * "3m ago" style. A null timestamp is "never": the sync strip now carries a
 * row for a scheduled job that has never run, and the old answer here
 * ("running") made that row announce itself as in flight.
 */
export function formatAgo(iso: string | null, now: number): string {
  if (!iso) return "never";
  return `${elapsedShort(now - Date.parse(iso))} ago`;
}

/**
 * "3d" style, for an instant in the *future*. The structures roster asks a
 * question the sync page never did — not "how stale is this?" but "how long
 * until this runs out?" — and `formatAgo` cannot answer it: `elapsedShort`
 * clamps a negative elapsed to zero (deliberately, for clock skew), so every
 * future instant formatted to the same "0s ago" regardless of how far out it
 * was. A "Fuel expires" column built on it read as though the whole corp had
 * simultaneously run dry.
 *
 * Deliberately bare, no "in": the column headers ("Fuel expires", "Timer
 * ends") already supply the tense. Past-due gets an explicit verb instead,
 * because a dead structure must not read as a small countdown — and the verb
 * is the caller's, since a reinforcement timer has "ended" where fuel has
 * "expired". Shares `elapsedShort` with `formatAgo` so the two grammars cannot
 * drift into disagreeing about the same interval.
 */
export function formatDeadline(
  iso: string | null,
  now: number,
  pastVerb = "expired",
): string {
  if (!iso) return "never";
  const remaining = Date.parse(iso) - now;
  if (remaining <= 0) return `${pastVerb} ${elapsedShort(-remaining)} ago`;
  return elapsedShort(remaining);
}

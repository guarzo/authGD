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

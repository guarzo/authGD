/** "3m ago" style, coarse on purpose: the point is freshness, not precision. */
export function formatAgo(iso: string | null, now: number): string {
  if (!iso) return "running";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

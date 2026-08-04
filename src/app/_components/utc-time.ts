/** Wall-clock UTC, the timezone every EVE player already reads schedules in. */
export function utcHhmm(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * When this snapshot was taken. These pages are `force-dynamic`, so they are
 * only ever as fresh as the last load — and an admin who left the tab open
 * while a sync ran has no other way to tell a stale table from a current one.
 */
export function renderedAt(): string {
  return `as of ${utcHhmm(new Date())} UTC`;
}

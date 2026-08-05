/**
 * Display label for a tier, or the raw value when there is nothing better.
 *
 * Deliberately takes `string`, not `Tier`. Pre-rename `audit_log.details` rows
 * store `flygd`/`blue`/`green` verbatim and are never migrated (spec D4), so
 * historic values reach this function that the enum no longer contains. They
 * render as themselves rather than as a blank or a thrown error — a data
 * artefact stays visibly a data artefact.
 *
 * Pure: `src/core/` reads no config. The label map is supplied by the caller.
 */
export function resolveTierLabel(tier: string, labels: Record<string, string>): string {
  const label = labels[tier];
  return label && label.length > 0 ? label : tier;
}

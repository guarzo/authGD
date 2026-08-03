/**
 * The most frequent job (membership) runs every 30 minutes
 * (src/worker/queues.ts). 90 minutes is three missed ticks: long enough that a
 * slow run or a single retry never pages, short enough that a dead worker is
 * caught within about 90 minutes plus the monitor's own poll interval.
 * Comparison is <=, so a run landing exactly on the threshold reads as fresh.
 * Deliberately a constant and not an environment variable — a second knob would
 * drift from the schedules in queues.ts.
 */
export const STALE_AFTER_MS = 90 * 60 * 1000;

export type Freshness = { fresh: boolean; ageSec: number | null };

export function evaluateFreshness(
  newestStartedAt: Date | null,
  now: Date,
  thresholdMs: number = STALE_AFTER_MS,
): Freshness {
  if (!newestStartedAt) return { fresh: false, ageSec: null };
  const ageMs = now.getTime() - newestStartedAt.getTime();
  return { fresh: ageMs <= thresholdMs, ageSec: Math.floor(ageMs / 1000) };
}

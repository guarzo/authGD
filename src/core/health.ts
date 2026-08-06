/**
 * The most frequent job (location) runs every 15 minutes
 * (`JOB_CRON` in src/core/schedules.ts). 90 minutes is six missed ticks: long
 * enough that a slow run or a single retry never pages, short enough that a
 * dead worker is caught within about 90 minutes plus the monitor's own poll
 * interval. Comparison is <=, so a run landing exactly on the threshold reads
 * as fresh. 90 is a hand-picked constant, not derived from the tick interval —
 * changing the busiest schedule does not change it. Deliberately a constant and
 * not an environment variable — a second knob would drift from the schedules.
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

/**
 * pg-boss's own maintenance cadence: `src/worker/index.ts` constructs `PgBoss`
 * with no `maintenanceIntervalSeconds` override, so the library default (120s,
 * `applyMaintenanceConfig` in pg-boss/src/attorney.js) applies. Every running
 * worker process ticks `pgboss.version.maintained_on` on this cadence — see
 * `workerHeartbeat` in `@/services/health` — regardless of whether it has any
 * job to do, which is exactly what `STALE_AFTER_MS` above cannot say: that
 * threshold can only see JOB activity (`sync_run` rows), and a live worker
 * legitimately goes far longer than 120s between finishing one, so a dead
 * worker and an idle one read identically to it for up to 90 minutes. This
 * heartbeat is worker-scoped rather than job-scoped, so its own threshold can
 * be tight without risking a false "down" on a quiet queue.
 */
export const HEARTBEAT_INTERVAL_MS = 120 * 1000;

/**
 * Three missed maintenance ticks — the same kind of missed-tick margin
 * `STALE_AFTER_MS` gives the job cadence, sized instead to pg-boss's own 120s
 * one. Long enough that ordinary query latency or a single
 * slow maintenance pass never flaps it; short enough that a dead worker is
 * caught within about 6 minutes instead of the ~90 `STALE_AFTER_MS` alone
 * allowed for the admin sync page's worker-liveness line.
 */
export const HEARTBEAT_STALE_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;

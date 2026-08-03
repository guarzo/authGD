import { desc } from "drizzle-orm";
import type { Dbx } from "@/db";
import { syncRun } from "@/db/schema";

/**
 * How long the newest `sync_run` row may be before the worker counts as dead.
 *
 * The shortest schedule in src/worker/queues.ts is membership, every 30
 * minutes, so a healthy worker writes a row at least that often. 90 minutes lets
 * two consecutive runs be missed before we page: one missed run is a slow job
 * or a deploy restart, three is a dead process. Tightening this below ~65
 * minutes will flap on any deploy that straddles a scheduled slot.
 *
 * Deliberately a constant, not an env var: it is derived from the cron
 * expressions in this repo, so it must change when those change — not
 * independently in Fly secrets where the coupling is invisible.
 */
export const WORKER_STALE_AFTER_MS = 90 * 60 * 1000;

export type WorkerLiveness = {
  /**
   * - `ok`      — a job ran within WORKER_STALE_AFTER_MS.
   * - `stale`   — rows exist but the newest is too old. The worker is dead,
   *               wedged, or its scheduler stopped firing.
   * - `unknown` — no sync_run rows at all. See the note in getWorkerLiveness.
   */
  status: "ok" | "stale" | "unknown";
  lastRunAt: string | null;
  lastJobType: string | null;
  ageMs: number | null;
  thresholdMs: number;
};

/**
 * Derives worker liveness from the newest `sync_run` row.
 *
 * This is deliberately an *inferred* signal rather than a dedicated heartbeat
 * table: `runJob` already writes one row per execution, so there is nothing new
 * to maintain and no migration. What it asserts is stronger than "the process
 * is alive" — it asserts the worker reached the database and completed work
 * recently. A worker that is running but cannot see Postgres, or whose
 * scheduler died, reports `stale` here; a bare process check would not.
 *
 * What it does NOT assert: that the queue is being *drained*. A worker chewing
 * through a growing backlog still writes rows and still reports `ok`. Backlog
 * depth is a separate signal and is not covered here.
 *
 * `unknown` (no rows) is treated as not-ready by the callers. Fail-safe beats
 * fail-silent — the incident this whole change exists for was a dead worker
 * that looked fine. The cost is that a freshly-migrated database reports
 * not-ready until the first scheduled job lands, at most 30 minutes.
 */
export async function getWorkerLiveness(
  dbx: Dbx,
  now: Date = new Date(),
): Promise<WorkerLiveness> {
  const [row] = await dbx
    .select({ startedAt: syncRun.startedAt, jobType: syncRun.jobType })
    .from(syncRun)
    // `id` is a serial, so it breaks ties deterministically when two runs share
    // a started_at — without it the "newest" row is whatever Postgres returns.
    .orderBy(desc(syncRun.startedAt), desc(syncRun.id))
    .limit(1);

  if (!row) {
    return {
      status: "unknown",
      lastRunAt: null,
      lastJobType: null,
      ageMs: null,
      thresholdMs: WORKER_STALE_AFTER_MS,
    };
  }

  const ageMs = now.getTime() - row.startedAt.getTime();
  return {
    // A negative age means clock skew between web and worker machines, not
    // staleness — treat it as healthy rather than paging on a clock problem.
    status: ageMs > WORKER_STALE_AFTER_MS ? "stale" : "ok",
    lastRunAt: row.startedAt.toISOString(),
    lastJobType: row.jobType,
    ageMs,
    thresholdMs: WORKER_STALE_AFTER_MS,
  };
}

import type PgBoss from "pg-boss";
import type { FleetSourceDeps } from "@/jobs/fleet-source";
import { QUEUES } from "@/worker/queues";
import { reserveDueFleetAutomatic } from "@/services/fleet-automatic";
import {
  cleanupFleetSources,
  reserveDueFleetSources,
} from "@/services/fleet-source-maintenance";

/** Same worker resources and timer, not another poll owner. Provider backoff
 * gates discovery reservation; candidate pacing never delays active cleanup or
 * the independently paced active-source roster queue. */
export async function runFleetSourceTick(
  deps: FleetSourceDeps,
  canDiscover: () => boolean,
): Promise<void> {
  await cleanupFleetSources(deps.db, deps.now);
  await reserveDueFleetSources(deps.db, deps.now);
  const now = (deps.now?.() ?? new Date()).getTime();
  if (
    !deps.signal?.aborted &&
    canDiscover() &&
    (deps.esi?.getFleetRetryAt(now) ?? 0) <= now
  )
    await reserveDueFleetAutomatic(deps.db, deps.now);
}

/** Worker-owned non-cron loop: immediate startup catch-up, bounded batches,
 * no overlapping ticks, and an awaited stop. Slow DB work reduces throughput,
 * never silently increases the evidence lease. */
export function startFleetSourceScheduler(
  tick: () => Promise<unknown>,
  intervalMs = 500,
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<unknown>;
  const run = () => {
    pending = Promise.resolve()
      .then(tick)
      .catch(() => console.error("fleet_source_scheduler_failed"))
      .finally(() => {
        if (!stopped) timer = setTimeout(run, intervalMs);
      });
  };
  run();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}

/** Drain bounded framework batches without a polling gap per stale reservation.
 * One ORIGINAL batch owns the discovery gate even after framework expiry, and
 * awaits each job (including token CAS) before starting the next. No promise
 * queue or concurrent discovery is created. Failures cannot discard a valid
 * suffix: attempt every delivered task, then reject with the fixed classification.
 */
export async function startFleetAutomaticWork(
  boss: PgBoss,
  owner: ReturnType<typeof createFleetSourceOwner>,
  handler: (data: unknown) => Promise<void>,
  queue: string = QUEUES.fleetAutomatic,
): Promise<void> {
  const owned = owner.wrap(
    async (data) => {
      // pg-boss, not a page payload, supplies this bounded array.
      const jobs = data as PgBoss.Job[];
      let failed = false;
      for (const job of jobs) {
        try {
          await handler(job.data);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error("fleet_automatic_job_failed");
    },
    { discovery: true },
  );
  await boss.work(queue, { pollingIntervalSeconds: 0.5, batchSize: 100 }, (jobs) =>
    owned(jobs),
  );
}

/** pg-boss races callbacks against expireInSeconds and its stop can return before
 * a rotated credential settles. Track ORIGINAL promises, not framework wrappers. */
export function createFleetSourceOwner() {
  let accepting = true;
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();
  let discoveryBusy = false;
  return {
    signal: controller.signal,
    canDiscover: () => accepting && !discoveryBusy,
    wrap:
      (handler: (data: unknown) => Promise<void>, options?: { discovery?: boolean }) =>
      (data: unknown): Promise<void> => {
        if (!accepting) return Promise.resolve();
        // Framework expiry releases pg-boss's slot, not ours. Refuse without
        // claiming or waiting in memory; the retained reservation can expire.
        if (options?.discovery && discoveryBusy)
          return Promise.reject(new Error("fleet_automatic_job_failed"));
        if (options?.discovery) discoveryBusy = true;
        const task = Promise.resolve().then(() => handler(data));
        pending.add(task);
        const settled = () => {
          pending.delete(task);
          if (options?.discovery) discoveryBusy = false;
        };
        void task.then(settled, settled);
        return task;
      },
    stopAdmission() {
      accepting = false;
      controller.abort();
    },
    async drain() {
      await Promise.allSettled([...pending]);
    },
  };
}

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

/** pg-boss races callbacks against expireInSeconds and its stop can return before
 * a rotated credential settles. Track ORIGINAL promises, not framework wrappers. */
export function createFleetSourceOwner() {
  let accepting = true;
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();
  return {
    signal: controller.signal,
    wrap:
      (handler: (data: unknown) => Promise<void>) =>
      (data: unknown): Promise<void> => {
        if (!accepting) return Promise.resolve();
        const task = Promise.resolve().then(() => handler(data));
        pending.add(task);
        void task.then(
          () => pending.delete(task),
          () => pending.delete(task),
        );
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

/**
 * The one place a job's schedule is written down. `src/worker/queues.ts`
 * registers these with pg-boss and the admin sync page renders their cadence,
 * so the page cannot drift from what the worker actually runs — which is the
 * only reason it is honest to show a cadence at all.
 *
 * pg-boss evaluates schedules in UTC unless a timezone is passed, and
 * `scheduleJobs` passes none, so every wall-clock label here says UTC.
 */
export const JOB_CRON: Record<string, string> = {
  membership: "*/30 * * * *",
  "membership-recheck": "0 4 * * 0",
  contacts: "5 * * * *",
  wanderer: "10 * * * *",
  "discord-roles": "15 * * * *",
  "token-health": "0 3 * * *",
  purge: "30 3 * * *",
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n: string): string {
  return n.padStart(2, "0");
}

/**
 * A short human cadence for the shapes this project actually schedules. This
 * is deliberately not a general cron renderer: anything outside those shapes
 * falls back to the raw expression rather than to a confident paraphrase that
 * might be wrong. A cadence is not a next-run time and must not be read as
 * one — computing that would need a cron evaluator and the worker's clock.
 */
export function formatCadence(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = f;
  if (dom !== "*" || mon !== "*") return cron;

  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (dow === "*") {
    if (hour === "*") {
      if (everyMin) return `every ${everyMin[1]}m`;
      if (/^\d+$/.test(min)) return `hourly :${pad(min)}`;
      return cron;
    }
    if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
      return `daily ${pad(hour)}:${pad(min)} UTC`;
    }
    return cron;
  }

  if (/^[0-6]$/.test(dow) && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    return `${DAYS[Number(dow)]} ${pad(hour)}:${pad(min)} UTC`;
  }
  return cron;
}

/** The cadence for a job type, or null when nothing schedules it. */
export function cadenceFor(jobType: string): string | null {
  const cron = JOB_CRON[jobType];
  return cron ? formatCadence(cron) : null;
}

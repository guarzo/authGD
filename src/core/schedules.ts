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

/* --- Next fire time ------------------------------------------------------ */

/**
 * Next-fire-time for the expressions in `JOB_CRON`, in UTC.
 *
 * `formatCadence` above says how often a job runs; this says when it runs
 * next. The account page needs the second, because "next 14:05" is a promise
 * a member can check a clock against.
 *
 * This is a deliberate non-dependency: a general cron library would be a
 * production dependency shipped to the web bundle to answer "when does the
 * contacts job next run", for expressions we control and that never contain
 * anything exotic. The supported grammar below covers every expression in
 * `JOB_CRON` and throws loudly on anything outside it, so an unsupported
 * cadence fails a unit test rather than quietly rendering a wrong time.
 *
 * Grammar per field: a star, a star-slash-step, `a`, `a-b`, and comma-separated
 * lists of those. Fields are minute, hour, day-of-month, month, day-of-week
 * (0 = Sun). Day-of-month and day-of-week both restricting is treated as
 * intersection, not cron's traditional union — no expression here uses both,
 * and the intersection reading is the one that fails safe.
 */
const FIELD_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week
] as const;

function parseField(raw: string, index: number): Set<number> {
  const { min, max } = FIELD_RANGES[index];
  const out = new Set<number>();

  for (const part of raw.split(",")) {
    const [spec, stepRaw, ...extra] = part.split("/");
    // "*/5/2" would otherwise parse as "*/5" with the tail silently dropped,
    // which is the one failure mode this whole module exists to avoid.
    if (extra.length > 0) throw new Error(`unsupported cron step "${part}"`);
    if (stepRaw !== undefined && !/^\d+$/.test(stepRaw)) {
      throw new Error(`unsupported cron step "${part}"`);
    }
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step === 0) throw new Error(`cron step must be non-zero: "${part}"`);

    let lo: number;
    let hi: number;
    if (spec === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(spec)) {
      lo = Number(spec);
      // A bare value with a step means "from here to the end of the range",
      // matching Vixie cron. Without a step it is a single value.
      hi = stepRaw === undefined ? lo : max;
    } else if (/^\d+-\d+$/.test(spec)) {
      [lo, hi] = spec.split("-").map(Number);
    } else {
      throw new Error(`unsupported cron field "${part}"`);
    }

    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron field "${part}" out of range ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  return out;
}

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`expected a 5-field cron expression, got "${expression}"`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map(parseField);
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** Longest gap we will search before giving up: covers weekly schedules. */
const MAX_SCAN_MINUTES = 8 * 24 * 60;

/**
 * The first UTC minute strictly after `from` that matches `expression`.
 *
 * Scans minute by minute rather than solving in closed form. At most ~11.5k
 * iterations for the weekly expression and ~30 for the common ones, which is
 * far cheaper than the bugs a hand-rolled closed form would cost.
 *
 * Returns null if nothing matches within the scan window, which for the
 * supported grammar means the expression is unsatisfiable (e.g. Feb 30).
 * Callers render that as "unknown" rather than crashing the page.
 */
export function nextOccurrence(expression: string, from: Date): Date | null {
  const f = parseCron(expression);

  // Start at the next whole minute: "strictly after" means a schedule that
  // matches the current minute reports the following one, not zero seconds.
  const cursor = new Date(from);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    if (
      f.minute.has(cursor.getUTCMinutes()) &&
      f.hour.has(cursor.getUTCHours()) &&
      f.dayOfMonth.has(cursor.getUTCDate()) &&
      f.month.has(cursor.getUTCMonth() + 1) &&
      f.dayOfWeek.has(cursor.getUTCDay())
    ) {
      return cursor;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  return null;
}

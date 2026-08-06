/**
 * The one place a job's schedule is written down. `src/worker/queues.ts`
 * registers these with pg-boss and the admin sync page renders their cadence,
 * so the page cannot drift from what the worker actually runs — which is the
 * only reason it is honest to show a cadence at all.
 *
 * pg-boss evaluates schedules in UTC unless a timezone is passed, and
 * `scheduleJobs` passes none, so every wall-clock label here says UTC.
 */
export const JOB_CRON = {
  membership: "*/30 * * * *",
  "membership-recheck": "0 4 * * 0",
  contacts: "5 * * * *",
  wanderer: "10 * * * *",
  "discord-roles": "15 * * * *",
  "token-health": "0 3 * * *",
  purge: "30 3 * * *",
  // Offset off :00/:05/:10/:15 on purpose. There is no access-token cache, so
  // this job quadruples per-character SSO refreshes and would otherwise race
  // the contacts job for the same rows (src/services/tokens.ts:100).
  location: "2,17,32,47 * * * *",
} as const satisfies Record<string, string>;

/**
 * The job types this table schedules. `as const` above is what makes this a
 * union of the eight literals rather than `string`: indexing `JOB_CRON` with an
 * arbitrary string is now a compile error, so every lookup has to come through
 * `cronFor` and prove it handled the absent case. Typing the table as
 * `Record<string, string>` instead made `JOB_CRON[x] ?? fallback` typecheck
 * with a fallback arm TypeScript believed was unreachable and the runtime
 * needed — a reader could not tell those from genuinely dead code.
 */
export type JobType = keyof typeof JOB_CRON;

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && Object.hasOwn(JOB_CRON, value);
}

/** The cron for a job type, or null when nothing schedules it. */
export function cronFor(jobType: string): string | null {
  return isJobType(jobType) ? JOB_CRON[jobType] : null;
}

/**
 * Which strip of the admin sync page a job belongs to. This follows what the
 * page's OWN controls can reach, not the job's queue mechanics:
 *
 * - `sweep` — the four jobs the primary "sync everything" fan-out enqueues
 *   (membership, contacts, wanderer, discord-roles).
 * - `on-demand` — reachable from a dedicated control other than the fan-out
 *   (membership-recheck, via "Recheck invalid affiliations").
 * - `housekeeping` — not reachable from any page control (token-health, purge,
 *   location).
 *
 * `Record<JobType, JobGroup>` rather than a partial map: adding a `JOB_CRON`
 * key without deciding its group is a compile error here, the same argument
 * `JobType` itself makes for `cronFor`.
 */
export type JobGroup = "sweep" | "on-demand" | "housekeeping";

export const JOB_GROUP: Record<JobType, JobGroup> = {
  membership: "sweep",
  contacts: "sweep",
  wanderer: "sweep",
  "discord-roles": "sweep",
  "membership-recheck": "on-demand",
  "token-health": "housekeeping",
  purge: "housekeeping",
  location: "housekeeping",
};

/** The strip a job type belongs to, or null when nothing schedules it. */
export function groupFor(jobType: string): JobGroup | null {
  return isJobType(jobType) ? JOB_GROUP[jobType] : null;
}

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
  const cron = cronFor(jobType);
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

/** Longest gap we will search minute-by-minute before giving up on a match. */
const MAX_SCAN_MINUTES = 8 * 24 * 60;

/** The scan window as a duration, so callers can use it as a cadence floor. */
export const SCAN_WINDOW_MS = MAX_SCAN_MINUTES * 60 * 1000;

/**
 * Why `nextOccurrence` produced no time.
 *
 * "no match inside eight days" and "this expression can never fire" are very
 * different facts and used to arrive as the same null. A caller that treats
 * both as "cadence unknown" renders the first monthly cron anyone adds as
 * permanently on-time, in the calmest colour, while also dropping its
 * stuck-run threshold to the 15-minute floor. Separating them lets a caller
 * treat `beyond-window` as "at least eight days" — a real lower bound — and
 * `unsatisfiable` as the configuration error it is.
 */
export type NextFire =
  { kind: "at"; at: Date } | { kind: "beyond-window" } | { kind: "unsatisfiable" };

/**
 * Whether any calendar day inside a four-year window satisfies the date fields.
 * Four years covers the leap-day cycle, which is the only reason a date-only
 * expression can be satisfiable but rare (`0 0 29 2 *`).
 *
 * Day granularity on purpose: the minute and hour sets are non-empty by
 * construction (`parseField` throws rather than returning an empty set), so if
 * a matching *day* exists the expression fires on it.
 */
function hasMatchingDay(f: CronFields, from: Date): boolean {
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  for (let i = 0; i < 4 * 366; i++) {
    if (
      f.dayOfMonth.has(cursor.getUTCDate()) &&
      f.month.has(cursor.getUTCMonth() + 1) &&
      f.dayOfWeek.has(cursor.getUTCDay())
    ) {
      return true;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return false;
}

/**
 * The first UTC minute strictly after `from` that matches `expression`, or why
 * there isn't one.
 *
 * Scans minute by minute rather than solving in closed form. At most ~11.5k
 * iterations for the weekly expression and ~30 for the common ones, which is
 * far cheaper than the bugs a hand-rolled closed form would cost. The day-level
 * probe that classifies a miss runs only when the minute scan found nothing —
 * i.e. never for any expression in `JOB_CRON`.
 */
export function nextFire(expression: string, from: Date): NextFire {
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
      return { kind: "at", at: cursor };
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  return hasMatchingDay(f, cursor)
    ? { kind: "beyond-window" }
    : { kind: "unsatisfiable" };
}

/**
 * The first UTC minute strictly after `from` that matches `expression`, or null
 * when there is none inside the scan window. Callers that need to tell a
 * monthly cadence from an impossible one want `nextFire` instead.
 */
export function nextOccurrence(expression: string, from: Date): Date | null {
  const fire = nextFire(expression, from);
  return fire.kind === "at" ? fire.at : null;
}

/**
 * Next scheduled fire for a job type, or null when we cannot say — unscheduled,
 * unsupported grammar, or further out than the scan window.
 *
 * The one implementation of "when does this job next run". Both the account
 * page's "next check" line and the admin sync strip's next-run decoration are
 * renders of a schedule that must not throw and take a page down, and having
 * each own its try/catch meant one of the two copies had no test.
 */
export function nextRunAt(jobType: string, now: Date): Date | null {
  const cron = cronFor(jobType);
  if (cron === null) return null;
  try {
    return nextOccurrence(cron, now);
  } catch {
    return null;
  }
}

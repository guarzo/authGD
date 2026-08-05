import { describe, expect, it } from "vitest";
import { JOB_CRON } from "@/core/schedules";
import {
  isOverdue,
  OVERDUE_GRACE_MS,
  rowHealth,
  STUCK_FLOOR_MS,
  STUCK_MULTIPLIER,
  type RowHealth,
} from "@/core/run-health";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/**
 * A Sunday 04:00 UTC. Chosen so the weekly `membership-recheck` (`0 4 * * 0`)
 * has a fire minute inside the fixture rather than a week away; the other
 * expressions fire at other minutes, which does not matter because every case
 * below measures from its own run time, not from a fire minute.
 */
const SUNDAY_0400 = new Date("2026-03-01T04:00:00.000Z");

/**
 * Annual, and 10 months out from the fixture: past the schedule module's 8-day
 * scan window, but perfectly satisfiable. The two are different answers and
 * this module has to tell them apart.
 */
const ANNUAL = "0 0 1 1 *";

function at(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

/** Defaults for a healthy just-finished membership run. */
function row(over: Partial<Parameters<typeof rowHealth>[0]> = {}): RowHealth {
  return rowHealth({
    status: "ok",
    startedAt: SUNDAY_0400,
    finishedAt: SUNDAY_0400,
    cron: JOB_CRON.membership,
    now: at(SUNDAY_0400, MIN),
    ...over,
  });
}

describe("rowHealth", () => {
  it("passes failed and partial straight through", () => {
    expect(row({ status: "failed" })).toBe("failing");
    expect(row({ status: "partial" })).toBe("degraded");
    // ...even long after the fact, where an overdue check would also fire:
    // the recorded failure is the more useful thing to say.
    expect(row({ status: "failed", now: at(SUNDAY_0400, 30 * DAY) })).toBe("failing");
    expect(row({ status: "partial", now: at(SUNDAY_0400, 30 * DAY) })).toBe("degraded");
  });

  it("reports a recent success as fresh", () => {
    expect(row()).toBe("fresh");
  });

  describe("never run", () => {
    const unrun = (over: Partial<Parameters<typeof rowHealth>[0]> = {}) =>
      row({ startedAt: null, finishedAt: null, status: null, ...over });

    it("says never when nothing yet says it should have run", () => {
      // No evidence the worker has been up at all.
      expect(unrun()).toBe("never");
      // Evidence, but not yet a full cadence of it.
      expect(unrun({ seenSince: at(SUNDAY_0400, -MIN) })).toBe("never");
      // Unscheduled: there is no cadence to be late against, ever.
      expect(unrun({ cron: null, seenSince: at(SUNDAY_0400, -365 * DAY) })).toBe("never");
    });

    it("escalates to missing once the worker has outlived the cadence", () => {
      // The worker has been recording runs for an hour; a 30-minute job with
      // nothing at all is not "not yet".
      expect(unrun({ seenSince: at(SUNDAY_0400, -HOUR) })).toBe("missing");
    });

    it("stays never for a cadence that has not come round yet", () => {
      // Evidence stretches back a month, but the job only fires annually and
      // its next fire is still ahead of us: nothing is late.
      expect(unrun({ cron: ANNUAL, seenSince: at(SUNDAY_0400, -30 * DAY) })).toBe(
        "never",
      );
    });

    it("says unknown when the cron cannot be read", () => {
      const seenSince = at(SUNDAY_0400, -365 * DAY);
      expect(unrun({ cron: "not a cron", seenSince })).toBe("unknown");
      expect(unrun({ cron: "0 0 30 2 *", seenSince })).toBe("unknown"); // Feb 30
    });
  });

  describe("in flight", () => {
    const flight = (elapsedMs: number, cron: string | null) =>
      row({
        status: null,
        finishedAt: null,
        cron,
        now: at(SUNDAY_0400, elapsedMs),
      });

    it("is inflight below the threshold and stuck above it", () => {
      // membership: 30m cadence * 3 = 90m, above the 15m floor
      expect(flight(89 * MIN, JOB_CRON.membership)).toBe("inflight");
      expect(flight(90 * MIN, JOB_CRON.membership)).toBe("inflight"); // strictly greater
      expect(flight(91 * MIN, JOB_CRON.membership)).toBe("stuck");
    });

    it("floors the threshold for an unscheduled job", () => {
      expect(flight(STUCK_FLOOR_MS, null)).toBe("inflight");
      expect(flight(STUCK_FLOOR_MS + MIN, null)).toBe("stuck");
    });

    it("floors the threshold for a cron faster than the floor", () => {
      // */1 gives a 1m cadence; 3m would be absurdly trigger-happy, so the
      // 15m floor must win.
      expect(flight(14 * MIN, "*/1 * * * *")).toBe("inflight");
      expect(flight(16 * MIN, "*/1 * * * *")).toBe("stuck");
    });

    it("falls back to the floor when the cron cannot be read", () => {
      expect(flight(14 * MIN, "not a cron")).toBe("inflight"); // throws internally
      expect(flight(16 * MIN, "not a cron")).toBe("stuck");
      expect(flight(16 * MIN, "0 0 30 2 *")).toBe("stuck"); // unsatisfiable
    });

    it("uses each job's own cadence, so the weekly job gets a week of slack", () => {
      expect(flight(7 * DAY, JOB_CRON["membership-recheck"])).toBe("inflight");
      expect(flight(21 * DAY + MIN, JOB_CRON["membership-recheck"])).toBe("stuck");
    });

    it("gives a cadence beyond the scan window the window as a lower bound", () => {
      // An annual job is not stuck after 15 minutes just because its interval
      // cannot be measured inside an 8-day scan: 8 days * 3 is the floor that
      // applies instead.
      expect(flight(20 * DAY, ANNUAL)).toBe("inflight");
      expect(flight(25 * DAY, ANNUAL)).toBe("stuck");
    });
  });

  describe("overdue", () => {
    // membership fires every 30m: last run 04:00 -> next due 04:30.
    const due = at(SUNDAY_0400, 30 * MIN);

    it("respects the grace window on both sides", () => {
      expect(row({ now: at(due, OVERDUE_GRACE_MS - 1) })).toBe("fresh");
      expect(row({ now: at(due, OVERDUE_GRACE_MS) })).toBe("fresh"); // strictly greater
      expect(row({ now: at(due, OVERDUE_GRACE_MS + 1) })).toBe("overdue");
    });

    it("measures from finishedAt, falling back to startedAt", () => {
      // A run that started at 04:00 and finished at 04:20 is next due 04:30,
      // not 04:10 — measuring from the start would call it overdue early.
      const late = { startedAt: SUNDAY_0400, finishedAt: at(SUNDAY_0400, 20 * MIN) };
      expect(row({ ...late, now: at(SUNDAY_0400, 34 * MIN) })).toBe("fresh");
      // With no finishedAt recorded, startedAt is the only anchor available.
      expect(
        row({ startedAt: SUNDAY_0400, finishedAt: null, now: at(due, 6 * MIN) }),
      ).toBe("overdue");
    });

    it("never fires for an unscheduled job, however old the run", () => {
      expect(row({ cron: null, now: at(SUNDAY_0400, 365 * DAY) })).toBe("fresh");
    });

    it("says unknown, not fresh, when the cron throws or is unsatisfiable", () => {
      // The stuck path degrades toward amber on the same input. A green "ok"
      // here would be indistinguishable from a job that ran four minutes ago —
      // the exact conflation this module exists to end.
      const ancient = at(SUNDAY_0400, 365 * DAY);
      expect(row({ cron: "not a cron", now: ancient })).toBe("unknown");
      expect(row({ cron: "*/5/2 * * * *", now: ancient })).toBe("unknown");
      expect(row({ cron: "0 0 30 2 *", now: ancient })).toBe("unknown"); // Feb 30
    });

    it("stays fresh for a satisfiable cadence beyond the scan window", () => {
      // Not due for ten months. "We could not see the fire inside 8 days" is
      // not the same claim as "we could not read the expression".
      expect(row({ cron: ANNUAL, now: at(SUNDAY_0400, 7 * DAY) })).toBe("fresh");
    });

    it.each(Object.entries(JOB_CRON))(
      "computes an overdue verdict for %s (%s)",
      (_jobType, cron) => {
        // Just after the last run, every job is on time...
        expect(row({ cron, now: at(SUNDAY_0400, MIN) })).toBe("fresh");
        // ...and eight days later, every job is late, including the weekly one.
        expect(row({ cron, now: at(SUNDAY_0400, 8 * DAY) })).toBe("overdue");
      },
    );

    it("does not call the weekly job overdue mid-week", () => {
      // The 90-minute global STALE_AFTER_MS would flag this; a per-cadence
      // threshold must not.
      expect(
        row({ cron: JOB_CRON["membership-recheck"], now: at(SUNDAY_0400, 3 * DAY) }),
      ).toBe("fresh");
    });
  });

  it("keeps the exported knobs at their documented values", () => {
    expect(OVERDUE_GRACE_MS).toBe(5 * 60 * 1000);
    expect(STUCK_MULTIPLIER).toBe(3);
    expect(STUCK_FLOOR_MS).toBe(15 * 60 * 1000);
  });
});

describe("isOverdue", () => {
  // discord-roles fires hourly at :15; last completion 14:15 is next due
  // 15:15, overdue past the 5-minute grace at 15:21.
  const SINCE = new Date("2026-01-05T14:15:00.000Z");
  const cron = JOB_CRON["discord-roles"];

  it("is never overdue with no cron — nothing schedules it", () => {
    expect(isOverdue(null, SINCE, at(SINCE, 365 * DAY))).toBe(false);
  });

  it("is never overdue with no anchor — nothing to be late against", () => {
    expect(isOverdue(cron, null, at(SINCE, 365 * DAY))).toBe(false);
  });

  it("is not overdue on time", () => {
    expect(isOverdue(cron, SINCE, at(SINCE, HOUR))).toBe(false); // exactly 15:15
  });

  it("respects the grace window", () => {
    const due = at(SINCE, HOUR); // 15:15
    expect(isOverdue(cron, SINCE, at(due, OVERDUE_GRACE_MS))).toBe(false); // 15:20, not yet
    expect(isOverdue(cron, SINCE, at(due, OVERDUE_GRACE_MS + 1))).toBe(true); // 15:21
  });

  it("is overdue past the grace window", () => {
    expect(isOverdue(cron, SINCE, at(SINCE, 2 * HOUR))).toBe(true);
  });

  it("is not overdue when the cron cannot be read — unreadable collapses to false", () => {
    expect(isOverdue("not a cron", SINCE, at(SINCE, 365 * DAY))).toBe(false);
    expect(isOverdue("0 0 30 2 *", SINCE, at(SINCE, 365 * DAY))).toBe(false); // Feb 30
  });
});

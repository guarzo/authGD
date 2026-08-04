import { describe, expect, it } from "vitest";
import { JOB_CRON } from "@/core/schedules";
import {
  OVERDUE_GRACE_MS,
  rowHealth,
  STUCK_FLOOR_MS,
  STUCK_MULTIPLIER,
  type RowHealth,
} from "@/core/run-health";

const MIN = 60 * 1000;
/**
 * A Sunday 04:00 UTC. Chosen so the weekly `membership-recheck` (`0 4 * * 0`)
 * has a fire minute inside the fixture rather than a week away; the other
 * expressions fire at other minutes, which does not matter because every case
 * below measures from its own run time, not from a fire minute.
 */
const SUNDAY_0400 = new Date("2026-03-01T04:00:00.000Z");

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
  it("reports a job that has never run", () => {
    expect(row({ startedAt: null, finishedAt: null, status: null })).toBe("never");
    // "never" wins even for an unscheduled job with no cron to reason about
    expect(row({ startedAt: null, finishedAt: null, status: null, cron: null })).toBe(
      "never",
    );
  });

  it("passes failed and partial straight through", () => {
    expect(row({ status: "failed" })).toBe("failed");
    expect(row({ status: "partial" })).toBe("partial");
    // ...even long after the fact, where an overdue check would also fire:
    // the recorded failure is the more useful thing to say.
    expect(row({ status: "failed", now: at(SUNDAY_0400, 30 * 24 * 60 * MIN) })).toBe(
      "failed",
    );
    expect(row({ status: "partial", now: at(SUNDAY_0400, 30 * 24 * 60 * MIN) })).toBe(
      "partial",
    );
  });

  it("reports a fresh success as ok", () => {
    expect(row()).toBe("ok");
  });

  describe("in flight", () => {
    const flight = (elapsedMs: number, cron: string | null) =>
      row({
        status: null,
        finishedAt: null,
        cron,
        now: at(SUNDAY_0400, elapsedMs),
      });

    it("is running below the threshold and stuck above it", () => {
      // membership: 30m cadence * 3 = 90m, above the 15m floor
      expect(flight(89 * MIN, JOB_CRON.membership)).toBe("running");
      expect(flight(90 * MIN, JOB_CRON.membership)).toBe("running"); // strictly greater
      expect(flight(91 * MIN, JOB_CRON.membership)).toBe("stuck");
    });

    it("floors the threshold for an unscheduled job", () => {
      expect(flight(STUCK_FLOOR_MS, null)).toBe("running");
      expect(flight(STUCK_FLOOR_MS + MIN, null)).toBe("stuck");
    });

    it("floors the threshold for a cron faster than the floor", () => {
      // */1 gives a 1m cadence; 3m would be absurdly trigger-happy, so the
      // 15m floor must win.
      expect(flight(14 * MIN, "*/1 * * * *")).toBe("running");
      expect(flight(16 * MIN, "*/1 * * * *")).toBe("stuck");
    });

    it("falls back to the floor when the cron cannot be read", () => {
      expect(flight(14 * MIN, "not a cron")).toBe("running"); // throws internally
      expect(flight(16 * MIN, "not a cron")).toBe("stuck");
      expect(flight(16 * MIN, "0 0 30 2 *")).toBe("stuck"); // unsatisfiable
    });

    it("uses each job's own cadence, so the weekly job gets a week of slack", () => {
      const week = 7 * 24 * 60 * MIN;
      expect(flight(week, JOB_CRON["membership-recheck"])).toBe("running");
      expect(flight(3 * week + MIN, JOB_CRON["membership-recheck"])).toBe("stuck");
    });

    // finishSyncRun writes status and finishedAt together, so a null status
    // with a finishedAt is unreachable today. It is still the one shape in the
    // state space with no outcome recorded, and it must not render green:
    // rowHealth keys in-flight purely on `status === null` for that reason.
    it("treats a null status with a finishedAt as in flight, not ok", () => {
      expect(
        row({
          status: null,
          finishedAt: at(SUNDAY_0400, MIN),
          now: at(SUNDAY_0400, 2 * MIN),
        }),
      ).toBe("running");
      expect(
        row({
          status: null,
          finishedAt: at(SUNDAY_0400, MIN),
          now: at(SUNDAY_0400, 91 * MIN),
        }),
      ).toBe("stuck");
    });
  });

  describe("overdue", () => {
    // membership fires every 30m: last run 04:00 -> next due 04:30.
    const due = at(SUNDAY_0400, 30 * MIN);

    it("respects the grace window on both sides", () => {
      expect(row({ now: at(due, OVERDUE_GRACE_MS - 1) })).toBe("ok");
      expect(row({ now: at(due, OVERDUE_GRACE_MS) })).toBe("ok"); // strictly greater
      expect(row({ now: at(due, OVERDUE_GRACE_MS + 1) })).toBe("overdue");
    });

    it("measures from finishedAt, falling back to startedAt", () => {
      // A run that started at 04:00 and finished at 04:20 is next due 04:30,
      // not 04:10 — measuring from the start would call it overdue early.
      const late = { startedAt: SUNDAY_0400, finishedAt: at(SUNDAY_0400, 20 * MIN) };
      expect(row({ ...late, now: at(SUNDAY_0400, 34 * MIN) })).toBe("ok");
      // With no finishedAt recorded, startedAt is the only anchor available.
      expect(
        row({ startedAt: SUNDAY_0400, finishedAt: null, now: at(due, 6 * MIN) }),
      ).toBe("overdue");
    });

    it("never fires for an unscheduled job, however old the run", () => {
      expect(row({ cron: null, now: at(SUNDAY_0400, 365 * 24 * 60 * MIN) })).toBe("ok");
    });

    it("degrades to ok when the cron throws or is unsatisfiable", () => {
      const ancient = at(SUNDAY_0400, 365 * 24 * 60 * MIN);
      expect(row({ cron: "not a cron", now: ancient })).toBe("ok");
      expect(row({ cron: "*/5/2 * * * *", now: ancient })).toBe("ok");
      expect(row({ cron: "0 0 30 2 *", now: ancient })).toBe("ok"); // Feb 30
    });

    it.each(Object.entries(JOB_CRON))(
      "computes an overdue verdict for %s (%s)",
      (_jobType, cron) => {
        // Just after the last run, every job is on time...
        expect(row({ cron, now: at(SUNDAY_0400, MIN) })).toBe("ok");
        // ...and eight days later, every job is late, including the weekly one.
        expect(row({ cron, now: at(SUNDAY_0400, 8 * 24 * 60 * MIN) })).toBe("overdue");
      },
    );

    it("does not call the weekly job overdue mid-week", () => {
      // The 90-minute global STALE_AFTER_MS would flag this; a per-cadence
      // threshold must not.
      expect(
        row({
          cron: JOB_CRON["membership-recheck"],
          now: at(SUNDAY_0400, 3 * 24 * 60 * MIN),
        }),
      ).toBe("ok");
    });
  });

  it("keeps the exported knobs at their documented values", () => {
    expect(OVERDUE_GRACE_MS).toBe(5 * 60 * 1000);
    expect(STUCK_MULTIPLIER).toBe(3);
    expect(STUCK_FLOOR_MS).toBe(15 * 60 * 1000);
  });
});

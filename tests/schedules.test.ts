import { describe, expect, it } from "vitest";
import {
  JOB_CRON,
  JOB_GROUP,
  SCAN_WINDOW_MS,
  cadenceFor,
  cronFor,
  formatCadence,
  groupFor,
  isJobType,
  nextFire,
  nextOccurrence,
  parseCron,
} from "@/core/schedules";
import { QUEUES } from "@/worker/queues";

describe("formatCadence", () => {
  it("renders the shapes this project schedules", () => {
    expect(formatCadence("*/30 * * * *")).toBe("every 30m");
    expect(formatCadence("5 * * * *")).toBe("hourly :05");
    expect(formatCadence("15 * * * *")).toBe("hourly :15");
    expect(formatCadence("0 3 * * *")).toBe("daily 03:00 UTC");
    expect(formatCadence("30 3 * * *")).toBe("daily 03:30 UTC");
    expect(formatCadence("0 4 * * 0")).toBe("Sun 04:00 UTC");
  });

  it("falls back to the raw expression rather than guessing", () => {
    // A confident paraphrase of a shape the formatter does not model would be
    // a lie on an operations page; the cron string is at least checkable.
    for (const cron of ["0 0 1 * *", "*/7 2-5 * * 1-5", "@daily", "0 4 * * 1,3"]) {
      expect(formatCadence(cron)).toBe(cron);
    }
  });

  it("renders an evenly-spaced comma-list minute, wrap included, as 'every Nm from :MM'", () => {
    // The location cadence: gaps 15, 15, 15, and the wrap 47 -> (60+2) is also
    // 15, so this is genuinely every 15 minutes and safe to paraphrase.
    expect(formatCadence("2,17,32,47 * * * *")).toBe("every 15m from :02");
    // A second evenly-spaced shape, to prove the branch isn't hardcoded to
    // location's four values: gaps 20, 20, wrap 40 -> (60+0) is also 20.
    expect(formatCadence("0,20,40 * * * *")).toBe("every 20m from :00");
  });

  it("falls through a comma list whose wrap breaks the even spacing", () => {
    // `0,15,30` has uniform internal gaps (15, 15) but the wrap from 30 back
    // to 0 is 30 minutes, not 15 — the list only fires 3 times an hour, not 4.
    // Paraphrasing it as "every 15m" would be the exact wrong-but-confident
    // rendering the module's docblock exists to prevent, so it must keep
    // falling through to the raw expression.
    expect(formatCadence("0,15,30 * * * *")).toBe("0,15,30 * * * *");
  });

  it("falls through a comma list with no consistent gap at all", () => {
    expect(formatCadence("1,2,3 * * * *")).toBe("1,2,3 * * * *");
  });

  it("falls through a step that does not divide the hour", () => {
    // The `*/n` counterpart of the wrap case above. Cron restarts the step at
    // :00 each hour instead of carrying it, so `*/7` fires :00,:07…:56 and then
    // :00 — a four-minute gap. "every 7m" is the same confident-and-wrong
    // rendering `0,15,30` is rejected for, so it falls through identically.
    expect(formatCadence("*/7 * * * *")).toBe("*/7 * * * *");
    expect(formatCadence("*/8 * * * *")).toBe("*/8 * * * *");
  });

  it("falls through a step wider than the hour, which parses as hourly", () => {
    // The sharpest case, because nothing errors: `parseCron` accepts `*/90`
    // and yields the single minute {0}, so the next-run decoration correctly
    // reports the next :00 while an unguarded cadence claims 90 minutes. The
    // page would state two contradictory facts with nothing logged anywhere.
    expect(formatCadence("*/90 * * * *")).toBe("*/90 * * * *");
    expect([...parseCron("*/90 * * * *").minute]).toEqual([0]);
  });

  it("falls through a zero step rather than rendering 'every 0m'", () => {
    // `parseCron` throws on this, so `nextRunAt` swallows it to null: the
    // confident sentence would sit on the page with no next run beside it.
    expect(formatCadence("*/0 * * * *")).toBe("*/0 * * * *");
    expect(() => parseCron("*/0 * * * *")).toThrow(/non-zero/);
  });

  it("renders the steps that do divide the hour", () => {
    // The bound is divisibility, not a whitelist — including n = 60, which
    // yields the single minute :00 and is genuinely once every 60 minutes.
    expect(formatCadence("*/1 * * * *")).toBe("every 1m");
    expect(formatCadence("*/20 * * * *")).toBe("every 20m");
    expect(formatCadence("*/60 * * * *")).toBe("every 60m");
    expect([...parseCron("*/60 * * * *").minute]).toEqual([0]);
  });

  it("falls through an evenly-spaced list that leaves the minute range", () => {
    // Even spacing and a correct wrap say nothing about range: `45,60,75,90`
    // has gaps of 15 and wraps by 15 under the same algebra `2,17,32,47` does.
    // `parseCron` rejects it outright, so rendering "every 15m from :45" would
    // put a confident sentence on the page with the next-run decoration beside
    // it silently absent — the raw expression is the honest answer.
    expect(formatCadence("45,60,75,90 * * * *")).toBe("45,60,75,90 * * * *");
    expect(formatCadence("60,90 * * * *")).toBe("60,90 * * * *");
  });

  it("falls through a comma-list minute on a fixed hour", () => {
    // Evenly-spaced-minutes reasoning only applies to the "every hour" shape;
    // a fixed hour is a different cadence question this formatter does not
    // model, so it falls through even though the minute list itself is fine.
    expect(formatCadence("2,17,32,47 3 * * *")).toBe("2,17,32,47 3 * * *");
  });
});

describe("cadenceFor", () => {
  it("covers every queue the worker schedules", () => {
    // Guards the page's claim: a queue registered without a JOB_CRON entry
    // would render no cadence at all, so the two must stay in step.
    for (const name of Object.values(QUEUES)) {
      if (name === QUEUES.deadLetter) continue; // not scheduled
      expect(JOB_CRON[name], `${name} has no cron`).toBeTruthy();
      expect(cadenceFor(name)).not.toBeNull();
    }
  });

  it("returns null for a job nothing schedules", () => {
    expect(cadenceFor("zz-custom")).toBeNull();
  });
});

const at = (iso: string) => new Date(iso);
const iso = (d: Date | null) =>
  d === null ? null : d.toISOString().replace(/\.000Z$/, "Z");

describe("parseCron", () => {
  it("rejects expressions that are not five fields", () => {
    expect(() => parseCron("* * * *")).toThrow(/5-field/);
    expect(() => parseCron("* * * * * *")).toThrow(/5-field/);
  });

  it("rejects field values outside their range", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * 0 * *")).toThrow(/out of range/);
  });

  it("rejects grammar it does not implement, rather than guessing", () => {
    // Named days, step-less ranges with letters, and @daily are all things a
    // real cron library supports and this one deliberately does not.
    expect(() => parseCron("0 4 * * SUN")).toThrow(/unsupported/);
    expect(() => parseCron("@daily")).toThrow(/5-field/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/non-zero/);
    // A second slash is not a nested step: it used to parse as "*/5" with the
    // tail dropped, which is exactly the quiet wrong answer this module exists
    // to avoid.
    expect(() => parseCron("*/5/2 * * * *")).toThrow(/unsupported cron step/);
  });

  it("expands the grammar it does implement", () => {
    expect([...parseCron("*/15 * * * *").minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("1,3,5 * * * *").minute]).toEqual([1, 3, 5]);
    expect([...parseCron("10-13 * * * *").minute]).toEqual([10, 11, 12, 13]);
    // A bare value with a step runs to the end of the range, per Vixie cron.
    expect([...parseCron("50/5 * * * *").minute]).toEqual([50, 55]);
  });
});

describe("nextOccurrence", () => {
  it("is strictly after the given instant, never equal to it", () => {
    // 12:05:00 exactly matches "5 * * * *"; the answer is the NEXT one.
    expect(iso(nextOccurrence("5 * * * *", at("2026-08-03T12:05:00Z")))).toBe(
      "2026-08-03T13:05:00Z",
    );
  });

  it("ignores seconds in the input instant", () => {
    expect(iso(nextOccurrence("5 * * * *", at("2026-08-03T12:04:59.999Z")))).toBe(
      "2026-08-03T12:05:00Z",
    );
  });

  it("rolls over the hour, the day, the month, and the year", () => {
    expect(iso(nextOccurrence("5 * * * *", at("2026-08-03T12:06:00Z")))).toBe(
      "2026-08-03T13:05:00Z",
    );
    expect(iso(nextOccurrence("0 3 * * *", at("2026-08-03T04:00:00Z")))).toBe(
      "2026-08-04T03:00:00Z",
    );
    expect(iso(nextOccurrence("0 3 * * *", at("2026-08-31T04:00:00Z")))).toBe(
      "2026-09-01T03:00:00Z",
    );
    expect(iso(nextOccurrence("0 3 * * *", at("2026-12-31T04:00:00Z")))).toBe(
      "2027-01-01T03:00:00Z",
    );
  });

  it("handles the half-hourly membership cadence", () => {
    expect(iso(nextOccurrence("*/30 * * * *", at("2026-08-03T12:00:01Z")))).toBe(
      "2026-08-03T12:30:00Z",
    );
    expect(iso(nextOccurrence("*/30 * * * *", at("2026-08-03T12:45:00Z")))).toBe(
      "2026-08-03T13:00:00Z",
    );
  });

  it("handles the weekly recheck, including the same-day-but-later case", () => {
    // Sunday 2026-08-02 at 03:00 -> later that same Sunday.
    expect(iso(nextOccurrence("0 4 * * 0", at("2026-08-02T03:00:00Z")))).toBe(
      "2026-08-02T04:00:00Z",
    );
    // Sunday 2026-08-02 at 05:00 -> a full week later.
    expect(iso(nextOccurrence("0 4 * * 0", at("2026-08-02T05:00:00Z")))).toBe(
      "2026-08-09T04:00:00Z",
    );
    // Monday -> the coming Sunday.
    expect(iso(nextOccurrence("0 4 * * 0", at("2026-08-03T12:00:00Z")))).toBe(
      "2026-08-09T04:00:00Z",
    );
  });

  it("crosses a DST boundary without shifting, because it is all UTC", () => {
    // Europe went back on 2026-10-25. A UTC schedule must not move.
    expect(iso(nextOccurrence("0 3 * * *", at("2026-10-25T02:00:00Z")))).toBe(
      "2026-10-25T03:00:00Z",
    );
  });

  it("intersects day-of-month and day-of-week rather than unioning them", () => {
    // Deliberately NOT Vixie cron's union rule (see the module doc). From
    // Monday the 3rd, "0 0 8,10 * 1" has a decoy: the 8th is a Saturday, which
    // matches day-of-month only and is what a union would fire on. The 10th is
    // the Monday that matches both. If this ever returns the 8th, the module
    // has silently switched to the standard reading.
    const next = nextOccurrence("0 0 8,10 * 1", at("2026-08-03T12:00:00Z"));
    expect(iso(next)).toBe("2026-08-10T00:00:00Z");
    expect(next!.getUTCDay()).toBe(1);
    expect(next!.getUTCDate()).toBe(10);
  });

  it("returns null rather than looping forever on an unsatisfiable date", () => {
    expect(nextOccurrence("0 0 30 2 *", at("2026-08-03T12:00:00Z"))).toBeNull();
  });

  // `nextOccurrence` collapses both of these to null, which is all its callers
  // need for a decoration. Health does need to tell them apart: "we could not
  // read this expression" is a fault worth an amber row, "it does not fire in
  // the next 8 days" is a perfectly healthy annual job.
  describe("nextFire distinguishes beyond-window from unsatisfiable", () => {
    const from = at("2026-08-03T12:00:00Z");

    it("names an exact instant inside the window", () => {
      expect(nextFire("*/30 * * * *", from)).toEqual({
        kind: "at",
        at: at("2026-08-03T12:30:00Z"),
      });
    });

    it("reports beyond-window for a satisfiable date past the scan", () => {
      // Annual, five months out.
      expect(nextFire("0 0 1 1 *", from)).toEqual({ kind: "beyond-window" });
      // Just past the 8-day edge, to pin the boundary rather than a far date.
      expect(nextFire("0 0 12 8 *", from)).toEqual({ kind: "beyond-window" });
      // …and one day inside it still resolves.
      expect(nextFire("0 0 11 8 *", from).kind).toBe("at");
    });

    it("reports unsatisfiable for a date that can never occur", () => {
      expect(nextFire("0 0 30 2 *", from)).toEqual({ kind: "unsatisfiable" });
      expect(nextFire("0 0 31 4 *", from)).toEqual({ kind: "unsatisfiable" }); // April 31
    });

    it("still throws on grammar it does not support", () => {
      expect(() => nextFire("*/5/2 * * * *", from)).toThrow();
      expect(() => nextFire("not a cron", from)).toThrow();
    });

    it("SCAN_WINDOW_MS is the window the scan actually covers", () => {
      expect(SCAN_WINDOW_MS).toBe(8 * 24 * 60 * 60 * 1000);
    });
  });

  it("resolves every schedule the worker actually registers", () => {
    // The guard that matters: if someone adds a cadence to JOB_CRON using
    // grammar this helper does not support, this fails instead of the account
    // page rendering a wrong or missing time in production.
    const from = at("2026-08-03T12:07:00Z");
    for (const [job, expression] of Object.entries(JOB_CRON)) {
      const next = nextOccurrence(expression, from);
      expect(next, `${job} (${expression}) did not resolve`).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(from.getTime());
    }
  });
});

describe("isJobType / cronFor", () => {
  it("accepts exactly the scheduled job types", () => {
    for (const job of Object.keys(JOB_CRON)) {
      expect(isJobType(job), job).toBe(true);
      expect(cronFor(job)).toBe(JOB_CRON[job as keyof typeof JOB_CRON]);
    }
  });

  it("rejects everything else, including inherited object keys", () => {
    // `Object.hasOwn`, not `in`: `JOB_CRON["toString"]` is a function, and an
    // `in` check would have let "toString" through both the re-run server
    // action's validation and the audit page's literal set.
    for (const bad of ["toString", "constructor", "__proto__", "", "ops-dead-letter"]) {
      expect(isJobType(bad), bad).toBe(false);
      expect(cronFor(bad), bad).toBeNull();
    }
    expect(isJobType(undefined)).toBe(false);
    expect(isJobType(null)).toBe(false);
    expect(isJobType(7)).toBe(false);
  });
});

describe("JOB_GROUP / groupFor", () => {
  it("assigns every scheduled job type to exactly one strip", () => {
    expect(Object.keys(JOB_GROUP).sort()).toEqual(Object.keys(JOB_CRON).sort());
  });

  it("groups the primary fan-out as sweep", () => {
    for (const job of ["membership", "contacts", "wanderer", "discord-roles"]) {
      expect(JOB_GROUP[job as keyof typeof JOB_GROUP], job).toBe("sweep");
      expect(groupFor(job)).toBe("sweep");
    }
  });

  it("groups membership-recheck as on-demand", () => {
    expect(JOB_GROUP["membership-recheck"]).toBe("on-demand");
    expect(groupFor("membership-recheck")).toBe("on-demand");
  });

  it("groups token-health and purge as housekeeping", () => {
    for (const job of ["token-health", "purge"]) {
      expect(JOB_GROUP[job as keyof typeof JOB_GROUP], job).toBe("housekeeping");
      expect(groupFor(job)).toBe("housekeeping");
    }
  });

  it("groups location as member-facing, not housekeeping", () => {
    // location is not reachable from any page control either, but its output
    // is the character location column on every member's /account page — a
    // row members actually read, unlike the other two housekeeping jobs.
    expect(JOB_GROUP.location).toBe("member-facing");
    expect(groupFor("location")).toBe("member-facing");
  });

  it("returns null for a job type nothing schedules", () => {
    expect(groupFor("zz-custom")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  JOB_CRON,
  cadenceFor,
  formatCadence,
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

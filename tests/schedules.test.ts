import { describe, expect, it } from "vitest";
import { JOB_CRON, cadenceFor, formatCadence } from "@/core/schedules";
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

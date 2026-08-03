import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, evaluateFreshness } from "@/core/health";

const now = new Date("2026-08-03T12:00:00Z");

describe("evaluateFreshness", () => {
  it("is fresh for a run 30 minutes old", () => {
    expect(evaluateFreshness(new Date("2026-08-03T11:30:00Z"), now)).toEqual({
      fresh: true,
      ageSec: 1800,
    });
  });

  it("is stale for a run 3 hours old", () => {
    expect(evaluateFreshness(new Date("2026-08-03T09:00:00Z"), now)).toEqual({
      fresh: false,
      ageSec: 10800,
    });
  });

  // Pins the comparison operator: exactly at the threshold counts as fresh, so
  // a job that runs precisely on schedule can never flap the check.
  it("treats exactly the threshold as fresh", () => {
    const at = new Date(now.getTime() - STALE_AFTER_MS);
    expect(evaluateFreshness(at, now)).toEqual({ fresh: true, ageSec: 5400 });
  });

  it("treats one millisecond past the threshold as stale", () => {
    const at = new Date(now.getTime() - STALE_AFTER_MS - 1);
    expect(evaluateFreshness(at, now).fresh).toBe(false);
  });

  // "The worker has never run" is the exact failure this endpoint exists to
  // catch, so no rows must not read as healthy.
  it("treats no rows as stale with a null age", () => {
    expect(evaluateFreshness(null, now)).toEqual({ fresh: false, ageSec: null });
  });

  it("honours an explicit threshold override", () => {
    const at = new Date(now.getTime() - 60_000);
    expect(evaluateFreshness(at, now, 30_000).fresh).toBe(false);
  });
});

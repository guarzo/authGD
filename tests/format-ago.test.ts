import { describe, expect, it } from "vitest";
import { elapsedShort, formatAgo } from "@/app/_components/format-ago";

const S = 1000;
const M = 60 * S;
const H = 60 * M;

describe("elapsedShort", () => {
  it("reports seconds below the 90s boundary", () => {
    expect(elapsedShort(0)).toBe("0s");
    expect(elapsedShort(1 * S)).toBe("1s");
    expect(elapsedShort(89 * S)).toBe("89s");
  });

  // Every boundary rounds rather than truncates, so the first minute-shaped
  // value is "2m", not "1m". Pinned because it looks like an off-by-one.
  it("switches to minutes at 90s, rounding", () => {
    expect(elapsedShort(90 * S)).toBe("2m");
    expect(elapsedShort(89 * M)).toBe("89m");
  });

  it("switches to hours at 90m, rounding", () => {
    expect(elapsedShort(90 * M)).toBe("2h");
    expect(elapsedShort(47 * H)).toBe("47h");
  });

  it("switches to days at 48h", () => {
    expect(elapsedShort(48 * H)).toBe("2d");
    expect(elapsedShort(10 * 24 * H)).toBe("10d");
  });

  // Clocks disagree: a row written by the worker can carry a timestamp a
  // second ahead of the page's `now`. "-1s ago" would be nonsense.
  it("clamps a negative elapsed to zero", () => {
    expect(elapsedShort(-5 * M)).toBe("0s");
  });
});

describe("formatAgo", () => {
  const now = Date.parse("2026-03-01T04:00:00.000Z");

  // The behaviour that changed in this branch: a scheduled job that has never
  // run now has a row, and "running" made it announce itself as in flight.
  it("renders a null timestamp as never, not running", () => {
    expect(formatAgo(null, now)).toBe("never");
  });

  it("suffixes the elapsed string with ' ago'", () => {
    expect(formatAgo("2026-03-01T03:56:00.000Z", now)).toBe("4m ago");
    expect(formatAgo("2026-03-01T03:59:30.000Z", now)).toBe("30s ago");
    expect(formatAgo("2026-02-27T04:00:00.000Z", now)).toBe("2d ago");
  });
});

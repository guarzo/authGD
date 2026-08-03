import { describe, expect, it } from "vitest";
import {
  type RunLike,
  countColumns,
  formatDuration,
  humanizeKey,
  isNoChange,
} from "@/core/run-summary";

function run(counts: Record<string, number> | null): RunLike {
  return { startedAt: null, finishedAt: null, counts };
}

describe("countColumns", () => {
  it("gives a column only to counters that moved somewhere in the window", () => {
    const cols = countColumns("token-health", [
      run({ refreshed: 41, invalid: 0, needsReauth: 0, unlinked: 0, skipped: 0 }),
      run({ refreshed: 38, invalid: 0, needsReauth: 2, unlinked: 0, skipped: 0 }),
    ]);
    // invalid/unlinked/skipped are zero on every run: no column, same reasoning
    // that removed the permanently-empty error column.
    expect(cols).toEqual(["refreshed", "needsReauth"]);
  });

  it("returns nothing when the whole window is quiet", () => {
    expect(countColumns("purge", [run({ sessions: 0, outbox: 0 }), run(null)])).toEqual(
      [],
    );
  });

  it("orders by the job's preferred order, then unknown keys alphabetically", () => {
    const cols = countColumns("membership", [
      run({ zzz: 1, demoted: 2, checked: 9, aaa: 1, promoted: 1 }),
    ]);
    expect(cols).toEqual(["checked", "promoted", "demoted", "aaa", "zzz"]);
  });

  it("keeps dry-run and live variants apart instead of merging them", () => {
    // wanderer renames its counters under SYNC_MODE=dry; a window spanning a
    // mode change must show both rather than silently dropping one.
    const cols = countColumns("wanderer", [
      run({ added: 3, removed: 0, addFailed: 0 }),
      run({ wouldAdd: 5, wouldRemove: 0, addFailed: 0 }),
    ]);
    expect(cols).toEqual(["added", "wouldAdd"]);
  });

  it("gives an unlisted job type columns for whatever it emits", () => {
    expect(countColumns("zz-custom", [run({ b: 1, a: 2, c: 0 })])).toEqual(["a", "b"]);
  });
});

describe("isNoChange", () => {
  it("is true only for a recorded, entirely zero result", () => {
    expect(isNoChange({ a: 0, b: 0 })).toBe(true);
    expect(isNoChange({ a: 0, b: 1 })).toBe(false);
    expect(isNoChange({})).toBe(false); // nothing recorded is not "no change"
    expect(isNoChange(null)).toBe(false); // still running
  });
});

describe("humanizeKey", () => {
  it("splits camelCase into words", () => {
    expect(humanizeKey("needsReauth")).toBe("needs reauth");
    expect(humanizeKey("wouldChangeRoles")).toBe("would change roles");
    expect(humanizeKey("oauthTransactions")).toBe("oauth transactions");
    expect(humanizeKey("added")).toBe("added");
  });
});

describe("formatDuration", () => {
  const t = (ms: number) => new Date(1_700_000_000_000 + ms);

  it("scales precision across the range these jobs span", () => {
    expect(formatDuration(t(0), t(420))).toBe("420ms");
    expect(formatDuration(t(0), t(1200))).toBe("1.2s");
    expect(formatDuration(t(0), t(42_000))).toBe("42s");
    expect(formatDuration(t(0), t(200_000))).toBe("3m 20s");
    expect(formatDuration(t(0), t(3_840_000))).toBe("1h 4m");
  });

  it("is null for a run still in flight or with an impossible clock", () => {
    expect(formatDuration(t(0), null)).toBeNull();
    expect(formatDuration(null, t(0))).toBeNull();
    expect(formatDuration(t(500), t(0))).toBeNull();
  });
});

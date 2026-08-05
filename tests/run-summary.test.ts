import { describe, expect, it } from "vitest";
import {
  type CollapsibleRun,
  type RunLike,
  collapseRuns,
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

  it("does not let a rounded remainder carry past its own unit", () => {
    expect(formatDuration(t(0), t(59_600))).toBe("1m 0s");
    expect(formatDuration(t(0), t(359_600))).toBe("6m 0s");
    expect(formatDuration(t(0), t(3_599_600))).toBe("1h 0m");
  });
});

describe("collapseRuns", () => {
  const t = (ms: number) => new Date(1_700_000_000_000 + ms);

  function run(
    id: number,
    opts: {
      status?: "ok" | "partial" | "failed" | null;
      counts?: Record<string, number> | null;
      errorSummary?: string | null;
      startedAt?: Date | null;
      finishedAt?: Date | null;
    } = {},
  ): CollapsibleRun {
    const {
      status = "ok",
      counts = { checked: 19 },
      errorSummary = null,
      startedAt = t(id * 1000),
      finishedAt = t(id * 1000 + 500),
    } = opts;
    return { id, status, counts, errorSummary, startedAt, finishedAt };
  }

  it("returns a single run as its own entry, not a one-element group", () => {
    const groups = collapseRuns([run(1)]);
    expect(groups).toEqual([{ kind: "run", run: run(1) }]);
  });

  it("collapses a run of all-identical runs into one group", () => {
    const runs = [run(3), run(2), run(1)]; // newest-first, as getSyncStatus hands back
    const groups = collapseRuns(runs);
    expect(groups).toEqual([
      {
        kind: "group",
        runs,
        count: 3,
        status: "ok",
        counts: { checked: 19 },
        errorSummary: null,
        from: run(1).startedAt,
        to: run(3).finishedAt,
        durationMs: { min: 500, max: 500 },
      },
    ]);
  });

  it("breaks the group on a status or counts change and does not merge across the gap", () => {
    const runs = [
      run(4, { counts: { checked: 20 } }),
      run(3),
      run(2),
      run(1, { status: "failed", counts: null }),
    ];
    const groups = collapseRuns(runs);
    expect(groups).toEqual([
      { kind: "run", run: runs[0] },
      {
        kind: "group",
        runs: [runs[1], runs[2]],
        count: 2,
        status: "ok",
        counts: { checked: 19 },
        errorSummary: null,
        from: runs[2].startedAt,
        to: runs[1].finishedAt,
        durationMs: { min: 500, max: 500 },
      },
      { kind: "run", run: runs[3] },
    ]);
  });

  it("alternates back and forth without ever merging non-adjacent matching runs", () => {
    // ok, failed, ok, failed — every neighbour differs, so nothing collapses
    // even though the odd-indexed and even-indexed runs match each other.
    const runs = [
      run(4, { status: "failed" }),
      run(3),
      run(2, { status: "failed" }),
      run(1),
    ];
    const groups = collapseRuns(runs);
    expect(groups).toEqual(runs.map((r) => ({ kind: "run", run: r })));
  });

  it("never collapses a still-running run into a finished one, in either position", () => {
    const inFlight = run(3, { finishedAt: null, status: null });
    const groups = collapseRuns([inFlight, run(2), run(1)]);
    expect(groups).toEqual([
      { kind: "run", run: inFlight },
      {
        kind: "group",
        runs: [run(2), run(1)],
        count: 2,
        status: "ok",
        counts: { checked: 19 },
        errorSummary: null,
        from: run(1).startedAt,
        to: run(2).finishedAt,
        durationMs: { min: 500, max: 500 },
      },
    ]);
  });

  it("never collapses two still-running runs together, even with identical fields", () => {
    const a = run(2, { finishedAt: null, status: null });
    const b = run(1, { finishedAt: null, status: null });
    expect(collapseRuns([a, b])).toEqual([
      { kind: "run", run: a },
      { kind: "run", run: b },
    ]);
  });

  it("treats no recorded counts as different from all-zero counts", () => {
    const groups = collapseRuns([run(2, { counts: null }), run(1, { counts: null })]);
    expect(groups).toEqual([
      {
        kind: "group",
        runs: [run(2, { counts: null }), run(1, { counts: null })],
        count: 2,
        status: "ok",
        counts: null,
        errorSummary: null,
        from: run(1).startedAt,
        to: run(2).finishedAt,
        durationMs: { min: 500, max: 500 },
      },
    ]);
    // null counts and {} are not the same fact.
    expect(collapseRuns([run(2, { counts: null }), run(1, { counts: {} })])).toEqual([
      { kind: "run", run: run(2, { counts: null }) },
      { kind: "run", run: run(1, { counts: {} }) },
    ]);
  });

  it("does not collapse runs whose error text differs, even with matching status and counts", () => {
    // contacts.ts/wanderer.ts/discord-roles.ts build errorSummary from
    // per-target error lines that `counts` never reflects: two `partial` runs
    // can both show `failed: 1` while a different target failed for a
    // different reason each time. Merging would silently hide the second
    // run's diagnostics behind the first's.
    const runs = [
      run(2, {
        status: "partial",
        counts: { failed: 1 },
        errorSummary: "acc-2: timeout",
      }),
      run(1, {
        status: "partial",
        counts: { failed: 1 },
        errorSummary: "acc-9: revoked scope",
      }),
    ];
    expect(collapseRuns(runs)).toEqual([
      { kind: "run", run: runs[0] },
      { kind: "run", run: runs[1] },
    ]);
  });

  it("returns an empty array for no runs", () => {
    expect(collapseRuns([] as CollapsibleRun[])).toEqual([]);
  });

  it("carries the min/max run duration through a group instead of dropping the time axis", () => {
    // Five hourly runs, all OK with identical counts, would otherwise collapse
    // to one row indistinguishable from a healthy run — even though one of
    // them took far longer than the rest (e.g. ESI degraded mid-sync).
    const runs = [
      run(3, { startedAt: t(2000), finishedAt: t(2 * 60_000) }), // 118s
      run(2, { startedAt: t(1000), finishedAt: t(1500) }), // 500ms
      run(1, { startedAt: t(0), finishedAt: t(300) }), // 300ms
    ];
    const groups = collapseRuns(runs);
    expect(groups).toEqual([
      expect.objectContaining({
        kind: "group",
        durationMs: { min: 300, max: 118_000 },
      }),
    ]);
  });

  it("leaves the duration span null when no run in the group recorded a startedAt", () => {
    const runs = [run(2, { startedAt: null }), run(1, { startedAt: null })];
    const groups = collapseRuns(runs);
    expect(groups).toEqual([
      expect.objectContaining({
        kind: "group",
        durationMs: null,
      }),
    ]);
  });

  it("ignores runs with no startedAt when others in the same group have one", () => {
    const runs = [
      run(2, { startedAt: null }),
      run(1, { startedAt: t(0), finishedAt: t(700) }),
    ];
    const groups = collapseRuns(runs);
    expect(groups).toEqual([
      expect.objectContaining({ kind: "group", durationMs: { min: 700, max: 700 } }),
    ]);
  });

  it("ignores a member whose finishedAt precedes its startedAt", () => {
    // A clock adjustment between the two writes can invert the pair. Counting
    // it would report a negative minimum for a group that stands in for
    // several runs that did happen — the single-run path already refuses this
    // via formatDuration's `ms < 0` guard.
    const runs = [
      run(2, { startedAt: t(5000), finishedAt: t(4000) }),
      run(1, { startedAt: t(0), finishedAt: t(700) }),
    ];
    expect(collapseRuns(runs)).toEqual([
      expect.objectContaining({ kind: "group", durationMs: { min: 700, max: 700 } }),
    ]);
  });

  it("leaves the span null when every member's pair is invalid", () => {
    const runs = [
      run(2, { startedAt: t(5000), finishedAt: t(4000) }),
      run(1, { startedAt: new Date(NaN) }),
    ];
    expect(collapseRuns(runs)).toEqual([
      expect.objectContaining({ kind: "group", durationMs: null }),
    ]);
  });
});

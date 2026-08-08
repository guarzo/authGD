import { describe, expect, it } from "vitest";
import { JOB_CRON } from "@/core/schedules";
import type { RowHealth } from "@/core/run-health";
import { collapseRuns, type CollapsibleRun } from "@/core/run-summary";
import {
  cadenceNamesTime,
  evidenceSince,
  type GroupMember,
  groupHealthSummary,
  groupNeedsAttention,
  groupTone,
  healthLabel,
  HEALTH_LABEL,
  HEALTH_TONE,
  needsAttention,
  nextRunFor,
  queuedMarkerStuck,
  queuedMarkerText,
  queuedNotice,
  queuedStamp,
  splitCadenceUtc,
  tone,
  windowRestatesGroup,
} from "@/app/admin/sync/view";

const MIN = 60 * 1000;
const NOON = new Date("2026-08-03T12:07:00.000Z");

function at(ms: number): Date {
  return new Date(NOON.getTime() + ms);
}

/**
 * Every member of the union, listed by hand. `Object.keys(HEALTH_TONE)` would
 * be circular — it would pass for a map missing exactly the member the type
 * gained — so this list is the independent statement of what exists, and the
 * `Record<RowHealth, …>` typing makes forgetting to extend it a compile error
 * in the maps rather than a silent gap here.
 */
const ALL_HEALTH: RowHealth[] = [
  "fresh",
  "degraded",
  "failing",
  "inflight",
  "stuck",
  "overdue",
  "missing",
  "never",
  "unknown",
];

describe("tone", () => {
  it("maps a recorded run status, treating in-flight as neutral not warn", () => {
    expect(tone("ok")).toBe("ok");
    expect(tone("partial")).toBe("warn");
    expect(tone("failed")).toBe("bad");
    expect(tone(null)).toBe("neutral");
  });
});

describe("health presentation", () => {
  it("covers every RowHealth member in both maps", () => {
    for (const h of ALL_HEALTH) {
      expect(HEALTH_TONE[h], h).toBeTruthy();
      expect(healthLabel(h), h).toBeTruthy();
    }
    expect(Object.keys(HEALTH_TONE).sort()).toEqual([...ALL_HEALTH].sort());
    expect(Object.keys(HEALTH_LABEL).sort()).toEqual([...ALL_HEALTH].sort());
  });

  it("gives every health a distinct label, so colour is never the only carrier", () => {
    const labels = ALL_HEALTH.map(healthLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("reserves the alarm colour for a reported failure", () => {
    // overdue/stuck/missing are schedule facts, not reported faults: nothing
    // has said it failed, it just has not run.
    expect(HEALTH_TONE.failing).toBe("bad");
    for (const h of ["overdue", "stuck", "missing", "unknown"] as const) {
      expect(HEALTH_TONE[h], h).toBe("warn");
    }
    expect(HEALTH_TONE.never).toBe("off");
    expect(HEALTH_TONE.fresh).toBe("ok");
  });

  it("auto-opens only the rows one admin can act on", () => {
    expect(ALL_HEALTH.filter(needsAttention).sort()).toEqual([
      "degraded",
      "failing",
      "missing",
      "stuck",
    ]);
    // overdue in particular must stay shut: a dead worker puts EVERY row there
    // at once, and opening all seven drawers destroys the "this one job needs
    // you" signal auto-open exists to create.
    expect(needsAttention("overdue")).toBe(false);
    expect(needsAttention("inflight")).toBe(false);
  });
});

describe("cadenceNamesTime", () => {
  it("is true exactly when the cadence string already prints a wall clock", () => {
    expect(cadenceNamesTime("0 3 * * *")).toBe(true); // daily 03:00 UTC
    expect(cadenceNamesTime("0 4 * * 0")).toBe(true); // Sun 04:00 UTC
    expect(cadenceNamesTime("*/30 * * * *")).toBe(false); // every 30m
    expect(cadenceNamesTime("5 * * * *")).toBe(false); // hourly :05
  });

  it("does not fall over on a malformed expression", () => {
    expect(cadenceNamesTime("")).toBe(false);
    expect(cadenceNamesTime("0")).toBe(false);
    expect(cadenceNamesTime("   0   3   * * *  ")).toBe(true);
  });
});

describe("nextRunFor", () => {
  it("suppresses the decoration when the cadence already names the time", () => {
    // Printing "next 03:00" under "daily 03:00 UTC" is the same number twice.
    expect(nextRunFor("token-health", NOON)).toBeNull();
    expect(nextRunFor("purge", NOON)).toBeNull();
    expect(nextRunFor("membership-recheck", NOON)).toBeNull();
  });

  it("gives the next fire for a cadence that does not", () => {
    expect(nextRunFor("membership", NOON)).toEqual(new Date("2026-08-03T12:30:00.000Z"));
    expect(nextRunFor("contacts", NOON)).toEqual(new Date("2026-08-03T13:05:00.000Z"));
  });

  it("degrades to null for a job type nothing schedules", () => {
    // A row for a retired or hand-queued job type still has to render.
    expect(nextRunFor("ops-dead-letter", NOON)).toBeNull();
    expect(nextRunFor("", NOON)).toBeNull();
    expect(nextRunFor("toString", NOON)).toBeNull();
  });
});

describe("queuedStamp", () => {
  it("prints the enqueue instant in the page's own UTC register", () => {
    expect(queuedStamp("1785240432000")).toBe("12:07:12.000 UTC");
  });

  it("refuses anything that is not a plain millisecond count", () => {
    // A 20-digit paste must not reach copy as "Invalid Date UTC".
    for (const bad of [undefined, "", " 1", "1.5", "1e9", "-1", "99999999999999999999"]) {
      expect(queuedStamp(bad), String(bad)).toBeNull();
    }
  });

  /**
   * The values that pass the digit check and the NaN check and still have no
   * clock in them. `new Date(999999999999999).toISOString()` is
   * `+033658-09-27T01:46:39.999Z` — three characters wider than the usual
   * form, because the year field goes from four digits to seven, so the fixed
   * slice lands on `27T01:46:39` and renders it as a time of day.
   */
  it("refuses an instant so far out that ISO switches to extended years", () => {
    for (const bad of ["999999999999999", "253402300800000"]) {
      expect(queuedStamp(bad), bad).toBeNull();
    }
    // The boundary itself still works: the last millisecond of year 9999.
    expect(queuedStamp("253402300799999")).toBe("23:59:59.999 UTC");
  });
});

describe("queuedNotice", () => {
  // Most of these tests don't care about the worker's age, only about the
  // rest of the notice — an arbitrary, non-null age keeps them from having to
  // reason about the null branch (`queuedMarkerText` below covers that case).
  const AGE = "5m";

  // Every call below passes `false` for the new `heartbeatErrored` param —
  // none of these cases are about that state; `says the heartbeat check
  // itself failed...` below is the one that is.
  it("names the job for a per-row re-run", () => {
    expect(queuedNotice("wanderer", undefined, AGE, false)).toMatch(/^wanderer queued\./);
  });

  it("has copy for the two fan-out buttons", () => {
    expect(queuedNotice("all", undefined, AGE, false)).toMatch(/every account/);
    expect(queuedNotice("recheck", undefined, AGE, false)).toMatch(
      /^Affiliation recheck queued\./,
    );
  });

  /**
   * The fan-out's four nouns have to be the strip's own row names. `map` was
   * not one of them — the row is called `wanderer` — so the one noun that
   * needed translating was the only one that got translated, and an admin had
   * to diff four nouns against seven rows to learn what was excluded.
   */
  it("names the fan-out's jobs the way the strip names them", () => {
    const all = queuedNotice("all", undefined, AGE, false);
    for (const job of ["membership", "contacts", "wanderer", "discord-roles"]) {
      expect(all, job).toContain(job);
    }
    expect(all).not.toMatch(/\bmap\b/);
  });

  /**
   * The notice lives in a permanently-mounted `role="status"` region, and a
   * live region announces a *mutation*. Two presses of one button produced a
   * byte-identical string, so React wrote nothing and the second enqueue —
   * which really did happen — was silent.
   */
  it("differs between two presses of the same button", () => {
    const first = queuedNotice("wanderer", "1785240432000", AGE, false);
    const second = queuedNotice("wanderer", "1785240471000", AGE, false);
    expect(first).not.toBe(second);
    expect(first).toContain("12:07:12.000 UTC");
    expect(second).toContain("12:07:51.000 UTC");
  });

  /**
   * And two presses inside one second, which is the interval that actually
   * occurs. `Submit` is deliberately not disabled while its form is in flight,
   * so the second press lands the moment the first round-trip returns — under
   * a second on localhost. A stamp cut at whole seconds would leave exactly
   * this case silent, which is the case the stamp exists for.
   */
  it("differs between two presses inside the same second", () => {
    expect(queuedNotice("wanderer", "1785240432120", AGE, false)).not.toBe(
      queuedNotice("wanderer", "1785240432880", AGE, false),
    );
  });

  it("drops the instant rather than echoing a hand-typed one", () => {
    // Same posture as `queued` itself: untrusted input reaching copy.
    for (const bad of [undefined, "", "now", "-1", "1e9", "99999999999999999999"]) {
      expect(queuedNotice("wanderer", bad, AGE, false), String(bad)).toBe(
        queuedNotice("wanderer", undefined, AGE, false),
      );
    }
  });

  it("points at the browser reload, not at a control off the bottom of the page", () => {
    for (const q of ["all", "recheck", ...Object.keys(JOB_CRON)]) {
      expect(queuedNotice(q, undefined, AGE, false), q).toMatch(/reload this page/);
      expect(queuedNotice(q, undefined, AGE, false), q).not.toMatch(/use Refresh/);
    }
  });

  it("says nothing about a hand-typed query flag", () => {
    // `?queued=` is untrusted input reaching copy, not a lookup that fails safe
    // on its own.
    expect(queuedNotice(undefined, undefined, AGE, false)).toBe("");
    expect(queuedNotice("", undefined, AGE, false)).toBe("");
    expect(queuedNotice("<script>alert(1)</script>", undefined, AGE, false)).toBe("");
    expect(queuedNotice("ops-dead-letter", undefined, AGE, false)).toBe("");
    expect(queuedNotice("toString", undefined, AGE, false)).toBe("");
  });

  it("promises enqueue, never execution, for every accepted value", () => {
    for (const q of ["all", "recheck", ...Object.keys(JOB_CRON)]) {
      expect(queuedNotice(q, undefined, AGE, false), q).toMatch(/queued/);
      expect(queuedNotice(q, undefined, AGE, false), q).toMatch(/worker last checked in/);
    }
  });

  /**
   * The age is the whole differentiator now, so the notice needs no separate
   * fresh/stale strings and no second threshold constant of its own — a
   * worker that checked in 5m ago and one that checked in 89m ago both get
   * the same shape of sentence, honestly aged.
   */
  it("states the worker's age rather than a freshness verdict", () => {
    expect(queuedNotice("wanderer", undefined, "5m", false)).toMatch(
      /The worker last checked in 5m ago/,
    );
    expect(queuedNotice("wanderer", undefined, "89m", false)).toMatch(
      /The worker last checked in 89m ago/,
    );
  });

  /**
   * `workerAge === null` is a third state the old boolean collapsed into "not
   * running": a fresh deploy, or a database no worker has ever started
   * against, has no evidence either way, and asserting the worker is down
   * would be a claim from the absence of evidence, not from a check.
   */
  it("says no heartbeat is recorded yet rather than asserting the worker is down", () => {
    const notice = queuedNotice("wanderer", undefined, null, false);
    expect(notice).toMatch(/no heartbeat has been recorded yet/i);
    expect(notice).not.toMatch(/not running/);
  });

  /**
   * `heartbeatErrored` is a fourth state, distinct from both "fresh" and "no
   * heartbeat recorded yet": a failed READ says nothing about the worker's
   * history at all, so neither existing sentence is honest here — and it
   * takes priority over `workerAge` (which is always null when the read
   * itself failed, same shape as "never", but a different claim).
   */
  it("says the heartbeat check itself failed rather than asserting no heartbeat is recorded", () => {
    const notice = queuedNotice("wanderer", undefined, null, true);
    expect(notice).toMatch(/could not be checked/i);
    expect(notice).not.toMatch(/no heartbeat has been recorded yet/i);
    expect(notice).not.toMatch(/not running/);
  });
});

describe("evidenceSince", () => {
  const group = (...startedAt: Array<Date | null>) => ({
    runs: startedAt.map((s) => ({ startedAt: s })),
  });

  it("is the oldest start across every group", () => {
    expect(
      evidenceSince(true, [group(at(-5 * MIN), at(-40 * MIN)), group(at(-90 * MIN))]),
    ).toEqual(at(-90 * MIN));
  });

  it("is null when the worker is not fresh, however much history there is", () => {
    // Otherwise a dead worker flips every never-run row to `missing` at once —
    // a page-level condition the worker line above the strip already reports.
    expect(evidenceSince(false, [group(at(-90 * MIN))])).toBeNull();
  });

  it("is null when nothing has ever run", () => {
    expect(evidenceSince(true, [])).toBeNull();
    expect(evidenceSince(true, [group(), group(null)])).toBeNull();
  });
});

describe("queuedMarkerText", () => {
  it("stays a bare marker under the notable threshold, matching a healthy dispatcher's ~2s poll", () => {
    expect(queuedMarkerText(at(-1000), NOON)).toBe(", queued");
    expect(queuedMarkerText(at(-119_000), NOON)).toBe(", queued");
    // The boundary itself is inclusive of the age-bearing branch: exactly
    // QUEUED_AGE_NOTABLE_MS is no longer the routine enqueue-to-poll gap.
    expect(queuedMarkerText(at(-2 * MIN), NOON)).toBe(", queued 2m ago");
  });

  it("states the age past the notable threshold", () => {
    expect(queuedMarkerText(at(-5 * MIN), NOON)).toBe(", queued 5m ago");
  });

  it("keeps stating the age, not a second escalated string, past the stuck threshold", () => {
    // `queuedMarkerStuck` is what escalates the mark's own shape; the text
    // itself has only one shape for every age past the notable threshold.
    expect(queuedMarkerText(at(-20 * MIN), NOON)).toBe(", queued 20m ago");
  });

  it("still says queued when the age is unknown", () => {
    // A null age means the row is queued but `undispatchedSummary` could not
    // date it. The marker must survive that: dropping it would make a job with
    // work waiting read as idle, which is worse than losing the "5m ago".
    expect(queuedMarkerText(null, NOON)).toBe(", queued");
  });
});

describe("queuedMarkerStuck", () => {
  it("is false under the stuck threshold, however notable the age already is", () => {
    expect(queuedMarkerStuck(at(-5 * MIN), NOON)).toBe(false);
    expect(queuedMarkerStuck(at(-14 * MIN), NOON)).toBe(false);
  });

  it("is true past the stuck threshold", () => {
    // Ten times the notable threshold: the dispatcher polls every ~2s, so 15
    // minutes of an undispatched row is not "running behind", it is wedged —
    // `startDispatcher` swallows a dispatch failure into `console.error` and
    // retries forever rather than surfacing it anywhere else.
    expect(queuedMarkerStuck(at(-15 * MIN), NOON)).toBe(true);
    expect(queuedMarkerStuck(at(-60 * MIN), NOON)).toBe(true);
  });

  it("never escalates on an unknown age", () => {
    // Escalation is a claim about how long something has waited; a null age
    // cannot support one, however long the row has actually been there.
    expect(queuedMarkerStuck(null, NOON)).toBe(false);
  });
});

describe("housekeeping's group-level decisions", () => {
  const member = (jobType: string, health: RowHealth): GroupMember => ({
    jobType,
    health,
  });

  describe("groupNeedsAttention", () => {
    it("is false when every member is clean", () => {
      expect(
        groupNeedsAttention([member("token-health", "never"), member("purge", "fresh")]),
      ).toBe(false);
    });

    it("is true the moment one member needs attention, regardless of position", () => {
      expect(
        groupNeedsAttention([
          member("token-health", "failing"),
          member("purge", "fresh"),
        ]),
      ).toBe(true);
      expect(
        groupNeedsAttention([
          member("token-health", "never"),
          member("purge", "missing"),
        ]),
      ).toBe(true);
    });

    it("agrees with needsAttention on every health, so a group can never open on a health its own row would not", () => {
      for (const h of ALL_HEALTH) {
        expect(groupNeedsAttention([member("x", h)]), h).toBe(needsAttention(h));
      }
    });
  });

  describe("groupTone", () => {
    it("is ok when nothing in the group ranks warn or bad", () => {
      expect(groupTone([member("token-health", "never"), member("purge", "fresh")])).toBe(
        "ok",
      );
    });

    it("takes the worst tone across members, bad outranking warn", () => {
      expect(
        groupTone([member("token-health", "overdue"), member("purge", "fresh")]),
      ).toBe("warn");
      expect(
        groupTone([member("token-health", "overdue"), member("purge", "failing")]),
      ).toBe("bad");
    });

    it("does not claim green for a group where nothing has ever succeeded", () => {
      // A fresh deployment: neither housekeeping job has run. Green here would
      // assert success for two jobs with no successful run between them.
      expect(groupTone([member("token-health", "never"), member("purge", "never")])).toBe(
        "off",
      );
      expect(
        groupTone([member("token-health", "never"), member("purge", "inflight")]),
      ).toBe("off");
      expect(
        groupTone([member("token-health", "inflight"), member("purge", "inflight")]),
      ).toBe("neutral");
    });
  });

  describe("groupHealthSummary", () => {
    it("states a settled word rather than a bare count when the group is clean", () => {
      expect(
        groupHealthSummary([member("token-health", "never"), member("purge", "fresh")]),
      ).toBe("2 jobs · nothing needs attention");
    });

    it("singularizes the count for a group of one", () => {
      expect(groupHealthSummary([member("purge", "fresh")])).toBe(
        "1 job · nothing needs attention",
      );
    });

    it("names every flagged member and its own health word, not just that something is wrong", () => {
      expect(
        groupHealthSummary([
          member("token-health", "failing"),
          member("purge", "missing"),
        ]),
      ).toBe("2 jobs · token-health failed, purge not running");
    });

    it("leaves a clean member out of the flagged list entirely", () => {
      const summary = groupHealthSummary([
        member("token-health", "failing"),
        member("purge", "fresh"),
      ]);
      expect(summary).toContain("token-health failed");
      expect(summary).not.toContain("purge");
    });

    it("never says nothing is wrong beside a tone that says otherwise", () => {
      // `overdue` and `unknown` are warn but deliberately do not auto-open, so
      // the sentence has to be driven by the tone table rather than the
      // auto-open one — otherwise the line reads "nothing needs attention"
      // under an amber dot, on a group that stays folded.
      for (const health of ["overdue", "unknown"] as const) {
        const members = [member("purge", health), member("token-health", "fresh")];
        expect(groupTone(members), health).toBe("warn");
        expect(groupHealthSummary(members), health).not.toContain(
          "nothing needs attention",
        );
        expect(groupHealthSummary(members), health).toContain("purge");
      }
    });

    it("agrees with its own tone for every health a member can hold", () => {
      for (const health of ALL_HEALTH) {
        const members = [member("purge", health)];
        const settled = groupHealthSummary(members).includes("nothing needs attention");
        const faulted = ["bad", "warn"].includes(groupTone(members));
        expect(settled, health).toBe(!faulted);
      }
    });
  });
});

describe("windowRestatesGroup", () => {
  const run = (overrides: Partial<CollapsibleRun> = {}): CollapsibleRun => ({
    id: overrides.id ?? Math.random(),
    startedAt: at(-10 * MIN),
    finishedAt: at(-9 * MIN),
    status: "ok",
    counts: null,
    errorSummary: null,
    ...overrides,
  });

  it("is true when every run in the window collapsed into one group", () => {
    const collapsed = collapseRuns([run(), run(), run()]);
    expect(collapsed).toHaveLength(1);
    expect(windowRestatesGroup(collapsed)).toBe(true);
  });

  it("is false for a single run, which collapseRuns never turns into a group of one", () => {
    const collapsed = collapseRuns([run()]);
    expect(windowRestatesGroup(collapsed)).toBe(false);
  });

  it("is false when an in-flight run sits above a collapsed group", () => {
    const collapsed = collapseRuns([
      run({ id: 1, status: null, finishedAt: null }),
      run({ id: 2 }),
      run({ id: 3 }),
    ]);
    expect(collapsed.length).toBeGreaterThan(1);
    expect(windowRestatesGroup(collapsed)).toBe(false);
  });

  it("is false when two groups of different outcomes both appear", () => {
    const collapsed = collapseRuns([
      run({ id: 1, status: "failed" }),
      run({ id: 2, status: "ok" }),
      run({ id: 3, status: "ok" }),
    ]);
    expect(collapsed.length).toBeGreaterThan(1);
    expect(windowRestatesGroup(collapsed)).toBe(false);
  });

  it("is false for an empty window", () => {
    expect(windowRestatesGroup(collapseRuns([]))).toBe(false);
  });
});

describe("splitCadenceUtc", () => {
  it("splits the trailing wall-clock clause off, marking it hidden rather than dropped", () => {
    expect(splitCadenceUtc("daily 03:00 UTC")).toEqual({
      visible: "daily 03:00",
      hiddenUtc: true,
    });
    expect(splitCadenceUtc("Sun 04:00 UTC")).toEqual({
      visible: "Sun 04:00",
      hiddenUtc: true,
    });
  });

  it("is a no-op for an interval cadence, which never carries the suffix", () => {
    expect(splitCadenceUtc("every 30m")).toEqual({
      visible: "every 30m",
      hiddenUtc: false,
    });
    expect(splitCadenceUtc("hourly :05")).toEqual({
      visible: "hourly :05",
      hiddenUtc: false,
    });
  });

  it("is a no-op for the on-demand fallback string", () => {
    expect(splitCadenceUtc("on demand")).toEqual({
      visible: "on demand",
      hiddenUtc: false,
    });
  });
});

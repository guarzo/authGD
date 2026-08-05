import { describe, expect, it } from "vitest";
import { JOB_CRON } from "@/core/schedules";
import type { RowHealth } from "@/core/run-health";
import {
  cadenceNamesTime,
  evidenceSince,
  healthLabel,
  HEALTH_LABEL,
  HEALTH_TONE,
  needsAttention,
  nextRunFor,
  queuedNotice,
  queuedStamp,
  tone,
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
  it("names the job for a per-row re-run", () => {
    expect(queuedNotice("wanderer")).toMatch(/^wanderer queued\./);
  });

  it("has copy for the two fan-out buttons", () => {
    expect(queuedNotice("all")).toMatch(/every account/);
    expect(queuedNotice("recheck")).toMatch(/^Affiliation recheck queued\./);
  });

  /**
   * The fan-out's four nouns have to be the strip's own row names. `map` was
   * not one of them — the row is called `wanderer` — so the one noun that
   * needed translating was the only one that got translated, and an admin had
   * to diff four nouns against seven rows to learn what was excluded.
   */
  it("names the fan-out's jobs the way the strip names them", () => {
    const all = queuedNotice("all");
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
    const first = queuedNotice("wanderer", "1785240432000");
    const second = queuedNotice("wanderer", "1785240471000");
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
    expect(queuedNotice("wanderer", "1785240432120")).not.toBe(
      queuedNotice("wanderer", "1785240432880"),
    );
  });

  it("drops the instant rather than echoing a hand-typed one", () => {
    // Same posture as `queued` itself: untrusted input reaching copy.
    for (const bad of [undefined, "", "now", "-1", "1e9", "99999999999999999999"]) {
      expect(queuedNotice("wanderer", bad), String(bad)).toBe(queuedNotice("wanderer"));
    }
  });

  it("points at the browser reload, not at a control off the bottom of the page", () => {
    for (const q of ["all", "recheck", ...Object.keys(JOB_CRON)]) {
      expect(queuedNotice(q), q).toMatch(/reload this page/);
      expect(queuedNotice(q), q).not.toMatch(/use Refresh/);
    }
  });

  it("says nothing about a hand-typed query flag", () => {
    // `?queued=` is untrusted input reaching copy, not a lookup that fails safe
    // on its own.
    expect(queuedNotice(undefined)).toBe("");
    expect(queuedNotice("")).toBe("");
    expect(queuedNotice("<script>alert(1)</script>")).toBe("");
    expect(queuedNotice("ops-dead-letter")).toBe("");
    expect(queuedNotice("toString")).toBe("");
  });

  it("promises enqueue, never execution, for every accepted value", () => {
    for (const q of ["all", "recheck", ...Object.keys(JOB_CRON)]) {
      expect(queuedNotice(q), q).toMatch(/queued/);
      expect(queuedNotice(q), q).toMatch(/worker picks/);
    }
  });

  it("says 'them' for the four-job fan-out and 'it' for every single-job case", () => {
    // A regex loose enough to match either pronoun is how the wrong one slips
    // through: "all" names four jobs and must read "picks them up"; every
    // other accepted value names one and must read "picks it up".
    expect(queuedNotice("all")).toMatch(/worker picks them up/);
    expect(queuedNotice("all")).not.toMatch(/worker picks it up/);
    for (const q of ["recheck", ...Object.keys(JOB_CRON)]) {
      expect(queuedNotice(q), q).toMatch(/worker picks it up/);
      expect(queuedNotice(q), q).not.toMatch(/worker picks them up/);
    }
  });

  /**
   * The "within a few seconds" promise is only true while the worker is
   * actually running. A dead worker is exactly the state `worker.fresh`
   * reports, and the notice has to stop making a promise the worker line
   * above it is simultaneously contradicting.
   */
  it("drops the pickup promise when the worker is not fresh", () => {
    for (const q of ["all", "recheck", ...Object.keys(JOB_CRON)]) {
      const stale = queuedNotice(q, undefined, false);
      expect(stale, q).toMatch(/queued/);
      expect(stale, q).not.toMatch(/worker picks it up within a few seconds/);
      expect(stale, q).not.toMatch(/worker picks them up within a few seconds/);
      expect(stale, q).not.toMatch(/use Refresh/);
    }
  });

  it("defaults to fresh, unaffected by the new parameter", () => {
    expect(queuedNotice("wanderer", undefined, true)).toBe(queuedNotice("wanderer"));
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

import { describe, expect, it } from "vitest";
import { ACCESS_LISTS_SCOPE } from "@/lib/esi/client";
import {
  doneNotice,
  monitorRemedy,
  monitorSentence,
  monitorState,
  rowHasDetail,
  rowSummary,
  rowTone,
  showsObservations,
  type MonitorInput,
  type WatchedRow,
} from "@/app/admin/access-lists/view";

const HOLDER = {
  characterId: 91_000_001,
  name: "Vela Kaine",
  scopes: [ACCESS_LISTS_SCOPE],
  tokenStatus: "valid" as const,
};

function input(over: Partial<MonitorInput> = {}): MonitorInput {
  return { holder: HOLDER, viewerHasScope: true, catalogSize: 3, ...over };
}

describe("monitorState", () => {
  it("1: no holder and the viewer lacks the scope asks for the grant first", () => {
    const s = monitorState(input({ holder: null, viewerHasScope: false }));
    expect(s.kind).toBe("grant-needed");
    expect(monitorRemedy(s)).toEqual({
      kind: "link",
      label: "Grant access",
      href: "/auth/eve/link?grant=access-lists",
    });
  });

  it("2: no holder but the viewer already granted it asks for designation", () => {
    const s = monitorState(input({ holder: null, viewerHasScope: true }));
    expect(s.kind).toBe("designate-needed");
    expect(monitorRemedy(s)).toEqual({ kind: "designate" });
  });

  it("3: a holder whose scope was dropped by an ordinary re-auth asks to re-grant", () => {
    const s = monitorState(input({ holder: { ...HOLDER, scopes: [] } }));
    expect(s).toEqual({
      kind: "scope-dropped",
      holder: { characterId: HOLDER.characterId, name: HOLDER.name },
    });
    expect(monitorRemedy(s)).toEqual({
      kind: "link",
      label: "Re-grant access",
      href: "/auth/eve/link?grant=access-lists",
    });
    // The scope is what is missing, so the remedy must be the granting link,
    // not the plain re-auth — the plain one would drop the scope again.
    expect(monitorSentence(s)).toContain("Vela Kaine");
    expect(monitorSentence(s)).toContain("no reads are happening");
  });

  it("4 and 5 are distinct states with distinct remedies", () => {
    const reauth = monitorState(
      input({ holder: { ...HOLDER, tokenStatus: "needs_reauth" } }),
    );
    expect(reauth.kind).toBe("holder-needs-reauth");
    expect(monitorRemedy(reauth)).toEqual({
      kind: "link",
      label: "Re-authenticate",
      href: "/auth/eve/link",
    });

    for (const tokenStatus of ["invalid", "missing"] as const) {
      const dead = monitorState(input({ holder: { ...HOLDER, tokenStatus } }));
      expect(dead).toEqual({
        kind: "holder-no-token",
        holder: { characterId: HOLDER.characterId, name: HOLDER.name },
        tokenStatus,
      });
      expect(monitorRemedy(dead)).toEqual({
        kind: "link",
        label: "Add this character again",
        href: "/auth/eve/link",
      });
    }

    // The sentences differ, because the two faults are not the same fault:
    // `needs_reauth` is a stored token whose grant went stale, `missing` is no
    // stored token at all. Same URL, different explanation of why you are at it.
    const missing = monitorState(
      input({ holder: { ...HOLDER, tokenStatus: "missing" } }),
    );
    const invalid = monitorState(
      input({ holder: { ...HOLDER, tokenStatus: "invalid" } }),
    );
    expect(monitorSentence(missing)).toContain("no stored token");
    expect(monitorSentence(invalid)).toContain("stopped working");
    expect(monitorSentence(reauth)).not.toBe(monitorSentence(missing));
  });

  it("a dropped scope outranks a bad token: fixing the token alone would not help", () => {
    const s = monitorState(
      input({ holder: { ...HOLDER, scopes: [], tokenStatus: "needs_reauth" } }),
    );
    expect(s.kind).toBe("scope-dropped");
  });

  it("6: a healthy holder with an empty catalog offers Check now", () => {
    const s = monitorState(input({ catalogSize: 0 }));
    expect(s.kind).toBe("catalog-empty");
    expect(monitorRemedy(s)).toEqual({ kind: "check-now" });
  });

  it("7: a healthy holder with a catalog is normal", () => {
    expect(monitorState(input()).kind).toBe("normal");
  });

  it("every dark-monitor state still shows the last observations", () => {
    // States 3-6 render the last successful observation beside the problem:
    // a stale answer plus its date beats a blank page. Only the two no-holder
    // states have nothing to show.
    for (const s of [
      monitorState(input({ holder: { ...HOLDER, scopes: [] } })),
      monitorState(input({ holder: { ...HOLDER, tokenStatus: "needs_reauth" } })),
      monitorState(input({ holder: { ...HOLDER, tokenStatus: "invalid" } })),
      monitorState(input({ catalogSize: 0 })),
      monitorState(input()),
    ]) {
      expect(showsObservations(s)).toBe(true);
    }
    expect(showsObservations(monitorState(input({ holder: null })))).toBe(false);
    expect(
      showsObservations(monitorState(input({ holder: null, viewerHasScope: false }))),
    ).toBe(false);
  });
});

function row(over: Partial<WatchedRow> = {}): WatchedRow {
  return {
    accessListId: 4001,
    name: "Fleet staging",
    readStatus: "ok",
    observedAt: new Date("2026-08-09T10:00:00.000Z"),
    allowEveryone: false,
    missingAccess: 0,
    nonMembers: 0,
    broadGrants: 0,
    ...over,
  };
}

describe("rowTone", () => {
  it("a clean list is ok", () => {
    expect(rowTone(row())).toBe("ok");
  });

  it("drift is warn, never bad — bad is reserved for destructive acts", () => {
    expect(rowTone(row({ missingAccess: 3 }))).toBe("warn");
    expect(rowTone(row({ nonMembers: 2 }))).toBe("warn");
    expect(rowTone(row({ allowEveryone: true }))).toBe("warn");
    expect(rowTone(row({ readStatus: "failed" }))).toBe("warn");
    expect(rowTone(row({ readStatus: "not_visible" }))).toBe("warn");
  });

  it("never bad, for any input this type admits", () => {
    for (const r of [
      row({
        missingAccess: 99,
        nonMembers: 99,
        allowEveryone: true,
        readStatus: "failed",
      }),
      row({ readStatus: null, observedAt: null }),
    ]) {
      expect(rowTone(r)).not.toBe("bad");
    }
  });

  it("a watched list the job has not reached yet is off, not warn", () => {
    // Same argument `sync/view.ts` makes for `never`: a list added to the
    // watchlist a minute ago has not failed at anything.
    expect(rowTone(row({ readStatus: null, observedAt: null }))).toBe("off");
  });
});

describe("rowSummary", () => {
  it("states allow_everyone in its own words, not as zero discrepancies", () => {
    const text = rowSummary(row({ allowEveryone: true }));
    expect(text).toContain("everyone");
    expect(text).not.toContain("in sync");
  });

  it("counts both buckets", () => {
    expect(rowSummary(row({ missingAccess: 2, nonMembers: 1 }))).toBe(
      "2 missing access · 1 has access, not a member",
    );
  });

  it("singularizes", () => {
    expect(rowSummary(row({ missingAccess: 1 }))).toBe("1 missing access");
  });

  it("names the read failure rather than the drift beneath it", () => {
    expect(rowSummary(row({ readStatus: "not_visible" }))).toBe("not visible to holder");
    expect(rowSummary(row({ readStatus: "failed" }))).toBe("read failed");
    expect(rowSummary(row({ readStatus: null, observedAt: null }))).toBe("not read yet");
  });
});

describe("rowHasDetail", () => {
  it("only rows with something to report expand", () => {
    expect(rowHasDetail(row())).toBe(false);
    expect(rowHasDetail(row({ readStatus: null, observedAt: null }))).toBe(false);
    expect(rowHasDetail(row({ missingAccess: 1 }))).toBe(true);
    expect(rowHasDetail(row({ nonMembers: 1 }))).toBe(true);
    expect(rowHasDetail(row({ broadGrants: 1 }))).toBe(true);
    expect(rowHasDetail(row({ allowEveryone: true }))).toBe(true);
    expect(rowHasDetail(row({ readStatus: "failed" }))).toBe(true);
  });
});

describe("doneNotice", () => {
  it("stamps the press so a second identical one still announces", () => {
    const text = doneNotice("check", "1786500000000");
    expect(text).toContain("Check queued");
    expect(text).toMatch(/\d\d:\d\d:\d\d\.\d\d\d UTC/);
  });

  it("drops an unparseable stamp rather than echoing it", () => {
    expect(doneNotice("check", "<script>")).toBe(
      "Check queued. Reload this page once the worker has run.",
    );
  });

  it("returns nothing for an unknown marker", () => {
    expect(doneNotice("nope", "1786500000000")).toBe("");
    expect(doneNotice(undefined, undefined)).toBe("");
  });
});

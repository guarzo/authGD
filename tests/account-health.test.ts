import { describe, expect, it } from "vitest";
import { computeAccountHealth, type CharacterHealthInput } from "@/core/account-health";

const char = (over: Partial<CharacterHealthInput> = {}): CharacterHealthInput => ({
  tokenStatus: "valid",
  needsReauthForScopes: false,
  contactsTarget: false,
  contactSyncResult: null,
  ...over,
});

const health = (
  attention: number,
  stalled: number,
  firstSyncPending: boolean,
  verdict: "degraded" | "stalled" | "first-sync-pending" | "nominal",
) => ({ attention, stalled, firstSyncPending, verdict });

describe("computeAccountHealth", () => {
  it("is nominal with no characters at all", () => {
    expect(computeAccountHealth([])).toEqual(health(0, 0, false, "nominal"));
  });

  it("is nominal when every character is healthy", () => {
    const chars = [char(), char({ contactsTarget: true, contactSyncResult: "ok" })];
    expect(computeAccountHealth(chars)).toEqual(health(0, 0, false, "nominal"));
  });

  it("is nominal for a non-target character regardless of its (absent) sync result", () => {
    // Blue/green members are never contacts targets, so a null result here is
    // structural, not a pending first sync — see account-view.ts.
    expect(computeAccountHealth([char({ contactsTarget: false })])).toEqual(
      health(0, 0, false, "nominal"),
    );
  });

  it("is first-sync-pending when every target character has no result yet", () => {
    const chars = [
      char({ contactsTarget: true, contactSyncResult: null }),
      char({ contactsTarget: true, contactSyncResult: null }),
    ];
    expect(computeAccountHealth(chars)).toEqual(health(0, 0, true, "first-sync-pending"));
  });

  it("is not first-sync-pending once any target character has a result", () => {
    const chars = [
      char({ contactsTarget: true, contactSyncResult: "ok" }),
      char({ contactsTarget: true, contactSyncResult: null }),
    ];
    expect(computeAccountHealth(chars)).toEqual(health(0, 0, false, "nominal"));
  });

  it("counts a bad token as needing attention", () => {
    expect(computeAccountHealth([char({ tokenStatus: "invalid" })])).toEqual(
      health(1, 0, false, "degraded"),
    );
  });

  it("counts a scope shortfall as needing attention even with a valid token", () => {
    expect(computeAccountHealth([char({ needsReauthForScopes: true })])).toEqual(
      health(1, 0, false, "degraded"),
    );
  });

  it.each([
    "missing_label",
    "label_mismatch",
    "token_invalid",
    "missing_scope",
    "needs_reauth",
  ])("counts %s as needing attention — the member can clear it themselves", (result) => {
    const chars = [char({ contactsTarget: true, contactSyncResult: result })];
    expect(computeAccountHealth(chars)).toEqual(health(1, 0, false, "degraded"));
  });

  // ContactRemedy tells the member "nothing to do here" for these. A headline
  // demanding attention over copy saying the opposite teaches members that the
  // headline is noise, which defeats the point of having one.
  it.each(["token_refresh_failed", "sync_failed", "dry_run", "some_new_code"])(
    "counts %s as stalled, not as needing attention",
    (result) => {
      const chars = [char({ contactsTarget: true, contactSyncResult: result })];
      expect(computeAccountHealth(chars)).toEqual(health(0, 1, false, "stalled"));
    },
  );

  it("does not double-count a stalled sync on a character that already needs attention", () => {
    const chars = [
      char({
        tokenStatus: "invalid",
        contactsTarget: true,
        contactSyncResult: "sync_failed",
      }),
    ];
    expect(computeAccountHealth(chars)).toEqual(health(1, 0, false, "degraded"));
  });

  it("leads with attention when both kinds are present", () => {
    const chars = [
      char({ contactsTarget: true, contactSyncResult: "missing_label" }),
      char({ contactsTarget: true, contactSyncResult: "dry_run" }),
    ];
    expect(computeAccountHealth(chars)).toEqual(health(1, 1, false, "degraded"));
  });

  it("does not count a target character mid-first-sync as degraded on its own", () => {
    const chars = [
      char({ contactsTarget: true, contactSyncResult: null }),
      char({ tokenStatus: "needs_reauth" }),
    ];
    // The token problem is real and counted; the pending contacts state is
    // not treated as a separate failure.
    expect(computeAccountHealth(chars)).toEqual(health(1, 0, true, "degraded"));
  });

  it("sums multiple characters needing attention", () => {
    const chars = [
      char({ tokenStatus: "missing" }),
      char({ needsReauthForScopes: true }),
      char({ contactsTarget: true, contactSyncResult: "ok" }),
    ];
    expect(computeAccountHealth(chars)).toEqual(health(2, 0, false, "degraded"));
  });

  // The regression this shape exists to prevent. A character linked seconds ago
  // has no scopes yet, so it needs attention AND is waiting on its first
  // contacts run. Collapsing the two into one priority-ordered state made the
  // verdict correct and silently dropped the notice that tells the member the
  // wait is minutes rather than broken (e2e/account.spec.ts covers the render).
  it("reports a pending first sync even while the same character needs attention", () => {
    const chars = [
      char({
        needsReauthForScopes: true,
        contactsTarget: true,
        contactSyncResult: null,
      }),
    ];
    expect(computeAccountHealth(chars)).toEqual(health(1, 0, true, "degraded"));
  });
});

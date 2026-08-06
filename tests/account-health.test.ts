import { describe, expect, it } from "vitest";
import {
  classifyCharacter,
  computeAccountHealth,
  type CharacterHealthInput,
  type DiscordPushInput,
} from "@/core/account-health";

const char = (over: Partial<CharacterHealthInput> = {}): CharacterHealthInput => ({
  tokenStatus: "valid",
  needsReauthForScopes: false,
  contactsTarget: false,
  contactSyncResult: null,
  ...over,
});

/**
 * `discord-roles` fires hourly at :15 (`JOB_CRON["discord-roles"]`), so a push
 * "at 14:15" is due again at 15:15 and overdue past the 5-minute grace at
 * 15:21. `NOW` sits well inside the grace of the default `LAST_PUSHED` so the
 * unqualified default reads not-stale.
 */
const LAST_PUSHED = new Date("2026-01-05T14:15:00.000Z");
const NOW = new Date("2026-01-05T15:19:00.000Z");
const OVERDUE_NOW = new Date("2026-01-05T15:21:00.000Z");

const discord = (over: Partial<DiscordPushInput> = {}): DiscordPushInput => ({
  linked: false,
  lastPushedAt: LAST_PUSHED,
  now: NOW,
  ...over,
});

const health = (
  attention: number,
  stalled: number,
  firstSyncPending: boolean,
  verdict: "degraded" | "stalled" | "discord-stale" | "first-sync-pending" | "nominal",
  discordStale = false,
) => ({ attention, stalled, firstSyncPending, discordStale, verdict });

describe("computeAccountHealth", () => {
  it("is nominal with no characters at all", () => {
    expect(computeAccountHealth([], discord())).toEqual(health(0, 0, false, "nominal"));
  });

  it("is nominal when every character is healthy", () => {
    const chars = [char(), char({ contactsTarget: true, contactSyncResult: "ok" })];
    expect(computeAccountHealth(chars, discord())).toEqual(
      health(0, 0, false, "nominal"),
    );
  });

  it("is nominal for a non-target character regardless of its (absent) sync result", () => {
    // Associate/alumni members are never contacts targets, so a null result here is
    // structural, not a pending first sync — see account-view.ts.
    expect(computeAccountHealth([char({ contactsTarget: false })], discord())).toEqual(
      health(0, 0, false, "nominal"),
    );
  });

  it("is first-sync-pending when every target character has no result yet", () => {
    const chars = [
      char({ contactsTarget: true, contactSyncResult: null }),
      char({ contactsTarget: true, contactSyncResult: null }),
    ];
    expect(computeAccountHealth(chars, discord())).toEqual(
      health(0, 0, true, "first-sync-pending"),
    );
  });

  it("is not first-sync-pending once any target character has a result", () => {
    const chars = [
      char({ contactsTarget: true, contactSyncResult: "ok" }),
      char({ contactsTarget: true, contactSyncResult: null }),
    ];
    expect(computeAccountHealth(chars, discord())).toEqual(
      health(0, 0, false, "nominal"),
    );
  });

  it("counts a bad token as needing attention", () => {
    expect(computeAccountHealth([char({ tokenStatus: "invalid" })], discord())).toEqual(
      health(1, 0, false, "degraded"),
    );
  });

  it("counts a scope shortfall as needing attention even with a valid token", () => {
    expect(
      computeAccountHealth([char({ needsReauthForScopes: true })], discord()),
    ).toEqual(health(1, 0, false, "degraded"));
  });

  it.each([
    "missing_label",
    "label_mismatch",
    "token_invalid",
    "missing_scope",
    "needs_reauth",
  ])("counts %s as needing attention — the member can clear it themselves", (result) => {
    const chars = [char({ contactsTarget: true, contactSyncResult: result })];
    expect(computeAccountHealth(chars, discord())).toEqual(
      health(1, 0, false, "degraded"),
    );
  });

  // ContactRemedy tells the member "nothing to do here" for these. A headline
  // demanding attention over copy saying the opposite teaches members that the
  // headline is noise, which defeats the point of having one.
  it.each(["token_refresh_failed", "sync_failed", "dry_run", "some_new_code"])(
    "counts %s as stalled, not as needing attention",
    (result) => {
      const chars = [char({ contactsTarget: true, contactSyncResult: result })];
      expect(computeAccountHealth(chars, discord())).toEqual(
        health(0, 1, false, "stalled"),
      );
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
    expect(computeAccountHealth(chars, discord())).toEqual(
      health(1, 0, false, "degraded"),
    );
  });

  it("leads with attention when both kinds are present", () => {
    const chars = [
      char({ contactsTarget: true, contactSyncResult: "missing_label" }),
      char({ contactsTarget: true, contactSyncResult: "dry_run" }),
    ];
    expect(computeAccountHealth(chars, discord())).toEqual(
      health(1, 1, false, "degraded"),
    );
  });

  it("does not count a target character mid-first-sync as degraded on its own", () => {
    const chars = [
      char({ contactsTarget: true, contactSyncResult: null }),
      char({ tokenStatus: "needs_reauth" }),
    ];
    // The token problem is real and counted; the pending contacts state is
    // not treated as a separate failure.
    expect(computeAccountHealth(chars, discord())).toEqual(
      health(1, 0, true, "degraded"),
    );
  });

  it("sums multiple characters needing attention", () => {
    const chars = [
      char({ tokenStatus: "missing" }),
      char({ needsReauthForScopes: true }),
      char({ contactsTarget: true, contactSyncResult: "ok" }),
    ];
    expect(computeAccountHealth(chars, discord())).toEqual(
      health(2, 0, false, "degraded"),
    );
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
    expect(computeAccountHealth(chars, discord())).toEqual(
      health(1, 0, true, "degraded"),
    );
  });

  describe("discord push staleness", () => {
    it("is discord-stale when linked and the last push is overdue", () => {
      const d = discord({ linked: true, now: OVERDUE_NOW });
      expect(computeAccountHealth([], d)).toEqual(
        health(0, 0, false, "discord-stale", true),
      );
    });

    it("is not discord-stale when linked but never pushed — no anchor to be late against", () => {
      const d = discord({ linked: true, lastPushedAt: null, now: OVERDUE_NOW });
      expect(computeAccountHealth([], d)).toEqual(health(0, 0, false, "nominal"));
    });

    it("is not discord-stale when not linked, however overdue the last push would read", () => {
      const d = discord({ linked: false, now: OVERDUE_NOW });
      expect(computeAccountHealth([], d)).toEqual(health(0, 0, false, "nominal"));
    });

    it("stays degraded when a character needs attention alongside a stale discord push", () => {
      const chars = [char({ tokenStatus: "invalid" })];
      const d = discord({ linked: true, now: OVERDUE_NOW });
      expect(computeAccountHealth(chars, d)).toEqual(
        health(1, 0, false, "degraded", true),
      );
    });

    it("stays stalled when a character is stalled alongside a stale discord push", () => {
      const chars = [char({ contactsTarget: true, contactSyncResult: "sync_failed" })];
      const d = discord({ linked: true, now: OVERDUE_NOW });
      expect(computeAccountHealth(chars, d)).toEqual(
        health(0, 1, false, "stalled", true),
      );
    });
  });
});

describe("classifyCharacter", () => {
  it("calls a valid, untargeted character ok", () => {
    expect(classifyCharacter(char())).toBe("ok");
  });

  it("calls a targeted character with no result yet ok", () => {
    expect(classifyCharacter(char({ contactsTarget: true }))).toBe("ok");
  });

  it("calls a successful sync ok", () => {
    expect(
      classifyCharacter(char({ contactsTarget: true, contactSyncResult: "ok" })),
    ).toBe("ok");
  });

  // The five MEMBER_FIXABLE codes, each cleared by re-linking or renaming a
  // label in game. Table-driven so a code added to the set without a decision
  // about this table fails loudly here.
  for (const result of [
    "missing_label",
    "label_mismatch",
    "token_invalid",
    "missing_scope",
    "needs_reauth",
  ]) {
    it(`calls ${result} attention`, () => {
      expect(
        classifyCharacter(char({ contactsTarget: true, contactSyncResult: result })),
      ).toBe("attention");
    });
  }

  // Not the member's to fix, but not ok either — this is the distinction the
  // whole design rests on, and the one an earlier draft of the spec collapsed.
  for (const result of ["token_refresh_failed", "sync_failed", "dry_run"]) {
    it(`calls ${result} stalled`, () => {
      expect(
        classifyCharacter(char({ contactsTarget: true, contactSyncResult: result })),
      ).toBe("stalled");
    });
  }

  // A code written by an older deployment crosses the DB boundary as a plain
  // string. It must degrade to stalled, never throw and never read as ok.
  it("calls an unrecognized code stalled", () => {
    expect(
      classifyCharacter(
        char({ contactsTarget: true, contactSyncResult: "from_a_future_deploy" }),
      ),
    ).toBe("stalled");
  });

  it("calls a bad token attention regardless of contacts", () => {
    expect(classifyCharacter(char({ tokenStatus: "needs_reauth" }))).toBe("attention");
  });

  it("calls a missing scope attention", () => {
    expect(classifyCharacter(char({ needsReauthForScopes: true }))).toBe("attention");
  });

  // An untargeted character cannot be stalled: there is no sync to stall.
  it("ignores a stale result on an untargeted character", () => {
    expect(
      classifyCharacter(
        char({ contactsTarget: false, contactSyncResult: "sync_failed" }),
      ),
    ).toBe("ok");
  });

  // The guarantee the refactor buys: one taxonomy, not two. If these ever
  // disagree, the row and the account headline are telling different stories.
  it("agrees with computeAccountHealth's counts", () => {
    const chars = [
      char(),
      char({ tokenStatus: "invalid" }),
      char({ contactsTarget: true, contactSyncResult: "dry_run" }),
      char({ contactsTarget: true, contactSyncResult: "missing_label" }),
    ];
    const h = computeAccountHealth(chars, discord());
    expect(chars.filter((c) => classifyCharacter(c) === "attention")).toHaveLength(
      h.attention,
    );
    expect(chars.filter((c) => classifyCharacter(c) === "stalled")).toHaveLength(
      h.stalled,
    );
  });
});

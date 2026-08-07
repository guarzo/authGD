import { describe, expect, it } from "vitest";
import { isFailureAction, summarizeDetails } from "@/app/admin/audit/summarize";

describe("summarizeDetails", () => {
  it("renders a tier transition with its from value", () => {
    expect(summarizeDetails("tier.changed", { from: "member", to: "alumni" })).toBe(
      "member → alumni",
    );
  });

  it("renders a tier transition without from", () => {
    expect(summarizeDetails("tier.changed", { to: "alumni" })).toBe("→ alumni");
  });

  it("renders a labelled scalar action", () => {
    expect(summarizeDetails("admin.bootstrap_granted", { characterId: 90000001 })).toBe(
      "character 90000001",
    );
  });

  it("renders a bare scalar action", () => {
    expect(summarizeDetails("token.invalidated", { reason: "refresh rejected" })).toBe(
      "refresh rejected",
    );
  });

  it("renders an empty payload as an em dash", () => {
    expect(summarizeDetails("unknown.action", {})).toBe("—");
  });

  it("does not throw on a non-object payload", () => {
    expect(summarizeDetails("unknown.action", "a string")).toBe("—");
    expect(summarizeDetails("unknown.action", null)).toBe("—");
  });

  it("does not throw on a self-referential payload", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => summarizeDetails("unknown.action", cyclic)).not.toThrow();
  });

  it("renders an approval as a transition into the granted tier", () => {
    expect(summarizeDetails("tier.approved", { to: "green", locked: false })).toBe(
      "→ green",
    );
  });

  it("renders an approval that locked the tier", () => {
    expect(summarizeDetails("tier.approved", { to: "blue", locked: true })).toBe(
      "→ blue, locked",
    );
  });

  it("renders a reclaim's origin account by name when it resolves", () => {
    expect(
      summarizeDetails(
        "character.reclaimed",
        { fromAccount: "7f3a2b1c-0000-4000-8000-000000000001" },
        new Map(),
        {},
        new Map([["fromAccount", "Old Owner"]]),
      ),
    ).toBe("from Old Owner");
  });

  it("falls back to a shortened uuid when a reclaim's origin account doesn't resolve", () => {
    // No accountNames map at all -- the default parameter, exercised the way a
    // caller that hasn't been updated for this field still would be.
    expect(
      summarizeDetails("character.reclaimed", {
        fromAccount: "7f3a2b1c-0000-4000-8000-000000000001",
      }),
    ).toBe("from 7f3a2b…");
  });

  it("renders a merge with a shortened source account and its character", () => {
    expect(
      summarizeDetails("account.merged", {
        sourceAccountId: "7f3a2b1c-0000-4000-8000-000000000001",
        characterId: 90000001,
      }),
    ).toBe("absorbed 7f3a2b…, character 90000001");
  });

  it("renders a reprice with the name and price the fallback used to truncate", () => {
    // unitPrice is what payout-loot.ts:218 actually writes: centsToIsk(), which
    // is always a 2dp STRING. Kept verbatim rather than normalised to 5.5 — the
    // trailing zeros are the money shape, and stripping them would render a
    // 1000.00 ISK reprice as "1000".
    expect(
      summarizeDetails("payout.item_repriced", {
        itemId: "i-1",
        poolId: "p-1",
        name: "Tritanium",
        unitPrice: "5.50",
      }),
    ).toBe("Tritanium → 5.50");
  });

  // The sub-object ids are declared-and-silent, not unread: a `+2 more` here
  // would tell an admin something was hidden from them when nothing was.
  it("does not report the reprice sub-object ids as hidden keys", () => {
    expect(
      summarizeDetails("payout.item_repriced", {
        itemId: "i-1",
        poolId: "p-1",
        name: "Tritanium",
        unitPrice: "5.50",
      }),
    ).not.toContain("more");
  });

  // Every action emitted with no `details` at all. Derived mechanically from
  // `grep -rho 'action: "…"' src/`. A renderer for any of these would be
  // machinery for an empty payload, and the em dash is already correct.
  it.each([
    "character.linked",
    "character.reauthed",
    "discord.linked",
    "admin.demoted",
    "admin.promoted",
    "character.affiliation_invalid",
    "wanderer.added",
    "wanderer.unblocked",
    "sync.requested",
    "sync.recheck_requested",
    "payout.created",
    "payout.finalized",
    "payout.unlocked",
  ])("renders %s with no details as an em dash", (action) => {
    expect(summarizeDetails(action, {})).toBe("—");
  });
});

const ROLE_NAMES = new Map([
  ["100", "member"],
  ["200", "associate"],
  ["300", "alumni"],
]);

describe("summarizeDetails, declared fields and role rendering", () => {
  it("renders a status transition with its from value", () => {
    expect(summarizeDetails("status.changed", { from: "active", to: "cryo" })).toBe(
      "active → cryo",
    );
  });

  it("renders a status transition without from", () => {
    expect(summarizeDetails("status.changed", { to: "cryo" })).toBe("→ cryo");
  });

  it("no longer declares admin.promoted, which writes no payload", () => {
    // The declaration described seeded test data: the app has no admin scope
    // or note. An admin.promoted row has no details at all, so page.tsx
    // short-circuits before this function; a payload from anywhere else falls
    // through to the generic fallback rather than to a fictional shape.
    expect(summarizeDetails("admin.promoted", { scope: "all" })).toBe("scope=all");
  });

  it("marks a truncated fallback instead of cutting silently", () => {
    expect(summarizeDetails("unknown.action", { a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe(
      "a=1, b=2, c=3, +2 more",
    );
  });

  it("does not mark a fallback that fits", () => {
    expect(summarizeDetails("unknown.action", { a: 1, b: 2, c: 3 })).toBe(
      "a=1, b=2, c=3",
    );
  });

  it("resolves known role ids to tier names", () => {
    expect(
      summarizeDetails(
        "discord.role_changed",
        { added: ["300"], removed: ["100"] },
        ROLE_NAMES,
      ),
    ).toBe("+alumni −member");
  });

  it("collapses unresolvable ids alongside known ones", () => {
    expect(
      summarizeDetails(
        "discord.role_changed",
        { added: ["300"], removed: ["100", "999888777"] },
        ROLE_NAMES,
      ),
    ).toBe("+alumni −member, −1 other");
  });

  it("truncates a lone unresolvable id", () => {
    expect(
      summarizeDetails(
        "discord.role_changed",
        { added: [], removed: ["298471555"] },
        ROLE_NAMES,
      ),
    ).toBe("−298471…");
  });

  it("resolves nothing when no role map is supplied", () => {
    expect(
      summarizeDetails("discord.role_changed", {
        added: ["987654321098765432"],
        removed: [],
      }),
    ).toBe("+987654…");
  });

  it("does not throw on a role payload that is not an array", () => {
    expect(
      summarizeDetails(
        "discord.role_changed",
        { added: "300", removed: null },
        ROLE_NAMES,
      ),
    ).toBe("—");
  });

  it("surfaces the cause a tier change was written with", () => {
    expect(
      summarizeDetails("tier.changed", {
        from: "member",
        to: "alumni",
        cause: "main unlinked",
      }),
    ).toBe("member → alumni, main unlinked");
  });

  it("renders a truthy flag as its word and a falsy one as nothing", () => {
    expect(summarizeDetails("tier.changed", { to: "associate", locked: true })).toBe(
      "→ associate, locked",
    );
    expect(summarizeDetails("tier.changed", { to: "associate", locked: false })).toBe(
      "→ associate",
    );
  });

  it("does not count a declared key that rendered blank as hidden", () => {
    // Rule 1: declared-and-deliberately-silent is not nobody-looked-at-it.
    expect(
      summarizeDetails("tier.changed", { to: "associate", locked: false }),
    ).not.toContain("more");
  });

  it("appends the remainder for an undeclared key on a declared action", () => {
    expect(summarizeDetails("tier.changed", { to: "associate", surprise: 1 })).toBe(
      "→ associate, +1 more",
    );
  });

  it("appends the remainder even when every declared part rendered blank", () => {
    // Rule 2: a blank line carrying unnamed keys must not claim emptiness.
    expect(summarizeDetails("tier.unlocked", { surprise: 1, alsoNew: 2 })).toBe(
      "+2 more",
    );
  });

  it("does not truncate declared parts at the fallback cap", () => {
    // Rule 3: the three-key cap is the machine-generated fallback's, not a
    // hand-curated declaration's.
    expect(
      summarizeDetails("tier.changed", {
        from: "member",
        to: "alumni",
        cause: "manual",
        locked: true,
      }),
    ).toBe("member → alumni, manual, locked");
  });

  it("renders one or two missing scopes in full and collapses three or more", () => {
    expect(summarizeDetails("token.needs_reauth", { missingScopes: ["esi-a.v1"] })).toBe(
      "missing esi-a.v1",
    );
    expect(
      summarizeDetails("token.needs_reauth", { missingScopes: ["esi-a.v1", "esi-b.v1"] }),
    ).toBe("missing esi-a.v1, esi-b.v1");
    // Three is the boundary itself, so an off-by-one would still pass on four.
    expect(
      summarizeDetails("token.needs_reauth", {
        missingScopes: ["esi-a.v1", "esi-b.v1", "esi-c.v1"],
      }),
    ).toBe("missing 3 scopes");
    expect(
      summarizeDetails("token.needs_reauth", {
        missingScopes: ["esi-a.v1", "esi-b.v1", "esi-c.v1", "esi-d.v1"],
      }),
    ).toBe("missing 4 scopes");
  });

  it("renders the location job's single refused scope, not a shortfall list", () => {
    // Second writer, different payload shape, same action. Neither writer's
    // keys may show up as an unexplained `+N more` on the other's rows.
    expect(
      summarizeDetails("token.needs_reauth", {
        scope: "esi-location.read_location.v1",
        detectedBy: "location",
      }),
    ).toBe("refused esi-location.read_location.v1, detected by location");
  });

  it("renders nothing for a malformed scope list and never marks it hidden", () => {
    // One legacy or hand-inserted row must not become a dead cell. Parity with
    // the roles() guard; the payload stays one disclosure click away.
    for (const missingScopes of ["a string", null, [], 7]) {
      const out = summarizeDetails("token.needs_reauth", { missingScopes });
      expect(out).toBe("—");
    }
  });

  it("renders an unlink with the name the deleted character had", () => {
    expect(
      summarizeDetails("character.unlinked", { name: "Zed Alt", wasMain: true }),
    ).toBe("Zed Alt, was main");
    expect(
      summarizeDetails("character.unlinked", { name: "Zed Alt", wasMain: false }),
    ).toBe("Zed Alt");
  });

  it("renders the tier automation was handed back", () => {
    expect(summarizeDetails("tier.unlocked", { tier: "member" })).toBe("was member");
  });

  it("renders a status note change as added, replaced, or cleared", () => {
    expect(summarizeDetails("status.note_changed", { had: false, has: true })).toBe(
      "note added",
    );
    expect(summarizeDetails("status.note_changed", { had: true, has: true })).toBe(
      "note replaced",
    );
    expect(summarizeDetails("status.note_changed", { had: true, has: false })).toBe(
      "note cleared",
    );
  });

  it("renders the wanderer role that was revoked", () => {
    expect(summarizeDetails("wanderer.removed", { role: "manager" })).toBe(
      "role manager",
    );
  });

  it("renders a role strip failure with its error and resolved role", () => {
    const names = new Map([["300", "alumni"]]);
    expect(
      summarizeDetails(
        "discord.role_strip_failed",
        { roleId: "300", error: "missing permissions" },
        names,
      ),
    ).toBe("missing permissions, role alumni");
  });

  it("falls back to a shortened id for an unresolved strip-failure role", () => {
    expect(
      summarizeDetails("discord.role_strip_failed", {
        roleId: "999888777",
        error: "missing permissions",
      }),
    ).toBe("missing permissions, role 999888…");
  });

  it("degrades when a strip failure records no role at all", () => {
    expect(
      summarizeDetails("discord.role_strip_failed", { roleId: null, error: "boom" }),
    ).toBe("boom");
  });

  it("renders a role sync failure with its error, in-flight op and tier", () => {
    const names = new Map([["300", "alumni"]]);
    expect(
      summarizeDetails(
        "discord.role_sync_failed",
        { op: "add", roleId: "300", tier: "alumni", error: "rate limited" },
        names,
        {},
      ),
    ).toBe("rate limited, adding alumni, tier alumni");
    expect(
      summarizeDetails(
        "discord.role_sync_failed",
        { op: "remove", roleId: "300", tier: "alumni", error: "rate limited" },
        names,
      ),
    ).toBe("rate limited, removing alumni, tier alumni");
  });

  it("does not hide any of the role sync failure's four payload keys", () => {
    expect(
      summarizeDetails("discord.role_sync_failed", {
        op: "add",
        roleId: "300",
        tier: "alumni",
        error: "rate limited",
      }),
    ).not.toContain("more");
  });

  it("degrades a role sync failure whose diff never got chosen", () => {
    // getGuildMember can throw before `diff` exists -- op and roleId are both
    // null, and the error is the whole story.
    expect(
      summarizeDetails("discord.role_sync_failed", {
        op: null,
        roleId: null,
        tier: "alumni",
        error: "guild unreachable",
      }),
    ).toBe("guild unreachable, tier alumni");
  });

  it("renders a self-service status change", () => {
    expect(
      summarizeDetails("status.changed", { from: "cryo", to: "active", self: true }),
    ).toBe("cryo → active, self-service");
  });

  it("surfaces the tier and cause a discord role change was written with", () => {
    const names = new Map([["1", "alumni"]]);
    expect(
      summarizeDetails(
        "discord.role_changed",
        { added: ["1"], tier: "alumni", cause: "tier change" },
        names,
      ),
    ).toBe("+alumni, tier alumni, tier change");
  });

  it("still degrades on rows written before this change", () => {
    // The no-migration guarantee, expressed as tests.
    expect(
      summarizeDetails("tier.changed", { to: "alumni", cause: "main unlinked" }),
    ).toBe("→ alumni, main unlinked");
    expect(summarizeDetails("status.changed", { to: "cryo" })).toBe("→ cryo");
    expect(summarizeDetails("character.unlinked", {})).toBe("—");
  });

  it("renders a pre-rename audit detail verbatim", () => {
    // audit_log.details is history, not live state. Rows written before
    // migration 0007 keep the old tier strings and are shown as stored — there is
    // no alias map, and adding one would rewrite history to match today's config.
    expect(
      summarizeDetails("tier.changed", { from: "green", to: "flygd", cause: "admin" }),
    ).toBe("green → flygd, admin");
  });
});

describe("summarizeDetails with configured tier labels", () => {
  const LABELS = {
    member: "Pilot",
    associate: "Cadet",
    alumni: "Veteran",
    pending: "Waiting",
  };

  it("labels both sides of a tier transition", () => {
    expect(
      summarizeDetails(
        "tier.changed",
        { from: "member", to: "alumni" },
        new Map(),
        LABELS,
      ),
    ).toBe("Pilot → Veteran");
  });

  it("labels an approval, which has no from value", () => {
    // tier.approved shares tier.changed's renderer; this is the assertion that
    // catches it being reverted to the unlabelled one.
    expect(
      summarizeDetails(
        "tier.approved",
        { to: "associate", locked: true },
        new Map(),
        LABELS,
      ),
    ).toBe("→ Cadet, locked");
  });

  it("labels an unlock's prior tier", () => {
    expect(summarizeDetails("tier.unlocked", { tier: "member" }, new Map(), LABELS)).toBe(
      "was Pilot",
    );
  });

  it("labels the tier a discord role change was written for", () => {
    expect(
      summarizeDetails(
        "discord.role_changed",
        { tier: "alumni", cause: "tier change" },
        new Map(),
        LABELS,
      ),
    ).toBe("tier Veteran, tier change");
  });

  it("leaves a status transition alone", () => {
    // status.changed keeps the unlabelled renderer on purpose: its values are
    // statuses, and a deployment naming a tier "Active" must not rename them.
    expect(
      summarizeDetails(
        "status.changed",
        { from: "active", to: "cryo" },
        new Map(),
        LABELS,
      ),
    ).toBe("active → cryo");
  });

  it("passes a pre-rename tier value through unchanged", () => {
    // A pre-rename value with labels configured: `flygd` is not a key in the
    // map, so it renders as stored rather than resolving to anything.
    expect(
      summarizeDetails("tier.changed", { from: "green", to: "flygd" }, new Map(), LABELS),
    ).toBe("green → flygd");
  });
});

describe("isFailureAction", () => {
  it("matches every action a writer actually names _failed", () => {
    expect(isFailureAction("discord.role_strip_failed")).toBe(true);
    expect(isFailureAction("discord.role_sync_failed")).toBe(true);
    expect(isFailureAction("token.verify_failed")).toBe(true);
  });

  it("does not match an ordinary state change, including a tier demotion", () => {
    expect(isFailureAction("discord.role_changed")).toBe(false);
    expect(isFailureAction("tier.changed")).toBe(false);
  });

  it("does not match a state the app is built to handle, not a failed action", () => {
    // token.needs_reauth, character.owner_mismatch and
    // character.affiliation_invalid are ordinary states this app handles by
    // design (a re-auth prompt, an ESI mismatch worth a look) -- not an
    // action the app attempted and failed at. See PARTS's doc for why the
    // failure/state line is drawn here rather than by hand-picking actions.
    expect(isFailureAction("token.needs_reauth")).toBe(false);
    expect(isFailureAction("character.owner_mismatch")).toBe(false);
    expect(isFailureAction("character.affiliation_invalid")).toBe(false);
  });
});

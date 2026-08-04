import { describe, expect, it } from "vitest";
import { summarizeDetails } from "@/app/admin/audit/summarize";

describe("summarizeDetails", () => {
  it("renders a tier transition with its from value", () => {
    expect(summarizeDetails("tier.changed", { from: "flygd", to: "green" })).toBe(
      "flygd → green",
    );
  });

  it("renders a tier transition without from", () => {
    expect(summarizeDetails("tier.changed", { to: "green" })).toBe("→ green");
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
});

const ROLE_NAMES = new Map([
  ["100", "flygd"],
  ["200", "blue"],
  ["300", "green"],
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
    ).toBe("+green −flygd");
  });

  it("collapses unresolvable ids alongside known ones", () => {
    expect(
      summarizeDetails(
        "discord.role_changed",
        { added: ["300"], removed: ["100", "999888777"] },
        ROLE_NAMES,
      ),
    ).toBe("+green −flygd, −1 other");
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
        from: "flygd",
        to: "green",
        cause: "main unlinked",
      }),
    ).toBe("flygd → green, main unlinked");
  });

  it("renders a truthy flag as its word and a falsy one as nothing", () => {
    expect(summarizeDetails("tier.changed", { to: "blue", locked: true })).toBe(
      "→ blue, locked",
    );
    expect(summarizeDetails("tier.changed", { to: "blue", locked: false })).toBe(
      "→ blue",
    );
  });

  it("does not count a declared key that rendered blank as hidden", () => {
    // Rule 1: declared-and-deliberately-silent is not nobody-looked-at-it.
    expect(summarizeDetails("tier.changed", { to: "blue", locked: false })).not.toContain(
      "more",
    );
  });

  it("appends the remainder for an undeclared key on a declared action", () => {
    expect(summarizeDetails("tier.changed", { to: "blue", surprise: 1 })).toBe(
      "→ blue, +1 more",
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
        from: "flygd",
        to: "green",
        cause: "manual",
        locked: true,
      }),
    ).toBe("flygd → green, manual, locked");
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
    expect(summarizeDetails("tier.unlocked", { tier: "flygd" })).toBe("was flygd");
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

  it("renders a self-service status change", () => {
    expect(
      summarizeDetails("status.changed", { from: "cryo", to: "active", self: true }),
    ).toBe("cryo → active, self-service");
  });

  it("surfaces the tier and cause a discord role change was written with", () => {
    const names = new Map([["1", "green"]]);
    expect(
      summarizeDetails(
        "discord.role_changed",
        { added: ["1"], tier: "green", cause: "tier change" },
        names,
      ),
    ).toBe("+green, tier green, tier change");
  });

  it("still degrades on rows written before this change", () => {
    // The no-migration guarantee, expressed as tests.
    expect(
      summarizeDetails("tier.changed", { to: "green", cause: "main unlinked" }),
    ).toBe("→ green, main unlinked");
    expect(summarizeDetails("status.changed", { to: "cryo" })).toBe("→ cryo");
    expect(summarizeDetails("character.unlinked", {})).toBe("—");
  });
});

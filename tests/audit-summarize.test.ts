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
    expect(
      summarizeDetails("admin.bootstrap_granted", { characterId: 90000001 }),
    ).toBe("character 90000001");
  });

  it("renders a bare scalar action", () => {
    expect(
      summarizeDetails("token.invalidated", { reason: "refresh rejected" }),
    ).toBe("refresh rejected");
  });

  it("renders an empty payload as an em dash", () => {
    expect(summarizeDetails("unknown.action", {})).toBe("—");
  });

  it("does not throw on a non-object payload", () => {
    expect(summarizeDetails("unknown.action", "a string")).toBe("—");
    expect(summarizeDetails("unknown.action", null)).toBe("—");
  });
});

const ROLE_NAMES = new Map([
  ["100", "flygd"],
  ["200", "blue"],
  ["300", "green"],
]);

describe("summarizeDetails, declared fields and role rendering", () => {
  it("renders a status transition with its from value", () => {
    expect(
      summarizeDetails("status.changed", { from: "active", to: "cryo" }),
    ).toBe("active → cryo");
  });

  it("renders a status transition without from", () => {
    expect(summarizeDetails("status.changed", { to: "cryo" })).toBe("→ cryo");
  });

  it("shows scope on a privilege grant", () => {
    expect(
      summarizeDetails("admin.promoted", { scope: "full", note: "shift lead" }),
    ).toBe("full, shift lead");
  });

  it("marks a truncated fallback instead of cutting silently", () => {
    expect(
      summarizeDetails("unknown.action", { a: 1, b: 2, c: 3, d: 4, e: 5 }),
    ).toBe("a=1, b=2, c=3, +2 more");
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
      summarizeDetails("discord.role_changed", { added: "300", removed: null }, ROLE_NAMES),
    ).toBe("—");
  });
});

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

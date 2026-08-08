import { describe, expect, it } from "vitest";
import { decideTier } from "@/core/tier";

describe("decideTier", () => {
  const cases: Array<{
    name: string;
    tier: "pending" | "member" | "associate" | "alumni";
    tierLocked: boolean;
    mainConfirmed: boolean;
    mainInAlliance: boolean;
    expected: "member" | "alumni" | null;
  }> = [
    {
      name: "alumni + main in alliance → member",
      tier: "alumni",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: true,
      expected: "member",
    },
    {
      name: "member + main left alliance → alumni",
      tier: "member",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: false,
      expected: "alumni",
    },
    {
      name: "member + main in alliance → no change",
      tier: "member",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: true,
      expected: null,
    },
    {
      name: "alumni + main out → no change",
      tier: "alumni",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: false,
      expected: null,
    },
    {
      name: "unlocked associate converges to member",
      tier: "associate",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: true,
      expected: "member",
    },
    {
      name: "unlocked associate converges to alumni",
      tier: "associate",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: false,
      expected: "alumni",
    },
    {
      name: "locked accounts are never touched",
      tier: "member",
      tierLocked: true,
      mainConfirmed: true,
      mainInAlliance: false,
      expected: null,
    },
    {
      name: "locked associate stays associate",
      tier: "associate",
      tierLocked: true,
      mainConfirmed: true,
      mainInAlliance: true,
      expected: null,
    },
    {
      name: "unconfirmed main is never transitioned",
      tier: "member",
      tierLocked: false,
      mainConfirmed: false,
      mainInAlliance: false,
      expected: null,
    },
    {
      name: "unconfirmed main never promotes either",
      tier: "alumni",
      tierLocked: false,
      mainConfirmed: false,
      mainInAlliance: true,
      expected: null,
    },
    {
      name: "pending + main in alliance → member (real members skip the queue)",
      tier: "pending",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: true,
      expected: "member",
    },
    {
      name: "pending + main out of alliance → stays pending, never auto-alumni",
      tier: "pending",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: false,
      expected: null,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(
        decideTier({
          tier: c.tier,
          tierLocked: c.tierLocked,
          mainConfirmed: c.mainConfirmed,
          mainInAlliance: c.mainInAlliance,
        }),
      ).toBe(c.expected);
    });
  }
});

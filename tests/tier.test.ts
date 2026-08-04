import { describe, expect, it } from "vitest";
import { decideTier } from "@/core/tier";

describe("decideTier", () => {
  const cases: Array<{
    name: string;
    tier: "pending" | "flygd" | "blue" | "green";
    tierLocked: boolean;
    mainConfirmed: boolean;
    mainInAlliance: boolean;
    expected: "flygd" | "green" | null;
  }> = [
    {
      name: "green + main in alliance → flygd",
      tier: "green",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: true,
      expected: "flygd",
    },
    {
      name: "flygd + main left alliance → green",
      tier: "flygd",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: false,
      expected: "green",
    },
    {
      name: "flygd + main in alliance → no change",
      tier: "flygd",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: true,
      expected: null,
    },
    {
      name: "green + main out → no change",
      tier: "green",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: false,
      expected: null,
    },
    {
      name: "unlocked blue converges to flygd",
      tier: "blue",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: true,
      expected: "flygd",
    },
    {
      name: "unlocked blue converges to green",
      tier: "blue",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: false,
      expected: "green",
    },
    {
      name: "locked accounts are never touched",
      tier: "flygd",
      tierLocked: true,
      mainConfirmed: true,
      mainInAlliance: false,
      expected: null,
    },
    {
      name: "locked blue stays blue",
      tier: "blue",
      tierLocked: true,
      mainConfirmed: true,
      mainInAlliance: true,
      expected: null,
    },
    {
      name: "unconfirmed main is never transitioned",
      tier: "flygd",
      tierLocked: false,
      mainConfirmed: false,
      mainInAlliance: false,
      expected: null,
    },
    {
      name: "unconfirmed main never promotes either",
      tier: "green",
      tierLocked: false,
      mainConfirmed: false,
      mainInAlliance: true,
      expected: null,
    },
    {
      name: "pending + main in alliance → flygd (real members skip the queue)",
      tier: "pending",
      tierLocked: false,
      mainConfirmed: true,
      mainInAlliance: true,
      expected: "flygd",
    },
    {
      name: "pending + main out of alliance → stays pending, never auto-green",
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

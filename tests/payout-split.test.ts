import { describe, expect, it } from "vitest";
import { centsToIsk, computeSplit, iskToCents } from "@/core/payout-split";

describe("iskToCents / centsToIsk", () => {
  it("round-trips whole and fractional amounts", () => {
    for (const [str, cents] of [
      ["0", 0n],
      ["0.00", 0n],
      ["1", 100n],
      ["1.50", 150n],
      ["1234.56", 123456n],
      ["1000000.01", 100000001n],
    ] as const) {
      expect(iskToCents(str)).toBe(cents);
      expect(centsToIsk(cents)).toBe(centsToIsk(iskToCents(centsToIsk(cents))));
    }
  });

  it("formats cents back to a canonical 2dp string", () => {
    expect(centsToIsk(0n)).toBe("0.00");
    expect(centsToIsk(100n)).toBe("1.00");
    expect(centsToIsk(150n)).toBe("1.50");
    expect(centsToIsk(5n)).toBe("0.05");
  });

  it("pads a single decimal digit", () => {
    expect(iskToCents("1.5")).toBe(150n);
    expect(iskToCents("1.05")).toBe(105n);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "abc", "1.234", "1,000", "1.", ".5", "1e5", "  "]) {
      expect(() => iskToCents(bad)).toThrow();
    }
  });
});

describe("computeSplit", () => {
  const cases: Array<{
    name: string;
    totalCents: bigint;
    corpSharePct: string;
    participants: Array<{ id: string; shares: string; excluded: boolean }>;
    expectAmounts: Record<string, bigint>;
    expectCorp: bigint;
  }> = [
    {
      name: "zero participants: everything to corp, no division",
      totalCents: 100000n,
      corpSharePct: "10.00",
      participants: [],
      expectAmounts: {},
      expectCorp: 100000n,
    },
    {
      name: "every participant excluded: same as zero participants",
      totalCents: 100000n,
      corpSharePct: "10.00",
      participants: [
        { id: "a", shares: "1", excluded: true },
        { id: "b", shares: "2", excluded: true },
      ],
      expectAmounts: { a: 0n, b: 0n },
      expectCorp: 100000n,
    },
    {
      name: "corpSharePct of 0.00: corp gets only the rounding remainder",
      totalCents: 100n, // 1.00 ISK, 3 equal shares -> 33/33/33 + 1 remainder
      corpSharePct: "0.00",
      participants: [
        { id: "a", shares: "1", excluded: false },
        { id: "b", shares: "1", excluded: false },
        { id: "c", shares: "1", excluded: false },
      ],
      expectAmounts: { a: 33n, b: 33n, c: 33n },
      expectCorp: 1n,
    },
    {
      name: "corpSharePct of 100.00: corp takes everything, no split",
      totalCents: 100000n,
      corpSharePct: "100.00",
      participants: [
        { id: "a", shares: "1", excluded: false },
        { id: "b", shares: "1", excluded: false },
      ],
      expectAmounts: { a: 0n, b: 0n },
      expectCorp: 100000n,
    },
    {
      name: "a pool smaller than the participant count: some get 0.00, remainder to corp",
      totalCents: 3n, // 0.03 ISK across 5 equal-share participants
      corpSharePct: "0.00",
      participants: [
        { id: "a", shares: "1", excluded: false },
        { id: "b", shares: "1", excluded: false },
        { id: "c", shares: "1", excluded: false },
        { id: "d", shares: "1", excluded: false },
        { id: "e", shares: "1", excluded: false },
      ],
      // pool=3, totalSharesH=500, perShare = 3*100/500 = 0 (floor) -> everyone 0
      expectAmounts: { a: 0n, b: 0n, c: 0n, d: 0n, e: 0n },
      expectCorp: 3n,
    },
    {
      name: "a scout at 1.50 shares gets one and a half times a normal share",
      totalCents: 25000n, // 250.00 ISK
      corpSharePct: "0.00",
      participants: [
        { id: "scout", shares: "1.50", excluded: false },
        { id: "line1", shares: "1", excluded: false },
        { id: "line2", shares: "1", excluded: false },
      ],
      // totalSharesH = 150+100+100 = 350, pool=25000
      // perShare = 25000*100/350 = 7142 (floor)
      // scout = 7142*150/100 = 10713
      // line1 = line2 = 7142*100/100 = 7142
      // distributed = 10713+7142+7142 = 24997, remainder 3 to corp
      expectAmounts: { scout: 10713n, line1: 7142n, line2: 7142n },
      expectCorp: 3n,
    },
    {
      name: "an excluded participant is omitted from the split entirely",
      totalCents: 20000n,
      corpSharePct: "10.00",
      participants: [
        { id: "a", shares: "1", excluded: false },
        { id: "afk", shares: "1", excluded: true },
      ],
      // corpBase = 20000*1000/10000 = 2000, pool = 18000
      // totalSharesH = 100 (only "a"), perShare = 18000*100/100 = 18000
      // amount(a) = 18000*100/100 = 18000, distributed = 18000, remainder 0
      expectAmounts: { a: 18000n, afk: 0n },
      expectCorp: 2000n,
    },
  ];

  it.each(cases)("$name", ({ totalCents, corpSharePct, participants, expectAmounts, expectCorp }) => {
    const result = computeSplit({ totalCents, corpSharePct, participants });

    for (const [id, expected] of Object.entries(expectAmounts)) {
      const p = participants.find((x) => x.id === id)!;
      if (p.excluded) {
        expect(result.amounts.has(id)).toBe(false);
      } else {
        expect(result.amounts.get(id)).toBe(expected);
      }
    }
    expect(result.corpAmountCents).toBe(expectCorp);

    // Invariant: nothing is created or destroyed by the split, for every case.
    const sumAmounts = [...result.amounts.values()].reduce((sum, a) => sum + a, 0n);
    expect(result.corpAmountCents + sumAmounts).toBe(totalCents);
  });
});

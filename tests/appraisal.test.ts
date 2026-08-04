import { describe, expect, it } from "vitest";
import { appraiseLoot } from "@/services/appraisal";

function fakeEsi(idByLowerName: Record<string, number>) {
  return {
    resolveIds: async (names: string[]) => {
      const out = new Map<string, number>();
      for (const n of names) {
        const id = idByLowerName[n.toLowerCase()];
        if (id !== undefined) out.set(n.toLowerCase(), id);
      }
      return out;
    },
  };
}

type FakeQuote = {
  sell?: { best?: number | null; p05?: number | null };
  buy?: { best?: number | null; p05?: number | null };
};

function fakeTriff(quotesByTypeId: Record<number, FakeQuote>) {
  return {
    quote: async (typeIds: number[]) => {
      const map = new Map();
      for (const id of typeIds) {
        const q = quotesByTypeId[id];
        if (q) {
          map.set(id, {
            typeId: id,
            sell: { best: q.sell?.best ?? null, p05: q.sell?.p05 ?? null },
            buy: { best: q.buy?.best ?? null, p05: q.buy?.p05 ?? null },
          });
        }
      }
      return map;
    },
  };
}

describe("appraiseLoot", () => {
  it("prices a resolved item at the chosen pricing mode", async () => {
    const result = await appraiseLoot(
      "10x Tritanium",
      { pricingMode: "sell_best", stationId: 60003760 },
      {
        esi: fakeEsi({ tritanium: 34 }),
        triff: fakeTriff({ 34: { sell: { best: 5.1 } } }),
      },
    );
    expect(result.items).toEqual([
      {
        typeId: 34,
        name: "Tritanium",
        qty: 10,
        unitPrice: "5.10",
        totalValue: "51.00",
        priceSource: "triff",
      },
    ]);
    expect(result.totalValue).toBe("51.00");
  });

  it("keeps an item with no known type id as a visible zero-priced row, not dropped", async () => {
    const raw = "3x Unknown Junk\n2x Tritanium";
    const result = await appraiseLoot(
      raw,
      { pricingMode: "sell_best", stationId: 60003760 },
      {
        esi: fakeEsi({ tritanium: 34 }),
        triff: fakeTriff({ 34: { sell: { best: 5 } } }),
      },
    );
    expect(result.items).toHaveLength(2);
    const junk = result.items.find((i) => i.name === "Unknown Junk")!;
    expect(junk).toEqual({
      typeId: null,
      name: "Unknown Junk",
      qty: 3,
      unitPrice: "0.00",
      totalValue: "0.00",
      priceSource: "unresolved",
    });
    const tri = result.items.find((i) => i.name === "Tritanium")!;
    expect(tri.totalValue).toBe("10.00");
    // The unresolved row contributes 0 to the total, but the item is present.
    expect(result.totalValue).toBe("10.00");
  });

  it("treats a type id with no price for the chosen mode as unresolved, not zero-quality data", async () => {
    const result = await appraiseLoot(
      "1x Plex",
      { pricingMode: "buy_best", stationId: 60003760 },
      {
        esi: fakeEsi({ plex: 44992 }),
        triff: fakeTriff({ 44992: { sell: { best: 3000 } } }),
      },
    );
    expect(result.items[0]).toMatchObject({
      typeId: 44992,
      priceSource: "unresolved",
      unitPrice: "0.00",
      totalValue: "0.00",
    });
  });

  // Rounding once at the line total rather than once per unit is the
  // point of this test: rounding the unit price to cents FIRST (naive:
  // 0.13 x 5,000,000 = 650,000.00) discriminates from rounding once at
  // the line total (correct: round(0.125 x 5,000,000) cents = 625,000.00)
  // by a visible, non-rounding-noise amount. A prior version of this test
  // asserted a plain sum of three lines and passed under BOTH the naive
  // and the correct implementation, so it never actually guarded the
  // rounding order — see design doc discussion in the task-8 fix round.
  // A second, differently-scaled line (small qty, ordinary 2dp price) is
  // included so this is also the only test with two nonzero-priced lines,
  // checking each line total AND the combined pool total.
  it("rounds once at the line total, not once per unit before multiplying by qty", async () => {
    const raw = "5000000x Widget\n3x Tritanium";
    const result = await appraiseLoot(
      raw,
      { pricingMode: "sell_best", stationId: 1 },
      {
        esi: fakeEsi({ widget: 1, tritanium: 34 }),
        triff: fakeTriff({ 1: { sell: { best: 0.125 } }, 34: { sell: { best: 5.1 } } }),
      },
    );
    const widget = result.items.find((i) => i.name === "Widget")!;
    const tri = result.items.find((i) => i.name === "Tritanium")!;
    expect(widget.totalValue).toBe("625000.00");
    expect(tri.totalValue).toBe("15.30");
    expect(result.totalValue).toBe("625015.30");
  });

  it("does not let a half-cent unit price scale its rounding error with a large quantity", async () => {
    // Rounding 5.005 to a 2dp unit price ("5.00") and then multiplying by
    // qty loses 10,000,000 ISK on a 2 billion unit line (10,000,000,000.00
    // instead of the true 10,010,000,000.00). Rounding once at the line
    // total avoids this entirely.
    const result = await appraiseLoot(
      "2000000000x Widget",
      { pricingMode: "sell_best", stationId: 1 },
      { esi: fakeEsi({ widget: 1 }), triff: fakeTriff({ 1: { sell: { best: 5.005 } } }) },
    );
    expect(result.items[0].totalValue).toBe("10010000000.00");
    expect(result.totalValue).toBe("10010000000.00");
  });

  it("does not zero out a sub-cent unit price that is worth real money in bulk", async () => {
    // 0.004 ISK rounds to "0.00" as a unit price, but 10,000,000 units of it
    // is a genuine 40,000 ISK line. Rounding once at the line total keeps
    // that value; rounding the unit price first would store 0.00 for the
    // whole line while still reporting priceSource: "triff" (a resolved,
    // "correctly priced" row silently worth nothing).
    const result = await appraiseLoot(
      "10000000x Widget",
      { pricingMode: "sell_best", stationId: 1 },
      { esi: fakeEsi({ widget: 1 }), triff: fakeTriff({ 1: { sell: { best: 0.004 } } }) },
    );
    expect(result.items[0]).toMatchObject({
      unitPrice: "0.00",
      totalValue: "40000.00",
      priceSource: "triff",
    });
    expect(result.totalValue).toBe("40000.00");
  });

  it("carries the parser's dropped lines through and still appraises the rest", async () => {
    // "12" alone is dropped; "0x Tritanium" is NOT, because the later line
    // makes that item's total positive. Nothing is rejected wholesale.
    const result = await appraiseLoot(
      "12\n0x Tritanium\n2x Tritanium",
      { pricingMode: "sell_best", stationId: 60003760 },
      {
        esi: fakeEsi({ tritanium: 34 }),
        triff: fakeTriff({ 34: { sell: { best: 5 } } }),
      },
    );
    expect(result.dropped).toEqual([{ line: "12", reason: "quantity-only" }]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: "Tritanium", qty: 2 });
    expect(result.totalValue).toBe("10.00");
  });

  /**
   * Bounding QUANTITY does not make the line total exact — the total is still
   * a float product. Both rows below are an ordinary market price at an
   * ordinary mineral quantity, and both land on the wrong cent: the float
   * route gives 100000001000000000 where the exact product is
   * 100000001000000001, and 111111110099999984 where the exact product is
   * 111111110099999991. Both fit numeric(20,2) with room to spare, so
   * MAX_MONEY_CENTS never catches them — the product bound is what does.
   */
  const imprecise: Array<{ label: string; price: number; qty: number }> = [
    {
      label: "a line total one cent past what the float route gets right",
      price: 1000000.01,
      qty: 1000000000,
    },
    {
      label: "a line total seven cents past what the float route gets right",
      price: 1234567.89,
      qty: 900000000,
    },
  ];

  it.each(imprecise)("refuses $label", async ({ price, qty }) => {
    await expect(
      appraiseLoot(
        `${qty}x Tritanium`,
        { pricingMode: "sell_best", stationId: 60003760 },
        {
          esi: fakeEsi({ tritanium: 34 }),
          triff: fakeTriff({ 34: { sell: { best: price } } }),
        },
      ),
    ).rejects.toThrow(
      "the line total for Tritanium exceeds the largest line total this system records",
    );
  });

  it("still appraises a line just under the exactness bound", async () => {
    // 9,007,199,000,000,000 cents, against a bound of 9,007,199,254,740,991 —
    // a single line worth 90,071,990,000,000 ISK. The bound rejects only lines
    // past ~90 trillion ISK, which is far above any real loot line.
    const result = await appraiseLoot(
      "1000000000x Tritanium",
      { pricingMode: "sell_best", stationId: 60003760 },
      {
        esi: fakeEsi({ tritanium: 34 }),
        triff: fakeTriff({ 34: { sell: { best: 90071.99 } } }),
      },
    );
    expect(result.items[0].totalValue).toBe("90071990000000.00");
    expect(result.totalValue).toBe("90071990000000.00");
  });

  it("stores the true cent on a line the float multiply gets wrong", async () => {
    // Under MAX_EXACT_LINE_CENTS, so the guard does not fire — and that guard
    // was never what made this exact. `48804.84 * 1845177173 * 100` evaluates
    // to 9005357669991731 in a float; the true total is 9005357669991732.
    // Bounding the product only makes the answer representable; the price's
    // own ~1.1e-16 representation error is already about a cent at this
    // magnitude, which is why the multiply is done in bigint.
    const result = await appraiseLoot(
      "1845177173x Tritanium",
      { pricingMode: "sell_best", stationId: 60003760 },
      {
        esi: fakeEsi({ tritanium: 34 }),
        triff: fakeTriff({ 34: { sell: { best: 48804.84 } } }),
      },
    );
    expect(result.items[0].totalValue).toBe("90053576699917.32");
    expect(result.totalValue).toBe("90053576699917.32");
  });
});

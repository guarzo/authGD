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
      { esi: fakeEsi({ tritanium: 34 }), triff: fakeTriff({ 34: { sell: { best: 5.1 } } }) },
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
      { esi: fakeEsi({ tritanium: 34 }), triff: fakeTriff({ 34: { sell: { best: 5 } } }) },
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
      { esi: fakeEsi({ plex: 44992 }), triff: fakeTriff({ 44992: { sell: { best: 3000 } } }) },
    );
    expect(result.items[0]).toMatchObject({
      typeId: 44992,
      priceSource: "unresolved",
      unitPrice: "0.00",
      totalValue: "0.00",
    });
  });

  it("sums many lines in exact cents rather than accumulating float error", async () => {
    const raw = ["1x A", "1x B", "1x C"].join("\n");
    const result = await appraiseLoot(
      raw,
      { pricingMode: "sell_best", stationId: 1 },
      {
        esi: fakeEsi({ a: 1, b: 2, c: 3 }),
        triff: fakeTriff({
          1: { sell: { best: 0.1 } },
          2: { sell: { best: 0.2 } },
          3: { sell: { best: 0.3 } },
        }),
      },
    );
    expect(result.totalValue).toBe("0.60");
  });
});

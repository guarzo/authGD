import { describe, expect, it } from "vitest";
import {
  selectPrice,
  PRICING_MODES,
  type PricingMode,
  type QuoteSides,
} from "@/core/pricing";

describe("PRICING_MODES", () => {
  it("lists all four modes", () => {
    expect(PRICING_MODES).toEqual(["sell_best", "sell_p05", "buy_best", "buy_p05"]);
  });
});

describe("selectPrice", () => {
  const full: QuoteSides = {
    sell: { best: 5.1, p05: 5.44 },
    buy: { best: 4.9, p05: 4.61 },
  };

  const cases: Array<{
    label: string;
    quote: QuoteSides | undefined;
    mode: PricingMode;
    expected: number | null;
  }> = [
    { label: "sell_best reads sell.best", quote: full, mode: "sell_best", expected: 5.1 },
    { label: "sell_p05 reads sell.p05", quote: full, mode: "sell_p05", expected: 5.44 },
    { label: "buy_best reads buy.best", quote: full, mode: "buy_best", expected: 4.9 },
    { label: "buy_p05 reads buy.p05", quote: full, mode: "buy_p05", expected: 4.61 },
    {
      label: "sell_p05 falls back to sell.best when p05 is null",
      quote: { sell: { best: 5.1, p05: null }, buy: { best: 4.9, p05: 4.61 } },
      mode: "sell_p05",
      expected: 5.1,
    },
    {
      label: "buy_p05 falls back to buy.best when p05 is null",
      quote: { sell: { best: 5.1, p05: 5.44 }, buy: { best: 4.9, p05: null } },
      mode: "buy_p05",
      expected: 4.9,
    },
    {
      label: "sell_best returns null when sell.best is null (no further fallback)",
      quote: { sell: { best: null, p05: 5.44 }, buy: { best: 4.9, p05: 4.61 } },
      mode: "sell_best",
      expected: null,
    },
    {
      label: "both sell fields null returns null",
      quote: { sell: { best: null, p05: null }, buy: { best: 4.9, p05: 4.61 } },
      mode: "sell_p05",
      expected: null,
    },
    {
      label: "undefined quote returns null",
      quote: undefined,
      mode: "sell_best",
      expected: null,
    },
  ];

  it.each(cases)("$label", ({ quote, mode, expected }) => {
    expect(selectPrice(quote, mode)).toBe(expected);
  });
});

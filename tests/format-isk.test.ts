import { describe, expect, it } from "vitest";
import { fmtIsk } from "@/app/_components/format-isk";
import { centsToIsk, MAX_MONEY_CENTS } from "@/core/payout-split";

describe("fmtIsk", () => {
  it("groups the integer part in threes and leaves the fraction alone", () => {
    expect(fmtIsk("0.00")).toBe("0.00");
    expect(fmtIsk("999.00")).toBe("999.00");
    expect(fmtIsk("1000.00")).toBe("1,000.00");
    expect(fmtIsk("4821430000.00")).toBe("4,821,430,000.00");
  });

  // The pair from the audit: left-aligned and ungrouped these are near-identical
  // glyph runs, and the larger is the shorter one on the right.
  it("separates the two amounts that used to look alike", () => {
    expect(fmtIsk("999999999.00")).toBe("999,999,999.00");
    expect(fmtIsk("1000000000.00")).toBe("1,000,000,000.00");
  });

  it("keeps a non-zero fraction verbatim", () => {
    expect(fmtIsk("1234.56")).toBe("1,234.56");
  });

  /**
   * The reason this formats a string rather than a number. `centsToIsk` is
   * bigint arithmetic all the way to the wire — the column is `numeric(20,2)`
   * and drizzle hands it back as text — so any formatter that reaches for
   * `Number()` starts rounding several digits before the ceiling the schema
   * actually allows, and renders an ISK figure the database does not hold.
   * Asserting against the round-trip through `Number` rather than a hardcoded
   * string so this fails loudly if the implementation ever grows one.
   */
  it("is exact past 2^53, where Number() is not", () => {
    const max = centsToIsk(MAX_MONEY_CENTS);
    expect(max).toBe("999999999999999999.99");
    expect(fmtIsk(max)).toBe("999,999,999,999,999,999.99");
    expect(String(Number(max))).not.toBe(max);

    // 2^53 + 1 in whole ISK: the first integer Number() cannot represent.
    expect(fmtIsk("9007199254740993.00")).toBe("9,007,199,254,740,993.00");
  });

  it("passes anything that isn't a decimal amount through untouched", () => {
    expect(fmtIsk("")).toBe("");
    expect(fmtIsk("—")).toBe("—");
    expect(fmtIsk("1e21")).toBe("1e21");
  });

  it("groups a negative amount without eating the sign", () => {
    expect(fmtIsk("-1234567.89")).toBe("-1,234,567.89");
  });
});

import { describe, expect, it } from "vitest";
import { parseRosterPaste } from "@/core/roster-paste";
import {
  lineTotalCents,
  MAX_LOOT_QTY,
  parseLootPaste,
  type DroppedLootLine,
  type ParsedLootLine,
} from "@/core/loot-paste";

describe("parseRosterPaste", () => {
  const cases: Array<{ label: string; input: string; expected: string[] }> = [
    {
      label: "the real slash-separated fleet paste",
      input:
        "Brain Tartare / Gustav Oswaldo / Stealthbot / Tnklstheredneck Yaken / Zodicar",
      expected: [
        "Brain Tartare",
        "Gustav Oswaldo",
        "Stealthbot",
        "Tnklstheredneck Yaken",
        "Zodicar",
      ],
    },
    {
      label: "newline-separated names",
      input: "Brain Tartare\nGustav Oswaldo\nStealthbot",
      expected: ["Brain Tartare", "Gustav Oswaldo", "Stealthbot"],
    },
    {
      label: "mixed slash and newline separators",
      input: "Brain Tartare / Gustav Oswaldo\nStealthbot / Zodicar",
      expected: ["Brain Tartare", "Gustav Oswaldo", "Stealthbot", "Zodicar"],
    },
    {
      label: "stray whitespace around names",
      input: "  Brain Tartare  /   Gustav Oswaldo  ",
      expected: ["Brain Tartare", "Gustav Oswaldo"],
    },
    {
      label: "empty segments from doubled separators are dropped",
      input: "Brain Tartare // Gustav Oswaldo /// Zodicar",
      expected: ["Brain Tartare", "Gustav Oswaldo", "Zodicar"],
    },
    {
      label: "case-insensitive dedupe keeps the first spelling seen",
      input: "Brain Tartare / brain tartare / BRAIN TARTARE",
      expected: ["Brain Tartare"],
    },
    {
      label: "empty input yields no names",
      input: "",
      expected: [],
    },
  ];

  it.each(cases)("$label", ({ input, expected }) => {
    expect(parseRosterPaste(input)).toEqual(expected);
  });
});

describe("parseLootPaste", () => {
  it("bounds quantity at the largest integer JavaScript represents exactly", () => {
    // lootItem.qty is bigint(… { mode: "number" }), so past 2^53 the value is
    // already wrong before Postgres sees it. This is a correctness bound.
    //
    // It bounds the COUNT and nothing else. It does NOT make `price * qty`
    // exact — `lineTotalCents` does, and MAX_EXACT_LINE_CENTS only caps how
    // large a single line may be. Do not read any one as covering another.
    expect(MAX_LOOT_QTY).toBe(Number.MAX_SAFE_INTEGER);
  });

  const cases: Array<{
    label: string;
    input: string;
    expected: ParsedLootLine[];
    expectedDropped?: DroppedLootLine[];
  }> = [
    {
      label: "qty-prefix format",
      input: "12x Foo",
      expected: [{ name: "Foo", qty: 12 }],
    },
    {
      label: "qty-suffix format",
      input: "Foo x12",
      expected: [{ name: "Foo", qty: 12 }],
    },
    {
      label: "tab-separated name and qty",
      input: "Foo\t12",
      expected: [{ name: "Foo", qty: 12 }],
    },
    {
      // EVE's inventory window copies a price column too. The quantity is
      // column two; reading the last numeric column would take 500,000 as the
      // quantity and overvalue this line 5000x.
      label: "tab-separated with a trailing price column",
      input: "Tritanium\t100\t500,000",
      expected: [{ name: "Tritanium", qty: 100 }],
    },
    {
      label: "tab-separated with several trailing columns",
      input: "Nyx\t1\tSupercarrier\tShip\t1,300,000.00 m3\t22,000,000,000",
      expected: [{ name: "Nyx", qty: 1 }],
    },
    {
      label: "comma-separated name and qty",
      input: "Foo, 12",
      expected: [{ name: "Foo", qty: 12 }],
    },
    {
      label: "a bare name defaults to qty 1",
      input: "Foo",
      expected: [{ name: "Foo", qty: 1 }],
    },
    {
      label: "a comma-grouped quantity parses as a single number",
      input: "1,234x Foo",
      expected: [{ name: "Foo", qty: 1234 }],
    },
    {
      label: "duplicate names across lines sum their quantities",
      input: "12x Foo\nFoo x5",
      expected: [{ name: "Foo", qty: 17 }],
    },
    {
      label: "blank lines are skipped, and are not reported as dropped",
      input: "12x Foo\n\nFoo x5",
      expected: [{ name: "Foo", qty: 17 }],
    },
    {
      label: "a whitespace-only line is skipped, and is not reported as dropped",
      input: "12x Foo\n   \nFoo x5",
      expected: [{ name: "Foo", qty: 17 }],
    },
    {
      // A DB row with qty 0 would violate loot_item_qty_ck; still dropped,
      // same as any other junk line, but now reported so the page can name it.
      label: "a zero quantity line is dropped and reported",
      input: "0x Foo\n12x Bar",
      expected: [{ name: "Bar", qty: 12 }],
      expectedDropped: [{ line: "0x Foo", reason: "zero-quantity" }],
    },
    {
      label: "a name whose lines all sum to zero is reported once, on its first line",
      input: "0x Foo\n0x Foo",
      expected: [],
      expectedDropped: [{ line: "0x Foo", reason: "zero-quantity" }],
    },
    {
      // Zero is dropped per ITEM, not per line: a 0x line followed by a real
      // one is just a sum, and the item survives with nothing reported.
      label: "a zero line that a later line makes positive is not dropped at all",
      input: "0x Foo\n2x Foo",
      expected: [{ name: "Foo", qty: 2 }],
    },
    {
      // Previously absorbed as an item literally NAMED "12", which became a
      // zero-priced unresolved row rather than an obvious mistake.
      label: "a line that is only a quantity is dropped and reported",
      input: "12\n12x Foo",
      expected: [{ name: "Foo", qty: 12 }],
      expectedDropped: [{ line: "12", reason: "quantity-only" }],
    },
    {
      label: "a comma-grouped quantity-only line is dropped and reported",
      input: "1,234",
      expected: [],
      expectedDropped: [{ line: "1,234", reason: "quantity-only" }],
    },
    {
      label: "a quantity at exactly MAX_LOOT_QTY is kept",
      input: "9007199254740991x Foo",
      expected: [{ name: "Foo", qty: 9007199254740991 }],
    },
    {
      label: "a quantity past MAX_LOOT_QTY is dropped and reported",
      input: "9007199254740992x Foo\n3x Bar",
      expected: [{ name: "Bar", qty: 3 }],
      expectedDropped: [{ line: "9007199254740992x Foo", reason: "quantity-too-large" }],
    },
    {
      label: "quantities that only together exceed MAX_LOOT_QTY drop the item",
      input: "9007199254740991x Foo\n1x Foo",
      expected: [],
      expectedDropped: [{ line: "9007199254740991x Foo", reason: "quantity-too-large" }],
    },
    {
      // DELIBERATE: "12xFoo" with no separator stays a literal name. Reading
      // it as "12 of Foo" guesses at intent, and an "x" with no separator is
      // genuinely ambiguous against real EVE type names. Nobody "fix" this.
      label: "a qty prefix with no separator stays a literal name",
      input: "12xFoo",
      expected: [{ name: "12xFoo", qty: 1 }],
    },
  ];

  it.each(cases)("$label", ({ input, expected, expectedDropped }) => {
    expect(parseLootPaste(input)).toEqual({
      items: expected,
      dropped: expectedDropped ?? [],
    });
  });
});

describe("lineTotalCents", () => {
  const cases: Array<{ label: string; price: number; qty: number; expected: bigint }> = [
    {
      // The case a float gets wrong: `48804.84 * 1845177173 * 100` is
      // 9005357669991731 in IEEE-754, one cent under the true total, and it
      // sits below MAX_EXACT_LINE_CENTS so no bound catches it.
      label: "a total the float multiply rounds a cent low",
      price: 48804.84,
      qty: 1845177173,
      expected: 9005357669991732n,
    },
    {
      // Rounding happens once, at the line total — not per unit. Per-unit
      // rounding would store 0.00 for a line genuinely worth 40,000 ISK.
      label: "a sub-cent unit price over a large quantity",
      price: 0.004,
      qty: 10000000,
      expected: 4000000n,
    },
    {
      // Small enough that JavaScript prints it in exponential form, which a
      // naive split on "." misparses into a wildly wrong integer.
      label: "a price JavaScript prints as an exponent",
      price: 1e-7,
      qty: 1000000000,
      expected: 10000n,
    },
    {
      // Half away from zero, matching the Math.round tie-break it replaced, so
      // the only totals that move are the ones the float got wrong.
      label: "a half-cent total, rounded away from zero",
      price: 0.005,
      qty: 1,
      expected: 1n,
    },
    { label: "an exact whole-cent total", price: 12.34, qty: 3, expected: 3702n },
    { label: "a zero price", price: 0, qty: 5, expected: 0n },
  ];

  it.each(cases)("computes $label", ({ price, qty, expected }) => {
    expect(lineTotalCents(price, qty)).toBe(expected);
  });
});

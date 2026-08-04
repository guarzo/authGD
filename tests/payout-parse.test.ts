import { describe, expect, it } from "vitest";
import { parseRosterPaste } from "@/core/roster-paste";
import { parseLootPaste, type ParsedLootLine } from "@/core/loot-paste";

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
  const cases: Array<{ label: string; input: string; expected: ParsedLootLine[] }> = [
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
      label: "blank lines are skipped",
      input: "12x Foo\n\nFoo x5",
      expected: [{ name: "Foo", qty: 17 }],
    },
    {
      label: "a whitespace-only line is skipped",
      input: "12x Foo\n   \nFoo x5",
      expected: [{ name: "Foo", qty: 17 }],
    },
    {
      // A DB row with qty 0 would violate loot_item_qty_ck; dropped here,
      // same as any other junk line, rather than surfacing as a raw
      // constraint error later.
      label: "a zero quantity line is dropped",
      input: "0x Foo\n12x Bar",
      expected: [{ name: "Bar", qty: 12 }],
    },
    {
      label: "a name whose lines all sum to zero is dropped entirely",
      input: "0x Foo\n0x Foo",
      expected: [],
    },
  ];

  it.each(cases)("$label", ({ input, expected }) => {
    expect(parseLootPaste(input)).toEqual(expected);
  });
});

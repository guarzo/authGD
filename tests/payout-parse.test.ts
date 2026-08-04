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
  ];

  it.each(cases)("$label", ({ input, expected }) => {
    expect(parseLootPaste(input)).toEqual(expected);
  });
});

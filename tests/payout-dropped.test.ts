import { describe, expect, it } from "vitest";
import {
  DROPPED_SAMPLE_LIMIT,
  decodeDropped,
  encodeDropped,
} from "@/app/payouts/dropped";
import type { DroppedLootLine } from "@/core/loot-paste";

const line = (n: number): DroppedLootLine => ({
  line: `Bad Line ${n}`,
  reason: "zero-quantity",
});

describe("encodeDropped / decodeDropped", () => {
  it("round-trips a short report intact", () => {
    const dropped: DroppedLootLine[] = [
      { line: "Tritanium\t0", reason: "zero-quantity" },
      { line: "12", reason: "quantity-only" },
      { line: "Nyx\t99999999999999999999", reason: "quantity-too-large" },
    ];
    expect(decodeDropped(encodeDropped(dropped))).toEqual({
      total: 3,
      sample: dropped,
    });
  });

  // A 200-line paste can drop more items than a query string should carry.
  // The COUNT must stay exact even when the detail is truncated, or the notice
  // under-reports how much of the paste was ignored — which is the one number
  // an operator uses to decide whether to re-paste.
  it("keeps the total exact while truncating the named sample", () => {
    const dropped = Array.from({ length: DROPPED_SAMPLE_LIMIT + 7 }, (_, i) => line(i));
    const report = decodeDropped(encodeDropped(dropped));
    expect(report?.total).toBe(DROPPED_SAMPLE_LIMIT + 7);
    expect(report?.sample).toHaveLength(DROPPED_SAMPLE_LIMIT);
    expect(report?.sample[0]).toEqual(line(0));
  });

  it("truncates an absurdly long line rather than shipping it whole", () => {
    const report = decodeDropped(
      encodeDropped([{ line: "x".repeat(5000), reason: "quantity-only" }]),
    );
    expect(report?.sample[0].line.length).toBeLessThanOrEqual(120);
  });

  // Same rule the ERRORS map already follows for an unrecognized ?error= code
  // (e2e/account.spec.ts:34): a hand-typed or truncated param degrades to the
  // plain page, never to an empty or half-rendered notice.
  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["not base64url", "!!!!"],
    ["base64url of non-JSON", Buffer.from("nope", "utf8").toString("base64url")],
    ["JSON of the wrong shape", Buffer.from('{"a":1}', "utf8").toString("base64url")],
    ["a zero total", Buffer.from('{"total":0}', "utf8").toString("base64url")],
  ])("returns null for %s", (_label, raw) => {
    expect(decodeDropped(raw)).toBeNull();
  });

  it("drops a sample entry whose reason is not one this page can explain", () => {
    const raw = Buffer.from(
      JSON.stringify({
        total: 2,
        sample: [
          { line: "ok line", reason: "zero-quantity" },
          { line: "bad", reason: "made-up-reason" },
        ],
      }),
      "utf8",
    ).toString("base64url");
    expect(decodeDropped(raw)).toEqual({
      total: 2,
      sample: [{ line: "ok line", reason: "zero-quantity" }],
    });
  });
});

import { describe, expect, it } from "vitest";
import { DROPPED_SAMPLE_LIMIT } from "@/app/payouts/dropped";
import { decodeUnresolved, encodeUnresolved } from "@/app/payouts/unresolved";

describe("encodeUnresolved / decodeUnresolved", () => {
  it("round-trips a short report intact", () => {
    const names = ["Bobb Pilot", "Ghost Pilot"];
    expect(decodeUnresolved(encodeUnresolved(names))).toEqual({
      total: 2,
      sample: names,
    });
  });

  // A long roster paste can leave more names unresolved than a query string
  // should carry. The COUNT must stay exact even when the list is truncated,
  // or the notice under-reports how many names need a second look — which is
  // the one number an operator uses to decide whether to check the whole
  // roster.
  it("keeps the total exact while truncating the named sample", () => {
    const names = Array.from(
      { length: DROPPED_SAMPLE_LIMIT + 5 },
      (_, i) => `Pilot ${i}`,
    );
    const report = decodeUnresolved(encodeUnresolved(names));
    expect(report?.total).toBe(DROPPED_SAMPLE_LIMIT + 5);
    expect(report?.sample).toHaveLength(DROPPED_SAMPLE_LIMIT);
    expect(report?.sample[0]).toBe("Pilot 0");
  });

  it("truncates an absurdly long name rather than shipping it whole", () => {
    const report = decodeUnresolved(encodeUnresolved(["x".repeat(5000)]));
    expect(report?.sample[0].length).toBeLessThanOrEqual(120);
  });

  it("does not deduplicate two unresolved names sharing a spelling", () => {
    const report = decodeUnresolved(encodeUnresolved(["Ghost Pilot", "Ghost Pilot"]));
    expect(report?.sample).toEqual(["Ghost Pilot", "Ghost Pilot"]);
  });

  // Same rule the ERRORS map already follows for an unrecognized ?error= code
  // (e2e/account.spec.ts:34), and the one `decodeDropped` follows for its own
  // param: a hand-typed or truncated param degrades to the plain page, never
  // to an empty or half-rendered notice.
  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["not base64url", "!!!!"],
    ["base64url of non-JSON", Buffer.from("nope", "utf8").toString("base64url")],
    ["JSON of the wrong shape", Buffer.from('{"a":1}', "utf8").toString("base64url")],
    ["a zero total", Buffer.from('{"total":0}', "utf8").toString("base64url")],
  ])("returns null for %s", (_label, raw) => {
    expect(decodeUnresolved(raw)).toBeNull();
  });

  it("drops a sample entry that is not a string", () => {
    const raw = Buffer.from(
      JSON.stringify({ total: 2, sample: ["Bobb Pilot", 12345] }),
      "utf8",
    ).toString("base64url");
    expect(decodeUnresolved(raw)).toEqual({ total: 2, sample: ["Bobb Pilot"] });
  });
});

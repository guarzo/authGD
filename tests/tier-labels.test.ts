import { describe, expect, it } from "vitest";
import { resolveTierLabel } from "@/core/tier-labels";

const LABELS = {
  member: "Pilot",
  associate: "Cadet",
  alumni: "Veteran",
  pending: "Pending",
};

describe("resolveTierLabel", () => {
  it("returns the configured label for a known tier", () => {
    expect(resolveTierLabel("member", LABELS)).toBe("Pilot");
    expect(resolveTierLabel("associate", LABELS)).toBe("Cadet");
    expect(resolveTierLabel("alumni", LABELS)).toBe("Veteran");
    expect(resolveTierLabel("pending", LABELS)).toBe("Pending");
  });

  // Pre-rename audit rows store the old vocabulary verbatim and
  // reach this function as plain strings with no entry in the label map.
  it("returns the raw string for a legacy tier value", () => {
    expect(resolveTierLabel("flygd", LABELS)).toBe("flygd");
  });

  it("returns the raw string for anything else unrecognised", () => {
    expect(resolveTierLabel("", LABELS)).toBe("");
    expect(resolveTierLabel("nonsense", LABELS)).toBe("nonsense");
  });

  // An empty configured label would render a blank badge, which reads as a
  // rendering bug rather than as configuration. Fall back to the raw value.
  it("falls back to the raw value when the configured label is empty", () => {
    expect(resolveTierLabel("member", { ...LABELS, member: "" })).toBe("member");
  });
});

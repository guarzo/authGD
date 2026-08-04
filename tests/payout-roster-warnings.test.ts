import { describe, expect, it } from "vitest";
import {
  deriveRosterWarnings,
  type RosterWarningRow,
} from "@/app/payouts/[id]/roster-warnings";

const unresolved = (displayName: string): RosterWarningRow => ({
  displayName,
  accountId: null,
});
const resolved = (displayName: string, accountId = "acc-1"): RosterWarningRow => ({
  displayName,
  accountId,
});

describe("deriveRosterWarnings", () => {
  it("reports no warnings for a roster with no name repeated across rows", () => {
    expect(
      deriveRosterWarnings([resolved("Alice"), unresolved("Bob"), resolved("Carol")]),
    ).toEqual({ duplicateUnresolvedNames: [], crossStateClashes: [] });
  });

  it("flags two unresolved rows sharing a name (the pre-existing case)", () => {
    expect(
      deriveRosterWarnings([unresolved("Ghost Pilot"), unresolved("Ghost Pilot")]),
    ).toEqual({ duplicateUnresolvedNames: ["Ghost Pilot"], crossStateClashes: [] });
  });

  it("does not flag two resolved rows sharing a name as a duplicate-unresolved case", () => {
    // Two different accounts can't legitimately share a displayName in
    // practice, but the derivation only counts accountId === null rows toward
    // duplicateUnresolvedNames, so this stays empty either way.
    expect(
      deriveRosterWarnings([resolved("Alice", "acc-1"), resolved("Alice", "acc-2")]),
    ).toEqual({ duplicateUnresolvedNames: [], crossStateClashes: [] });
  });

  it("flags a resolved row and an unresolved row sharing a name (case 1: resolved first)", () => {
    expect(
      deriveRosterWarnings([resolved("Echo Pilot"), unresolved("Echo Pilot")]),
    ).toEqual({
      duplicateUnresolvedNames: [],
      crossStateClashes: ["Echo Pilot"],
    });
  });

  it("flags an unresolved row and a resolved row sharing a name (case 2: unresolved first)", () => {
    expect(
      deriveRosterWarnings([unresolved("Echo Pilot"), resolved("Echo Pilot")]),
    ).toEqual({
      duplicateUnresolvedNames: [],
      crossStateClashes: ["Echo Pilot"],
    });
  });

  it("compares names case-insensitively, keeping the first-seen spelling", () => {
    expect(
      deriveRosterWarnings([unresolved("echo pilot"), resolved("Echo Pilot")]),
    ).toEqual({ duplicateUnresolvedNames: [], crossStateClashes: ["echo pilot"] });

    expect(
      deriveRosterWarnings([unresolved("ghost pilot"), unresolved("Ghost Pilot")]),
    ).toEqual({ duplicateUnresolvedNames: ["ghost pilot"], crossStateClashes: [] });
  });

  it("counts excluded rows — matches the pre-existing duplicate-unresolved behavior", () => {
    // The page hands over rows that carry `excluded`, and an excluded row
    // draws no share, so warning about one is mild noise. It is counted
    // anyway, deliberately: two derivations with different exclusion rules
    // would be worse than the noise. Left unannotated so the extra field is
    // not stripped by excess-property checking at the call site — this
    // exercises the real shape the page passes, not a trimmed-down one.
    const excludedRows = [
      { displayName: "Ghost Pilot", accountId: null, excluded: true },
      { displayName: "Ghost Pilot", accountId: null, excluded: true },
    ];
    expect(deriveRosterWarnings(excludedRows)).toEqual({
      duplicateUnresolvedNames: ["Ghost Pilot"],
      crossStateClashes: [],
    });
  });

  it("reports a name in both lists when three rows justify both warnings", () => {
    // Two unresolved "Bob" rows and one resolved "Bob" row: the duplicate is a
    // pair to reconcile with each other, and the cross-state clash is a
    // separate question of whether the unlinked pair is the same pilot as the
    // linked one. Neither warning subsumes the other.
    expect(
      deriveRosterWarnings([unresolved("Bob"), unresolved("Bob"), resolved("Bob")]),
    ).toEqual({ duplicateUnresolvedNames: ["Bob"], crossStateClashes: ["Bob"] });
  });

  it("preserves first-appearance order across multiple flagged names", () => {
    expect(
      deriveRosterWarnings([
        unresolved("Zeta"),
        resolved("Zeta"),
        unresolved("Alpha"),
        resolved("Alpha"),
      ]),
    ).toEqual({ duplicateUnresolvedNames: [], crossStateClashes: ["Zeta", "Alpha"] });
  });
});

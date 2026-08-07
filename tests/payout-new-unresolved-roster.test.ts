import { describe, expect, it } from "vitest";
import {
  unresolvedRosterNames,
  type UnresolvedRosterCandidate,
} from "@/app/payouts/new/unresolved-roster";

const unresolved = (displayName: string): UnresolvedRosterCandidate => ({
  displayName,
  accountId: null,
});
const resolved = (
  displayName: string,
  accountId = "acc-1",
): UnresolvedRosterCandidate => ({ displayName, accountId });

describe("unresolvedRosterNames", () => {
  it("returns nothing for an empty roster", () => {
    expect(unresolvedRosterNames([])).toEqual([]);
  });

  it("returns nothing when every entry resolved to a character", () => {
    expect(unresolvedRosterNames([resolved("Alice"), resolved("Bob")])).toEqual([]);
  });

  it("names an unresolved entry among resolved ones", () => {
    expect(
      unresolvedRosterNames([resolved("Alice"), unresolved("Bobb"), resolved("Carol")]),
    ).toEqual(["Bobb"]);
  });

  it("does not deduplicate two unresolved entries sharing a spelling", () => {
    // Two independent paste typos happening to match is not evidence they're
    // the same person — resolveRosterNames' own stance, mirrored here so the
    // report doesn't understate the row count.
    expect(
      unresolvedRosterNames([unresolved("Ghost Pilot"), unresolved("Ghost Pilot")]),
    ).toEqual(["Ghost Pilot", "Ghost Pilot"]);
  });

  it("preserves paste order", () => {
    expect(
      unresolvedRosterNames([unresolved("Zeta"), resolved("Mid"), unresolved("Alpha")]),
    ).toEqual(["Zeta", "Alpha"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  describeLabelDifference,
  encodeLabelCandidates,
  foldEqualLabels,
  matchContactLabel,
  parseLabelCandidates,
} from "@/core/contact-label";

const label = (labelId: number, labelName: string) => ({ labelId, labelName });

describe("matchContactLabel", () => {
  it("returns the exact match", () => {
    expect(matchContactLabel([label(7, "AuthGD")], "AuthGD")).toEqual({
      kind: "exact",
      labelId: 7,
    });
  });

  it("prefers an exact match over a fold-equal sibling", () => {
    expect(matchContactLabel([label(1, "AUTHGD"), label(2, "AuthGD")], "AuthGD")).toEqual(
      { kind: "exact", labelId: 2 },
    );
  });

  it("takes the exact match even when fold-equal siblings would be ambiguous", () => {
    expect(
      matchContactLabel(
        [label(1, "AUTHGD"), label(2, "authgd"), label(3, "AuthGD")],
        "AuthGD",
      ),
    ).toEqual({ kind: "exact", labelId: 3 });
  });

  it("accepts a case-only difference as a loose match", () => {
    expect(matchContactLabel([label(7, "AUTHGD")], "AuthGD")).toEqual({
      kind: "loose",
      labelId: 7,
      labelName: "AUTHGD",
    });
  });

  it("accepts leading and trailing whitespace as a loose match", () => {
    expect(matchContactLabel([label(7, "AuthGD ")], "AuthGD")).toEqual({
      kind: "loose",
      labelId: 7,
      labelName: "AuthGD ",
    });
    expect(matchContactLabel([label(7, " AuthGD")], "AuthGD")).toEqual({
      kind: "loose",
      labelId: 7,
      labelName: " AuthGD",
    });
  });

  it("accepts a combined case and whitespace difference as a loose match", () => {
    expect(matchContactLabel([label(7, " authgd ")], "AuthGD")).toEqual({
      kind: "loose",
      labelId: 7,
      labelName: " authgd ",
    });
  });

  // diffContacts deletes under the id this returns, so a loose match must carry
  // the member's OWN label id verbatim — there is no id for the configured name.
  it("carries the member's own label id on a loose match", () => {
    expect(matchContactLabel([label(4, "Blues"), label(9, "authgd")], "AuthGD")).toEqual({
      kind: "loose",
      labelId: 9,
      labelName: "authgd",
    });
  });

  it("refuses to choose between two fold-equal candidates", () => {
    expect(matchContactLabel([label(1, "authgd"), label(2, "AUTHGD")], "AuthGD")).toEqual(
      {
        kind: "ambiguous",
        candidates: ["AUTHGD", "authgd"],
      },
    );
  });

  it("tolerates whitespace in the configured value", () => {
    expect(matchContactLabel([label(7, "AUTHGD")], " AuthGD ")).toEqual({
      kind: "loose",
      labelId: 7,
      labelName: "AUTHGD",
    });
  });

  it("still refuses a label that differs by an internal whitespace run", () => {
    expect(matchContactLabel([label(7, "Auth  GD")], "Auth GD")).toEqual({
      kind: "absent",
    });
  });

  it("is absent when nothing folds equal", () => {
    expect(matchContactLabel([label(7, "Blues")], "AuthGD")).toEqual({
      kind: "absent",
    });
  });

  it("is absent for an empty label list", () => {
    expect(matchContactLabel([], "AuthGD")).toEqual({ kind: "absent" });
  });
});

describe("label candidate encoding", () => {
  const roundTrip = (candidates: string[]) =>
    parseLabelCandidates(encodeLabelCandidates(candidates));

  it("round-trips names containing the legacy comma delimiter", () => {
    expect(roundTrip(["Auth, GD", "auth, gd"])).toEqual(["Auth, GD", "auth, gd"]);
  });

  it("round-trips surrounding and repeated whitespace", () => {
    expect(roundTrip([" AuthGD", "Auth  GD", "AuthGD "])).toEqual([
      " AuthGD",
      "Auth  GD",
      "AuthGD ",
    ]);
  });

  it("reads a pre-JSON row as the legacy delimiter split", () => {
    expect(parseLabelCandidates("AUTHGD, authgd ")).toEqual(["AUTHGD", "authgd "]);
  });

  // JSON.parse accepts scalars and objects too, so "is it JSON" is not enough
  // of a check: only an array of strings may be trusted as candidate names.
  it("rejects JSON that is not an array of strings", () => {
    expect(parseLabelCandidates("42")).toEqual(["42"]);
    expect(parseLabelCandidates('{"a":1}')).toEqual(['{"a":1}']);
    expect(parseLabelCandidates("[1,2]")).toEqual(["[1,2]"]);
  });

  it("reads null and empty as no candidates", () => {
    expect(parseLabelCandidates(null)).toEqual([]);
    expect(parseLabelCandidates("")).toEqual([]);
  });
});

describe("describeLabelDifference", () => {
  it("reports a pure case difference", () => {
    expect(describeLabelDifference("AUTHGD", "AuthGD")).toBe("case");
  });

  it("reports a pure spacing difference", () => {
    expect(describeLabelDifference("AuthGD ", "AuthGD")).toBe("spacing");
    expect(describeLabelDifference(" AuthGD", "AuthGD")).toBe("spacing");
    expect(describeLabelDifference("Auth  GD", "Auth GD")).toBe("spacing");
  });

  it("reports a combined case and spacing difference", () => {
    expect(describeLabelDifference(" authgd ", "AuthGD")).toBe("case-and-spacing");
  });

  it("falls back to other when the strings differ on more than case and spacing", () => {
    expect(describeLabelDifference("Blues", "AuthGD")).toBe("other");
  });

  it("falls back to other for a candidate that is already exactly equal", () => {
    expect(describeLabelDifference("AuthGD", "AuthGD")).toBe("other");
  });
});

describe("foldEqualLabels", () => {
  it("is true for case and surrounding whitespace differences", () => {
    expect(foldEqualLabels("AUTHGD", "AuthGD")).toBe(true);
    expect(foldEqualLabels("AuthGD ", "AuthGD")).toBe(true);
    expect(foldEqualLabels(" authgd ", "AuthGD")).toBe(true);
  });

  // Why this helper exists at all rather than reusing describeLabelDifference:
  // that function deliberately collapses internal runs and calls this pair
  // "spacing", while the matcher only trims and reports it absent. Anything
  // deciding "will the next sync accept this?" must agree with the matcher.
  it("is false for an internal whitespace run, agreeing with matchContactLabel", () => {
    expect(foldEqualLabels("Auth  GD", "Auth GD")).toBe(false);
    expect(describeLabelDifference("Auth  GD", "Auth GD")).toBe("spacing");
    expect(matchContactLabel([label(7, "Auth  GD")], "Auth GD")).toEqual({
      kind: "absent",
    });
  });

  it("is false for names that differ by more than case and spacing", () => {
    expect(foldEqualLabels("Blues", "AuthGD")).toBe(false);
  });
});

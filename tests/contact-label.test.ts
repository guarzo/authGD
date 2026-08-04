import { describe, expect, it } from "vitest";
import { matchContactLabel } from "@/core/contact-label";

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

  it("reports a case-only difference as a near miss", () => {
    expect(matchContactLabel([label(7, "AUTHGD")], "AuthGD")).toEqual({
      kind: "near_miss",
      candidates: ["AUTHGD"],
    });
  });

  it("reports leading and trailing whitespace as a near miss", () => {
    expect(matchContactLabel([label(7, "AuthGD ")], "AuthGD")).toEqual({
      kind: "near_miss",
      candidates: ["AuthGD "],
    });
    expect(matchContactLabel([label(7, " AuthGD")], "AuthGD")).toEqual({
      kind: "near_miss",
      candidates: [" AuthGD"],
    });
  });

  it("reports combined case and whitespace differences as a near miss", () => {
    expect(matchContactLabel([label(7, " authgd ")], "AuthGD")).toEqual({
      kind: "near_miss",
      candidates: [" authgd "],
    });
  });

  it("returns every fold-equal candidate, sorted, rather than picking one", () => {
    expect(matchContactLabel([label(1, "authgd"), label(2, "AUTHGD")], "AuthGD")).toEqual(
      { kind: "near_miss", candidates: ["AUTHGD", "authgd"] },
    );
  });

  it("tolerates whitespace in the configured value", () => {
    expect(matchContactLabel([label(7, "AUTHGD")], " AuthGD ")).toEqual({
      kind: "near_miss",
      candidates: ["AUTHGD"],
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

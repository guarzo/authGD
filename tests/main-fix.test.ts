import { describe, expect, it } from "vitest";
import { mainFixCandidates, type MainFixCharacter } from "@/core/main-fix";

const ALLIANCE = 99000001;

const char = (over: Partial<MainFixCharacter> & { id: number }): MainFixCharacter => ({
  name: `char ${over.id}`,
  allianceId: ALLIANCE,
  affiliationInvalid: false,
  ...over,
});

describe("mainFixCandidates", () => {
  it("returns nothing when the main is in the alliance", () => {
    expect(
      mainFixCandidates({
        mainCharacterId: 1,
        characters: [char({ id: 1 }), char({ id: 2 })],
        allianceId: ALLIANCE,
      }),
    ).toEqual([]);
  });

  it("offers an in-alliance alt when the main is out of the alliance", () => {
    const result = mainFixCandidates({
      mainCharacterId: 1,
      characters: [char({ id: 1, allianceId: 42 }), char({ id: 2 })],
      allianceId: ALLIANCE,
    });
    expect(result.map((c) => c.id)).toEqual([2]);
  });

  it("offers an in-alliance character when there is no main at all", () => {
    const result = mainFixCandidates({
      mainCharacterId: null,
      characters: [char({ id: 1, allianceId: 42 }), char({ id: 2 })],
      allianceId: ALLIANCE,
    });
    expect(result.map((c) => c.id)).toEqual([2]);
  });

  // The inversion this predicate exists to avoid: an affiliation-invalid main
  // still carries whatever alliance id it was last read with, so keying on the
  // id alone would call this account healthy and hide the control from exactly
  // the account most likely to need it.
  it("treats an affiliation-invalid main as broken even when its stored alliance matches", () => {
    const result = mainFixCandidates({
      mainCharacterId: 1,
      characters: [char({ id: 1, affiliationInvalid: true }), char({ id: 2 })],
      allianceId: ALLIANCE,
    });
    expect(result.map((c) => c.id)).toEqual([2]);
  });

  // The asymmetry is deliberate. A main can be broken *because* it is invalid;
  // a candidate can never be trusted *despite* being invalid — its stored
  // alliance id is exactly the reading we know went stale.
  it("never offers an affiliation-invalid alt", () => {
    expect(
      mainFixCandidates({
        mainCharacterId: 1,
        characters: [
          char({ id: 1, allianceId: 42 }),
          char({ id: 2, affiliationInvalid: true }),
        ],
        allianceId: ALLIANCE,
      }),
    ).toEqual([]);
  });

  it("never offers the broken main itself", () => {
    expect(
      mainFixCandidates({
        mainCharacterId: 1,
        characters: [char({ id: 1, affiliationInvalid: true })],
        allianceId: ALLIANCE,
      }),
    ).toEqual([]);
  });

  it("returns every eligible alt, not just the first", () => {
    const result = mainFixCandidates({
      mainCharacterId: 1,
      characters: [char({ id: 1, allianceId: null }), char({ id: 2 }), char({ id: 3 })],
      allianceId: ALLIANCE,
    });
    expect(result.map((c) => c.id)).toEqual([2, 3]);
  });
});

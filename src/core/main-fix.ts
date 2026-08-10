/**
 * Which characters could be promoted to main to repair an account's tier.
 *
 * `decideTier` (core/tier.ts) reads ONLY the main's alliance: an account whose
 * main left the alliance sits at alumni, and an account whose main was never in
 * it never leaves pending, no matter how many in-alliance alts are linked. That
 * is the state this predicate detects, and promoting one of the returned
 * characters is what fixes it.
 *
 * A main is broken three ways: there isn't one, it is outside the alliance, or
 * its affiliation reading failed. The third case is why this takes
 * `affiliationInvalid` at all rather than comparing ids — an invalid character
 * still carries the alliance id it was last successfully read with, so an
 * id-only test calls the account healthy and hides the control from the account
 * most likely to need it.
 *
 * The treatment is deliberately asymmetric. A main can be broken *because* it
 * is invalid; a candidate is never offered *despite* being invalid, because a
 * candidate's whole claim is its stored alliance id and that is precisely the
 * reading we know is stale.
 *
 * Pure: no config, no database. The alliance id is passed in by the caller that
 * has one (`account-view.ts`, from `cfg.allianceId`).
 */
export interface MainFixCharacter {
  id: number;
  name: string;
  allianceId: number | null;
  affiliationInvalid: boolean;
}

export function mainFixCandidates(args: {
  mainCharacterId: number | null;
  characters: MainFixCharacter[];
  allianceId: number;
}): MainFixCharacter[] {
  const main = args.characters.find((c) => c.id === args.mainCharacterId) ?? null;
  const broken =
    main === null || main.affiliationInvalid || main.allianceId !== args.allianceId;
  if (!broken) return [];
  return args.characters.filter(
    (c) =>
      c.id !== args.mainCharacterId &&
      !c.affiliationInvalid &&
      c.allianceId === args.allianceId,
  );
}

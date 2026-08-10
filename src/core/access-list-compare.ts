/** A member character as the roster query returns it (`getMemberCharacters`). */
export type RosterCharacter = {
  characterId: number;
  name: string;
  accountId: string;
  corporationId: number | null;
  allianceId: number | null;
};

/** One membership row of an ESI access list. `access` is verbatim ESI text. */
export type AccessEntry = {
  kind: "character" | "corporation" | "alliance";
  entityId: number;
  access: string;
};

/**
 * A grant that reaches beyond the characters it names. `coveredMembers` counts
 * OUR members only — authGD holds no corp or alliance roster, so the true
 * total is unknowable from here and the page must never imply otherwise.
 */
export type BroadGrant = {
  kind: "everyone" | "corporation" | "alliance";
  entityId: number | null; // null for "everyone"
  coveredMembers: number;
};

export type AccessListComparison = {
  missingAccess: RosterCharacter[];
  nonMembers: number[];
  matched: number;
  broadGrants: BroadGrant[];
};

/**
 * Compares one access list against the member roster on EFFECTIVE access: a
 * member has access if their character is listed, OR their corporation is, OR
 * their alliance is, OR the list allows everyone.
 *
 * Deliberately not `add`/`remove` shaped like `src/core/acl-diff.ts`. The ESI
 * access-list endpoints are read-only, so that vocabulary would name a
 * mutation this feature cannot perform; every correction is an in-game action
 * a human takes.
 *
 * `nonMembers` is complete only for explicit `character` entries. A corp or
 * alliance grant may cover any number of people we cannot enumerate, so those
 * are surfaced as `broadGrants` with our own partial count instead of being
 * silently folded into a total.
 */
export function compareAccessList(input: {
  allowEveryone: boolean;
  entries: AccessEntry[];
  roster: RosterCharacter[];
}): AccessListComparison {
  const listedCharacters = new Set<number>();
  // Insertion-ordered, so broadGrants come out in a stable order for the page.
  const listedCorporations = new Set<number>();
  const listedAlliances = new Set<number>();
  for (const e of input.entries) {
    if (e.kind === "character") listedCharacters.add(e.entityId);
    else if (e.kind === "corporation") listedCorporations.add(e.entityId);
    else listedAlliances.add(e.entityId);
  }

  const hasAccess = (c: RosterCharacter): boolean =>
    input.allowEveryone ||
    listedCharacters.has(c.characterId) ||
    // null is "affiliation unknown", never a matchable id.
    (c.corporationId !== null && listedCorporations.has(c.corporationId)) ||
    (c.allianceId !== null && listedAlliances.has(c.allianceId));

  const missingAccess = input.roster.filter((c) => !hasAccess(c));

  const rosterIds = new Set(input.roster.map((c) => c.characterId));
  // Entries are unique on (list, kind, entityId) in the database, so scanning
  // them straight through cannot produce a duplicate id here.
  const nonMembers = input.entries
    .filter((e) => e.kind === "character" && !rosterIds.has(e.entityId))
    .map((e) => e.entityId);

  const broadGrants: BroadGrant[] = [];
  if (input.allowEveryone) {
    broadGrants.push({
      kind: "everyone",
      entityId: null,
      coveredMembers: input.roster.length,
    });
  }
  for (const id of listedCorporations) {
    broadGrants.push({
      kind: "corporation",
      entityId: id,
      coveredMembers: input.roster.filter((c) => c.corporationId === id).length,
    });
  }
  for (const id of listedAlliances) {
    broadGrants.push({
      kind: "alliance",
      entityId: id,
      coveredMembers: input.roster.filter((c) => c.allianceId === id).length,
    });
  }

  return {
    missingAccess,
    nonMembers,
    matched: input.roster.length - missingAccess.length,
    broadGrants,
  };
}

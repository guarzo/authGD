import { and, eq } from "drizzle-orm";
import type { Tier } from "@/core/tier";
import type { Dbx } from "@/db";
import { account, character } from "@/db/schema";

export type MemberCharacter = {
  characterId: number;
  accountId: string;
  name: string;
  refreshTokenEnc: string | null;
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  scopes: string[];
};

/**
 * The same membership test as `getMemberCharacters`, for callers that already
 * hold the rows and only need to know whether a character is in the desired
 * set. Kept next to the query so the two cannot drift: change one, change both.
 */
export function isContactsTarget(input: {
  tier: Tier;
  affiliationInvalid: boolean;
}): boolean {
  return input.tier === "member" && !input.affiliationInvalid;
}

/**
 * The derived desired set: every character of every member account (spec: Data
 * model → Derived). Alumni/associate accounts simply fall out; nothing is
 * deleted. A character with affiliation_invalid (biomassed/deleted at CCP) is
 * excluded: it can't be a valid contact target or ACL member, and ESI rejects
 * it — leaving it in would permanently poison every downstream sync that shares
 * this desired set.
 */
export async function getMemberCharacters(dbx: Dbx): Promise<MemberCharacter[]> {
  return dbx
    .select({
      characterId: character.id,
      accountId: character.accountId,
      name: character.name,
      refreshTokenEnc: character.refreshTokenEnc,
      tokenStatus: character.tokenStatus,
      scopes: character.scopes,
    })
    .from(character)
    .innerJoin(account, eq(character.accountId, account.id))
    .where(and(eq(account.tier, "member"), eq(character.affiliationInvalid, false)));
}

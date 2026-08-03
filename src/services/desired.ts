import { and, eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import { account, character } from "@/db/schema";

export type FlygdCharacter = {
  characterId: number;
  accountId: string;
  name: string;
  refreshTokenEnc: string | null;
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  scopes: string[];
};

/**
 * The same membership test as `getFlygdCharacters`, for callers that already
 * hold the rows and only need to know whether a character is in the desired
 * set. Kept next to the query so the two cannot drift: change one, change both.
 */
export function isContactsTarget(input: {
  tier: string;
  affiliationInvalid: boolean;
}): boolean {
  return input.tier === "flygd" && !input.affiliationInvalid;
}

/**
 * The derived desired set: every character of every FlyGD account (spec: Data
 * model → Derived). Green/Blue accounts simply fall out; nothing is deleted.
 * A character with affiliation_invalid (biomassed/deleted at CCP) is excluded:
 * it can't be a valid contact target or ACL member, and ESI rejects it —
 * leaving it in would permanently poison every downstream sync that shares
 * this desired set.
 */
export async function getFlygdCharacters(dbx: Dbx): Promise<FlygdCharacter[]> {
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
    .where(and(eq(account.tier, "flygd"), eq(character.affiliationInvalid, false)));
}

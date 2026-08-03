import { eq } from "drizzle-orm";
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
 * The derived desired set: every character of every FlyGD account (spec: Data
 * model → Derived). Green/Blue accounts simply fall out; nothing is deleted.
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
    .where(eq(account.tier, "flygd"));
}

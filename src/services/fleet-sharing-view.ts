import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { account, character } from "@/db/schema";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";

export type FleetSharingCharacter = {
  characterId: number;
  characterName: string;
  hasFleetRead: boolean;
  tokenUsable: boolean;
};

/** Setup is a DB-only projection. Never serialize credentials or refresh them
 * during a page render, even when the stored grant needs attention. */
export async function getFleetSharingSetup(db: Db, accountId: string) {
  const rows = await db
    .select({
      tier: account.tier,
      isAdmin: account.isAdmin,
      characterId: character.id,
      characterName: character.name,
      hasFleetRead: sql<boolean>`${character.scopes} @> ${JSON.stringify([FLEET_READ_SCOPE])}::jsonb`,
      tokenUsable: sql<boolean>`${character.refreshTokenEnc} IS NOT NULL AND ${character.tokenStatus} NOT IN ('invalid', 'missing')`,
    })
    .from(account)
    .leftJoin(character, eq(character.accountId, account.id))
    .where(eq(account.id, accountId))
    .orderBy(asc(character.id));
  const characters: FleetSharingCharacter[] = rows.flatMap((row) =>
    row.characterId === null || row.characterName === null
      ? []
      : [
          {
            characterId: row.characterId,
            characterName: row.characterName,
            hasFleetRead: row.hasFleetRead,
            tokenUsable: row.tokenUsable,
          },
        ],
  );
  // A callback returns to a fixed URL. Prefer a usable grant, not an unrelated
  // main; ties retain the stable character order without new account settings.
  characters.sort(
    (a, b) =>
      Number(b.hasFleetRead && b.tokenUsable) - Number(a.hasFleetRead && a.tokenUsable),
  );
  return {
    eligible: rows[0]?.tier === "member",
    isAdmin: rows[0]?.isAdmin ?? false,
    characters,
  };
}

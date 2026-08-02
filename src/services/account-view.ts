import { eq, inArray } from "drizzle-orm";
import type { Config } from "@/config";
import type { Dbx } from "@/db";
import {
  account,
  character,
  contactSyncState,
  discordLink,
  wandererAclObservation,
} from "@/db/schema";

export interface AccountView {
  tier: "flygd" | "blue" | "green";
  status: "active" | "cryo";
  isAdmin: boolean;
  mainCharacterId: number | null;
  discordLinked: boolean;
  characters: Array<{
    id: number;
    name: string;
    isMain: boolean;
    tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
    needsReauthForScopes: boolean;
    contactSyncResult: string | null;
    onMapAcl: boolean;
  }>;
}

export async function getAccountView(
  dbx: Dbx,
  cfg: Config,
  accountId: string,
): Promise<AccountView> {
  const [acc] = await dbx.select().from(account).where(eq(account.id, accountId));
  if (!acc) throw new Error("account not found");
  const chars = await dbx
    .select()
    .from(character)
    .where(eq(character.accountId, accountId));
  const ids = chars.map((c) => c.id);
  const [links, syncStates, aclObs] = await Promise.all([
    dbx.select().from(discordLink).where(eq(discordLink.accountId, accountId)),
    ids.length
      ? dbx.select().from(contactSyncState).where(inArray(contactSyncState.characterId, ids))
      : Promise.resolve([]),
    ids.length
      ? dbx
          .select()
          .from(wandererAclObservation)
          .where(inArray(wandererAclObservation.characterId, ids))
      : Promise.resolve([]),
  ]);
  const syncByChar = new Map(syncStates.map((s) => [s.characterId, s]));
  const aclSet = new Set(aclObs.map((o) => o.characterId));
  const required = new Set(cfg.eveSso.scopes);

  return {
    tier: acc.tier,
    status: acc.status,
    isAdmin: acc.isAdmin,
    mainCharacterId: acc.mainCharacterId,
    discordLinked: links.length > 0,
    characters: chars.map((c) => ({
      id: c.id,
      name: c.name,
      isMain: acc.mainCharacterId === c.id,
      tokenStatus: c.tokenStatus,
      needsReauthForScopes: [...required].some((s) => !c.scopes.includes(s)),
      contactSyncResult: syncByChar.get(c.id)?.lastResult ?? null,
      onMapAcl: aclSet.has(c.id),
    })),
  };
}

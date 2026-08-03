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
      ? dbx
          .select()
          .from(contactSyncState)
          .where(inArray(contactSyncState.characterId, ids))
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

export interface AdminCharacterRow {
  id: number;
  name: string;
  isMain: boolean;
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  needsReauthForScopes: boolean;
  affiliationInvalid: boolean;
  contactSyncResult: string | null;
  mapObservedAt: Date | null;
}

export interface AdminAccountRow {
  accountId: string;
  isAdmin: boolean;
  tier: "flygd" | "blue" | "green";
  tierLocked: boolean;
  tierChangedAt: Date | null;
  tierChangedByName: string | null;
  status: "active" | "cryo";
  statusChangedAt: Date | null;
  statusNote: string | null;
  lastLoginAt: Date | null;
  mainName: string | null;
  discordLinked: boolean;
  characters: AdminCharacterRow[];
  tokenSummary: { total: number; healthy: number; needsReauth: number; dead: number };
  mapCount: number;
}

export type AdminListSort = "name" | "tier" | "status" | "tierChangedAt";

export interface AdminListFilters {
  tier?: "flygd" | "blue" | "green";
  status?: "active" | "cryo";
  sort?: AdminListSort;
  dir?: "asc" | "desc";
}

const TIER_RANK = { flygd: 0, blue: 1, green: 2 } as const;

export async function getAdminAccountsList(
  dbx: Dbx,
  cfg: Config,
  filters: AdminListFilters = {},
): Promise<AdminAccountRow[]> {
  const [accounts, chars, links, syncStates, aclObs] = await Promise.all([
    dbx.select().from(account),
    dbx.select().from(character),
    dbx.select().from(discordLink),
    dbx.select().from(contactSyncState),
    dbx.select().from(wandererAclObservation),
  ]);
  const required = cfg.eveSso.scopes;
  const charsByAccount = new Map<string, typeof chars>();
  for (const c of chars) {
    const list = charsByAccount.get(c.accountId) ?? [];
    list.push(c);
    charsByAccount.set(c.accountId, list);
  }
  const linked = new Set(links.map((l) => l.accountId));
  const syncByChar = new Map(syncStates.map((s) => [s.characterId, s]));
  const obsByChar = new Map(aclObs.map((o) => [o.characterId, o]));
  const nameById = new Map(chars.map((c) => [c.id, c.name]));
  const mainNameOf = new Map(
    accounts.map((a) => [
      a.id,
      a.mainCharacterId === null ? null : (nameById.get(a.mainCharacterId) ?? null),
    ]),
  );

  let rows: AdminAccountRow[] = accounts.map((acc) => {
    const accChars = charsByAccount.get(acc.id) ?? [];
    const characters: AdminCharacterRow[] = accChars.map((c) => ({
      id: c.id,
      name: c.name,
      isMain: acc.mainCharacterId === c.id,
      tokenStatus: c.tokenStatus,
      needsReauthForScopes: required.some((s) => !c.scopes.includes(s)),
      affiliationInvalid: c.affiliationInvalid,
      contactSyncResult: syncByChar.get(c.id)?.lastResult ?? null,
      mapObservedAt: obsByChar.get(c.id)?.observedAt ?? null,
    }));
    const dead = characters.filter(
      (c) => c.tokenStatus === "invalid" || c.tokenStatus === "missing",
    ).length;
    const needsReauth = characters.filter(
      (c) =>
        c.tokenStatus !== "invalid" &&
        c.tokenStatus !== "missing" &&
        (c.tokenStatus === "needs_reauth" || c.needsReauthForScopes),
    ).length;
    return {
      accountId: acc.id,
      isAdmin: acc.isAdmin,
      tier: acc.tier,
      tierLocked: acc.tierLocked,
      tierChangedAt: acc.tierChangedAt,
      tierChangedByName:
        acc.tierChangedBy === null
          ? null
          : acc.tierChangedBy === "system"
            ? "system"
            : (mainNameOf.get(acc.tierChangedBy) ?? acc.tierChangedBy),
      status: acc.status,
      statusChangedAt: acc.statusChangedAt,
      statusNote: acc.statusNote,
      lastLoginAt: acc.lastLoginAt,
      mainName: mainNameOf.get(acc.id) ?? null,
      discordLinked: linked.has(acc.id),
      characters,
      tokenSummary: {
        total: characters.length,
        healthy: characters.length - dead - needsReauth,
        needsReauth,
        dead,
      },
      mapCount: characters.filter((c) => c.mapObservedAt !== null).length,
    };
  });

  if (filters.tier) rows = rows.filter((r) => r.tier === filters.tier);
  if (filters.status) rows = rows.filter((r) => r.status === filters.status);

  const dir = filters.dir === "desc" ? -1 : 1;
  const sort = filters.sort ?? "name";
  // Null placement ("no main", never-changed) is decided BEFORE direction is
  // applied: those rows sort last whether asc or desc.
  const nameCompare = (a: AdminAccountRow, b: AdminAccountRow): number => {
    const nulls = (a.mainName === null ? 1 : 0) - (b.mainName === null ? 1 : 0);
    if (nulls !== 0) return nulls;
    if (a.mainName === null || b.mainName === null) return 0;
    return a.mainName.toLowerCase().localeCompare(b.mainName.toLowerCase()) * dir;
  };
  rows.sort((a, b) => {
    if (sort === "name") return nameCompare(a, b);
    if (sort === "tierChangedAt") {
      const nulls =
        (a.tierChangedAt === null ? 1 : 0) - (b.tierChangedAt === null ? 1 : 0);
      if (nulls !== 0) return nulls;
      const cmp =
        a.tierChangedAt && b.tierChangedAt
          ? a.tierChangedAt.getTime() - b.tierChangedAt.getTime()
          : 0;
      return cmp * dir || nameCompare(a, b);
    }
    const cmp =
      sort === "tier"
        ? TIER_RANK[a.tier] - TIER_RANK[b.tier]
        : (a.status === "cryo" ? 1 : 0) - (b.status === "cryo" ? 1 : 0);
    return cmp * dir || nameCompare(a, b);
  });
  return rows;
}

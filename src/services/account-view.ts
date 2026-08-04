import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { Config } from "@/config";
import { nextRunAt } from "@/core/schedules";
import type { Dbx } from "@/db";
import {
  account,
  character,
  contactSyncState,
  discordLink,
  syncRun,
  wandererAclObservation,
} from "@/db/schema";
import { isContactsTarget } from "@/services/desired";

/**
 * The three things authGD pushes on a member's behalf, and the job that pushes
 * each one.
 *
 * Sourced from `sync_run` rather than from per-character state, which reads
 * like the more precise choice and is not:
 *
 * - `contact_sync_state` is keyed by the FLYGD character whose contact list is
 *   written (src/jobs/contacts.ts). A blue or green member is the *content* of
 *   that push, never a target, so their rows are structurally absent — a
 *   per-character aggregate would tell most of the corp "never run" forever.
 * - `wanderer_acl_observation` is a delete-and-replace snapshot of current ACL
 *   membership. A character legitimately off the ACL has no row, which is
 *   indistinguishable from a job that has not run.
 * - `audit_log` records role *changes*. A member whose roles have been correct
 *   for a month has no recent entry, and "last changed" is not "last checked".
 *
 * The job's own completion is the honest answer to "when did this last get
 * pushed", and it is true for every member regardless of tier.
 *
 * The cadence is not restated here: `JOB_CRON` is keyed by the same job type,
 * so the "next check" the member reads is the expression the worker registers
 * with pg-boss rather than a second copy that can rot.
 */
const PUSH_JOBS = {
  standings: "contacts",
  map: "wanderer",
  discord: "discord-roles",
} as const;

export type PushKind = keyof typeof PUSH_JOBS;

export interface PushStatus {
  /** Completion of the newest run that pushed something. Null = never yet. */
  lastPushedAt: Date | null;
  /** Next scheduled fire, or null if the cadence is unresolvable. */
  nextCheckAt: Date | null;
}

/**
 * "partial" counts as pushed: some members were written even though others
 * failed, and claiming nothing happened would be the larger lie. "failed"
 * does not, so a broken job visibly stops advancing rather than reporting
 * freshness it did not deliver.
 */

export async function getPushStatus(
  dbx: Dbx,
  now: Date = new Date(),
): Promise<Record<PushKind, PushStatus>> {
  const entries = Object.entries(PUSH_JOBS) as Array<
    [PushKind, (typeof PUSH_JOBS)[PushKind]]
  >;
  const results = await Promise.all(
    entries.map(async ([kind, jobType]) => {
      // Newest by serial id, matching the (job_type, id desc) index and the
      // reasoning in services/health.ts — never max(finished_at).
      const [row] = await dbx
        .select({ finishedAt: syncRun.finishedAt })
        .from(syncRun)
        .where(
          and(
            eq(syncRun.jobType, jobType),
            isNotNull(syncRun.finishedAt),
            or(eq(syncRun.status, "ok"), eq(syncRun.status, "partial")),
          ),
        )
        .orderBy(desc(syncRun.id))
        .limit(1);
      const status: PushStatus = {
        lastPushedAt: row?.finishedAt ?? null,
        // `nextRunAt` owns the degradation: an unknown job type or an
        // unsupported cadence becomes "we don't know when" — the null
        // `nextCheckAt` already renders as an absent "next" — rather than
        // throwing and taking the whole account page down over a decoration.
        nextCheckAt: nextRunAt(jobType, now),
      };
      return [kind, status] as const;
    }),
  );
  return Object.fromEntries(results) as Record<PushKind, PushStatus>;
}

export interface AccountView {
  tier: "pending" | "flygd" | "blue" | "green";
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
    /**
     * Whether the contacts job writes THIS character's contact list, i.e.
     * whether it is in `getFlygdCharacters`. False for every blue and green
     * member — their standing is the content of someone else's push, never a
     * target — and for a character CCP reports as gone.
     *
     * Without this, `contactSyncResult` is structurally null for most of the
     * corp and the page reads that absence as "not yet run" forever.
     */
    contactsTarget: boolean;
    /**
     * Widened from `ContactSyncResult` on purpose. The column is narrowed with
     * `$type<>()`, which constrains the writer at compile time but puts no
     * constraint on the database: a row written by an older deployment, or by
     * hand, can hold a code this build has never heard of. Handing readers the
     * union would let a `switch` look exhaustive when it is not, and would make
     * the deliberate "unrecognized result" branch in ContactRemedy read as dead
     * code somebody then deletes. `string` is the honest type for a value that
     * crossed the database boundary. See src/core/contact-result.ts.
     */
    contactSyncResult: string | null;
    /** Context for `contactSyncResult` — the label name(s) actually found when
     *  the result is `label_mismatch`, else null. */
    contactSyncDetail: string | null;
    onMapAcl: boolean;
  }>;
  pushes: Record<PushKind, PushStatus>;
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
  const [links, syncStates, aclObs, pushes] = await Promise.all([
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
    getPushStatus(dbx),
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
      contactsTarget: isContactsTarget({
        tier: acc.tier,
        affiliationInvalid: c.affiliationInvalid,
      }),
      contactSyncResult: syncByChar.get(c.id)?.lastResult ?? null,
      contactSyncDetail: syncByChar.get(c.id)?.lastDetail ?? null,
      onMapAcl: aclSet.has(c.id),
    })),
    pushes,
  };
}

export interface AdminCharacterRow {
  id: number;
  name: string;
  isMain: boolean;
  tokenStatus: "valid" | "invalid" | "needs_reauth" | "missing";
  needsReauthForScopes: boolean;
  affiliationInvalid: boolean;
  /** Widened from `ContactSyncResult` for the reason given on the member-facing
   *  field above: this value crossed the database boundary. */
  contactSyncResult: string | null;
  contactSyncDetail: string | null;
  mapObservedAt: Date | null;
}

export interface AdminAccountRow {
  accountId: string;
  isAdmin: boolean;
  tier: "pending" | "flygd" | "blue" | "green";
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
  tier?: "pending" | "flygd" | "blue" | "green";
  status?: "active" | "cryo";
  sort?: AdminListSort;
  dir?: "asc" | "desc";
}

// pending ranks first: an unapproved account is the one an admin has to act
// on, so the tier-sorted view puts the queue at the top. This is NOT how an
// admin finds the queue — the table defaults to name sort — see the pending
// count link on the accounts page.
const TIER_RANK = { pending: 0, flygd: 1, blue: 2, green: 3 } as const;

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
      contactSyncDetail: syncByChar.get(c.id)?.lastDetail ?? null,
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

import type { Dbx } from "@/db";
import { JOB_CRON } from "@/core/schedules";
import { account, auditLog, character, discordLink, payoutOperation } from "@/db/schema";
import { and, desc, eq, inArray, like, lt, sql } from "drizzle-orm";

export const AUDIT_PAGE_SIZE = 100;

export async function logAudit(
  dbx: Dbx,
  entry: {
    actor: string;
    action: string;
    target: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await dbx.insert(auditLog).values(entry);
}

export type ResolvedAuditRow = typeof auditLog.$inferSelect & {
  actorName: string | null;
  actorKind: "system" | "account" | "unresolved";
  targetName: string | null;
  targetKind: "account" | "character" | "discord" | "payout" | "literal" | "unresolved";
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d+$/;

/**
 * The literal, non-id values the audit log stores: `system` as an actor (every
 * job writes it), `all` as the broadcast target of `sync.requested` /
 * `sync.recheck_requested`, and a job type as the target of a single-job
 * `sync.requested` (src/app/admin/sync/actions.ts).
 *
 * The job types are DERIVED from the schedules table rather than listed here,
 * because that table is what the re-run action validates against
 * (`isJobType`): a new scheduled job becomes a filterable target the same day
 * it becomes re-runnable, with no second list to forget. A hand-written list is
 * exactly how the `"all"`-only assumption this replaces went stale.
 *
 * These bypass name resolution in both directions — they must render as
 * `literal` (a clickable filter link on the audit page) and short-circuit as a
 * raw filter value, or filtering by them matches no character and silently
 * returns nothing.
 *
 * Reserving a string costs something: a *character* named exactly like one of
 * these can no longer be found by name, because the literal check wins before
 * any name lookup happens. So the reservation is no wider than the column it
 * is needed in. Job types are only ever written to `target` (by `sync.*`), so
 * reserving them for `actor` too would buy nothing while shadowing whatever
 * an account or character might legitimately be called there. `system` and
 * `all` stay field-agnostic: that predates this change, and narrowing them now
 * would be an unrelated behaviour change.
 */
const RESERVED_LITERALS_ANY_FIELD: ReadonlySet<string> = new Set(["system", "all"]);

/**
 * Every literal reserved *in the target column* — the union, not the
 * job-types-only remainder its name might suggest. `system` is in here by
 * inheritance and that is load-bearing, not incidental: `logAudit` writes
 * `actor: "system"` from every job, and nothing stops a future call site
 * writing `target: "system"` for a system-owned object. Were it absent, such a
 * row would fall through to name resolution, resolve to nothing, and render as
 * `unresolved` — a dead cell instead of a filter link.
 */
const RESERVED_TARGET_LITERALS: ReadonlySet<string> = new Set([
  ...RESERVED_LITERALS_ANY_FIELD,
  ...Object.keys(JOB_CRON),
]);

/**
 * Every target is written by exactly one call site shape in this codebase
 * (grep `logAudit(` across src/), so the *action* namespace is a reliable,
 * intentional signal for what a target string means — unlike its shape. An
 * EVE character id and a Discord snowflake are both bare digit strings, so
 * shape alone (or a magnitude heuristic, since snowflakes are ~18-19 digits
 * and character ids are ~9-10) would work only by coincidence today and
 * silently rot the day either numbering scheme changes. `discord.*` actions
 * only ever target a Discord user id; `character.*` / `token.*` /
 * `wanderer.*` only ever target an EVE character id; `payout.*` actions only
 * ever target a `payout_operation` uuid; everything else (`tier.*`,
 * `status.*`, `account.*`, `admin.*`, `sync.*`) targets an account.
 * The literal targets of `sync.*` (`"all"`, or a job type for a single-job
 * re-run — see RESERVED_TARGET_LITERALS) are short-circuited by the caller
 * before this function is consulted, so `sync.*` reaching here always means
 * the account-uuid form.
 */
function targetKindFromAction(
  action: string,
): "account" | "character" | "discord" | "payout" | null {
  if (action.startsWith("discord.")) return "discord";
  if (
    action.startsWith("character.") ||
    action.startsWith("token.") ||
    action.startsWith("wanderer.")
  )
    return "character";
  if (action.startsWith("payout.")) return "payout";
  if (
    action.startsWith("tier.") ||
    action.startsWith("status.") ||
    action.startsWith("account.") ||
    action.startsWith("admin.") ||
    action.startsWith("sync.")
  )
    return "account";
  return null;
}

/**
 * Resolves actor/target ids to human (main character) names in a fixed,
 * small number of batched queries, independent of row count:
 *   1. accounts referenced directly (as actor or an account-shaped target)
 *      + discord links referenced as a target + payout operations referenced
 *      as a target, all in parallel
 *   2. accounts reached only via a discord link (to get *their*
 *      mainCharacterId) — skipped entirely if no discord targets resolved
 *   3. every character name needed (target characters + all main characters
 *      collected above), in one shot
 * Anything that doesn't resolve is left as `null`/`"unresolved"`; the raw
 * `actor`/`target` strings on the row are always preserved unchanged.
 */
export async function resolveAuditIdentities(
  dbx: Dbx,
  rows: Array<typeof auditLog.$inferSelect>,
): Promise<ResolvedAuditRow[]> {
  if (rows.length === 0) return [];

  const accountIds = new Set<string>();
  const targetCharacterIds = new Set<number>();
  const targetDiscordIds = new Set<string>();
  const targetPayoutIds = new Set<string>();

  for (const r of rows) {
    if (r.actor !== "system" && UUID_RE.test(r.actor)) accountIds.add(r.actor);
    if (RESERVED_TARGET_LITERALS.has(r.target)) continue;
    const kind = targetKindFromAction(r.action);
    if (kind === "account" && UUID_RE.test(r.target)) accountIds.add(r.target);
    else if (kind === "character" && DIGITS_RE.test(r.target))
      targetCharacterIds.add(Number(r.target));
    else if (kind === "discord" && DIGITS_RE.test(r.target))
      targetDiscordIds.add(r.target);
    else if (kind === "payout" && UUID_RE.test(r.target)) targetPayoutIds.add(r.target);
  }

  const [directAccounts, links, payoutOperations] = await Promise.all([
    accountIds.size
      ? dbx
          .select({ id: account.id, mainCharacterId: account.mainCharacterId })
          .from(account)
          .where(inArray(account.id, [...accountIds]))
      : Promise.resolve([]),
    targetDiscordIds.size
      ? dbx
          .select({
            accountId: discordLink.accountId,
            discordUserId: discordLink.discordUserId,
          })
          .from(discordLink)
          .where(inArray(discordLink.discordUserId, [...targetDiscordIds]))
      : Promise.resolve([]),
    targetPayoutIds.size
      ? dbx
          .select({ id: payoutOperation.id, name: payoutOperation.name })
          .from(payoutOperation)
          .where(inArray(payoutOperation.id, [...targetPayoutIds]))
      : Promise.resolve([]),
  ]);

  const accountById = new Map(directAccounts.map((a) => [a.id, a]));
  const discordAccountIds = links
    .map((l) => l.accountId)
    .filter((id) => !accountById.has(id));
  const discordAccounts = discordAccountIds.length
    ? await dbx
        .select({ id: account.id, mainCharacterId: account.mainCharacterId })
        .from(account)
        .where(inArray(account.id, discordAccountIds))
    : [];
  for (const a of discordAccounts) accountById.set(a.id, a);

  const discordUserToAccountId = new Map(
    links.map((l) => [l.discordUserId, l.accountId]),
  );
  const nameByPayoutId = new Map(payoutOperations.map((o) => [o.id, o.name]));

  const characterIds = new Set<number>(targetCharacterIds);
  for (const a of accountById.values()) {
    if (a.mainCharacterId !== null) characterIds.add(a.mainCharacterId);
  }
  const characters = characterIds.size
    ? await dbx
        .select({ id: character.id, name: character.name })
        .from(character)
        .where(inArray(character.id, [...characterIds]))
    : [];
  const nameByCharacterId = new Map(characters.map((c) => [c.id, c.name]));

  const mainNameOf = (accountId: string): string | null => {
    const acc = accountById.get(accountId);
    if (!acc || acc.mainCharacterId === null) return null;
    return nameByCharacterId.get(acc.mainCharacterId) ?? null;
  };

  return rows.map((r) => {
    let actorName: string | null = null;
    let actorKind: ResolvedAuditRow["actorKind"] = "unresolved";
    if (r.actor === "system") {
      actorKind = "system";
    } else if (UUID_RE.test(r.actor)) {
      const name = mainNameOf(r.actor);
      if (name !== null) {
        actorName = name;
        actorKind = "account";
      }
    }

    let targetName: string | null = null;
    let targetKind: ResolvedAuditRow["targetKind"] = "unresolved";
    if (RESERVED_TARGET_LITERALS.has(r.target)) {
      // Renders as a filter link (see TargetCell): a single-job sync re-run
      // names its job here, and a target you cannot click to filter by is
      // half the value of recording it.
      targetKind = "literal";
    } else {
      const kind = targetKindFromAction(r.action);
      if (kind === "account" && UUID_RE.test(r.target)) {
        const name = mainNameOf(r.target);
        if (name !== null) {
          targetName = name;
          targetKind = "account";
        }
      } else if (kind === "character" && DIGITS_RE.test(r.target)) {
        const name = nameByCharacterId.get(Number(r.target)) ?? null;
        if (name !== null) {
          targetName = name;
          targetKind = "character";
        }
      } else if (kind === "discord" && DIGITS_RE.test(r.target)) {
        const accId = discordUserToAccountId.get(r.target);
        const name = accId !== undefined ? mainNameOf(accId) : null;
        if (name !== null) {
          targetName = name;
          targetKind = "discord";
        }
      } else if (kind === "payout" && UUID_RE.test(r.target)) {
        const name = nameByPayoutId.get(r.target) ?? null;
        if (name !== null) {
          targetName = name;
          targetKind = "payout";
        }
      }
    }

    return { ...r, actorName, actorKind, targetName, targetKind };
  });
}

export type FilterResolution =
  | { kind: "raw"; ids: string[] }
  | { kind: "name"; name: string; ids: string[]; accountCount: number }
  | { kind: "none"; name: string };

/**
 * Inverts `resolveAuditIdentities` for the filter box: turns what an admin
 * sees ("Zed") back into the raw ids the audit log actually stores.
 *
 * A raw id costs nothing -- UUIDs, bare digit strings and the reserved
 * literals short-circuit with zero queries, which is what keeps pasting an id
 * working. Everything else is a name, resolved along the same three display
 * paths `resolveAuditIdentities` renders:
 *
 *   actor  -> accounts whose main character carries the name (actor is only
 *             ever an account uuid or "system", so nothing else can match)
 *   target -> those accounts, PLUS every character carrying the name, PLUS the
 *             discord ids linked to those accounts, because one person's
 *             target rows are spread across all three identifier forms and a
 *             filter that pinned one would silently hide the others
 *
 * Deliberately NOT called from inside queryAuditLog: that function receives
 * raw ids only, so a caller passing a non-uuid raw actor (as
 * tests/audit-query.test.ts does) can never have it reinterpreted as a name.
 */
export async function resolveFilterIdentity(
  dbx: Dbx,
  field: "actor" | "target",
  value: string,
): Promise<FilterResolution> {
  const reserved =
    field === "target" ? RESERVED_TARGET_LITERALS : RESERVED_LITERALS_ANY_FIELD;
  if (reserved.has(value) || UUID_RE.test(value) || DIGITS_RE.test(value)) {
    return { kind: "raw", ids: [value] };
  }

  // 1. every character carrying the name (case-insensitive), with its owner
  const chars = await dbx
    .select({ id: character.id, accountId: character.accountId })
    .from(character)
    .where(sql`lower(${character.name}) = lower(${value})`);
  if (chars.length === 0) return { kind: "none", name: value };

  const characterIds = chars.map((c) => c.id);

  // 2. the accounts that *display* the name, i.e. whose main is one of those
  const mains = await dbx
    .select({ id: account.id })
    .from(account)
    .where(inArray(account.mainCharacterId, characterIds));
  const displayAccountIds = mains.map((a) => a.id);

  if (field === "actor") {
    // An alt's name can never appear in the actor column, so its owning
    // account neither contributes rows nor counts toward ambiguity.
    if (displayAccountIds.length === 0) return { kind: "none", name: value };
    return {
      kind: "name",
      name: value,
      ids: displayAccountIds,
      accountCount: displayAccountIds.length,
    };
  }

  // 3. discord ids of the displaying accounts (this one IS index-backed --
  //    discord_link.account_id is that table's primary key)
  const links = displayAccountIds.length
    ? await dbx
        .select({ discordUserId: discordLink.discordUserId })
        .from(discordLink)
        .where(inArray(discordLink.accountId, displayAccountIds))
    : [];

  const ids = [
    ...displayAccountIds,
    ...characterIds.map(String),
    ...links.map((l) => l.discordUserId),
  ];
  if (ids.length === 0) return { kind: "none", name: value };

  // Matched character ids are in the union, so their owning accounts are
  // surfaced too and must count -- otherwise two same-named alts on two
  // accounts widen the results while the page reports no ambiguity.
  const accountCount = new Set([...displayAccountIds, ...chars.map((c) => c.accountId)])
    .size;

  return { kind: "name", name: value, ids, accountCount };
}

export async function queryAuditLog(
  dbx: Dbx,
  filters: {
    /** Raw actor ids. Exactly one -> equality; several -> any-of; empty -> no
     * rows. Names are resolved by resolveFilterIdentity BEFORE this call, so a
     * non-uuid raw actor can never be mistaken for one. */
    actorIds?: string[];
    action?: string; // prefix match, e.g. "tier."
    /** Raw target ids; one person spans several (see resolveFilterIdentity). */
    targetIds?: string[];
    beforeId?: number;
    limit?: number;
  } = {},
): Promise<ResolvedAuditRow[]> {
  // An empty list is "resolved to nothing", not "unfiltered" -- short-circuit
  // rather than let it degrade into a full scan.
  if (filters.actorIds?.length === 0 || filters.targetIds?.length === 0) return [];

  const conds = [];
  if (filters.actorIds) {
    conds.push(
      filters.actorIds.length === 1
        ? eq(auditLog.actor, filters.actorIds[0])
        : inArray(auditLog.actor, filters.actorIds),
    );
  }
  if (filters.action) {
    // The filter is a LITERAL prefix; % and _ are LIKE wildcards, so escape
    // them (and backslash, Postgres's default escape character).
    const prefix = filters.action.replace(/[\\%_]/g, (c) => `\\${c}`);
    conds.push(like(auditLog.action, `${prefix}%`));
  }
  if (filters.targetIds) {
    conds.push(
      filters.targetIds.length === 1
        ? eq(auditLog.target, filters.targetIds[0])
        : inArray(auditLog.target, filters.targetIds),
    );
  }
  if (filters.beforeId !== undefined) conds.push(lt(auditLog.id, filters.beforeId));
  const limit = Math.min(filters.limit ?? AUDIT_PAGE_SIZE, AUDIT_PAGE_SIZE);
  const rows = await dbx
    .select()
    .from(auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit);
  return resolveAuditIdentities(dbx, rows);
}

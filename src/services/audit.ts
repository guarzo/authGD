import type { Dbx } from "@/db";
import { account, auditLog, character, discordLink } from "@/db/schema";
import { and, desc, eq, inArray, like, lt } from "drizzle-orm";

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
  targetKind: "account" | "character" | "discord" | "literal" | "unresolved";
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d+$/;

/**
 * Every target is written by exactly one call site shape in this codebase
 * (grep `logAudit(` across src/), so the *action* namespace is a reliable,
 * intentional signal for what a target string means — unlike its shape. An
 * EVE character id and a Discord snowflake are both bare digit strings, so
 * shape alone (or a magnitude heuristic, since snowflakes are ~18-19 digits
 * and character ids are ~9-10) would work only by coincidence today and
 * silently rot the day either numbering scheme changes. `discord.*` actions
 * only ever target a Discord user id; `character.*` / `token.*` /
 * `wanderer.*` only ever target an EVE character id; everything else
 * (`tier.*`, `status.*`, `account.*`, `admin.*`, `sync.*`) targets an account.
 * The literal broadcast target `"all"` (used by `sync.*`) is short-circuited by
 * the caller before this function is consulted, so `sync.*` reaching here
 * always means the account-uuid form.
 */
function targetKindFromAction(
  action: string,
): "account" | "character" | "discord" | null {
  if (action.startsWith("discord.")) return "discord";
  if (
    action.startsWith("character.") ||
    action.startsWith("token.") ||
    action.startsWith("wanderer.")
  )
    return "character";
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
 *      + discord links referenced as a target, in parallel
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

  for (const r of rows) {
    if (r.actor !== "system" && UUID_RE.test(r.actor)) accountIds.add(r.actor);
    if (r.target === "all") continue;
    const kind = targetKindFromAction(r.action);
    if (kind === "account" && UUID_RE.test(r.target)) accountIds.add(r.target);
    else if (kind === "character" && DIGITS_RE.test(r.target))
      targetCharacterIds.add(Number(r.target));
    else if (kind === "discord" && DIGITS_RE.test(r.target))
      targetDiscordIds.add(r.target);
  }

  const [directAccounts, links] = await Promise.all([
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
    if (r.target === "all") {
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
      }
    }

    return { ...r, actorName, actorKind, targetName, targetKind };
  });
}

export async function queryAuditLog(
  dbx: Dbx,
  filters: {
    actor?: string;
    action?: string; // prefix match, e.g. "tier."
    target?: string;
    beforeId?: number;
    limit?: number;
  } = {},
): Promise<ResolvedAuditRow[]> {
  const conds = [];
  if (filters.actor) conds.push(eq(auditLog.actor, filters.actor));
  if (filters.action) {
    // The filter is a LITERAL prefix; % and _ are LIKE wildcards, so escape
    // them (and backslash, Postgres's default escape character).
    const prefix = filters.action.replace(/[\\%_]/g, (c) => `\\${c}`);
    conds.push(like(auditLog.action, `${prefix}%`));
  }
  if (filters.target) conds.push(eq(auditLog.target, filters.target));
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

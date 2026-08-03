import { and, asc, eq, sql } from "drizzle-orm";
import type { Config } from "@/config";
import type { DbTx } from "@/db";
import { account, bootstrapAdminGrant, character, contactSyncState } from "@/db/schema";
import { encryptToken } from "@/lib/crypto";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";
import { revokeAccountSessions } from "@/services/session";

// LOCK ORDER (deadlock avoidance), applied top to bottom:
//   1. pg_advisory_xact_lock(characterId) — serializes even when no character
//      row exists yet (two first-logins for the same character cannot race).
//   2. character row(s) FOR UPDATE.
//   3. account row(s) FOR UPDATE, ALWAYS in sorted-id order when more than one
//      account is involved (opposite-direction transfers cannot deadlock).
// demoteAdmin locks account rows only.
export interface EveCallbackCharacter {
  characterId: number;
  characterName: string;
  ownerHash: string;
  scopes: string[];
  refreshToken: string;
}

/**
 * Advisory-lock class id for character locks. Two-arg (namespaced) form so
 * future advisory-lock users (outbox dispatcher, job leader election) cannot
 * collide with character ids. Character ids can exceed int4, so they are
 * reduced to a 32-bit key with hashint8 — a hash collision merely serializes
 * two unrelated characters, which is safe.
 */
const CHARACTER_LOCK_CLASS = 1;

/**
 * Transaction-scoped advisory lock on the character id. Unlike FOR UPDATE this
 * also serializes callers when NO row exists yet, so two concurrent first
 * logins for the same character cannot both take the insert path.
 */
async function lockCharacterId(dbx: DbTx, characterId: number) {
  await dbx.execute(
    sql`SELECT pg_advisory_xact_lock(${CHARACTER_LOCK_CLASS}, hashint8(${characterId}))`,
  );
}

/** Advisory lock + row lock, in that order. */
async function findCharacterForUpdate(dbx: DbTx, characterId: number) {
  await lockCharacterId(dbx, characterId);
  const rows = await dbx
    .select()
    .from(character)
    .where(eq(character.id, characterId))
    .for("update");
  return rows[0];
}

/** Lock several account rows deterministically (sorted id order). */
async function lockAccounts(dbx: DbTx, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) {
    await dbx.select().from(account).where(eq(account.id, id)).for("update");
  }
}

function tokenFields(cfg: Config, ch: EveCallbackCharacter) {
  const hasAllScopes = cfg.eveSso.scopes.every((s) => ch.scopes.includes(s));
  return {
    name: ch.characterName,
    ownerHash: ch.ownerHash,
    refreshTokenEnc: encryptToken(ch.refreshToken, cfg.tokenEncryptionKey),
    scopes: ch.scopes,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- load-bearing: without it the property widens to `string` in the inferred object type and no longer satisfies the drizzle insert. The rule checks the assertion in isolation, where the literal union survives.
    tokenStatus: (hasAllScopes ? "valid" : "needs_reauth") as "valid" | "needs_reauth",
  };
}

/** Re-auth in place: refresh credentials + status, audit, and enqueue sync. */
async function reauthCharacter(
  dbx: DbTx,
  cfg: Config,
  accountId: string,
  ch: EveCallbackCharacter,
) {
  await dbx
    .update(character)
    .set(tokenFields(cfg, ch))
    .where(eq(character.id, ch.characterId));
  await logAudit(dbx, {
    actor: accountId,
    action: "character.reauthed",
    target: String(ch.characterId),
  });
  await enqueueSync(dbx, { kind: "account", accountId });
}

/** No-main rule: atomically clear main, demote unless locked, enqueue sync. */
async function applyNoMainRule(dbx: DbTx, accountId: string, cause: string) {
  const [acc] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  if (!acc) return;
  const demote = !acc.tierLocked && acc.tier !== "green";
  await dbx
    .update(account)
    .set({
      mainCharacterId: null,
      ...(demote
        ? { tier: "green" as const, tierChangedAt: new Date(), tierChangedBy: "system" }
        : {}),
    })
    .where(eq(account.id, accountId));
  if (demote) {
    await logAudit(dbx, {
      actor: "system",
      action: "tier.changed",
      target: accountId,
      details: { to: "green", cause },
    });
  }
  await enqueueSync(dbx, { kind: "account", accountId });
}

async function reclaimCharacter(dbx: DbTx, existing: { id: number; accountId: string }) {
  const [oldAcc] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, existing.accountId))
    .for("update");
  await dbx.delete(contactSyncState).where(eq(contactSyncState.characterId, existing.id));
  await dbx.delete(character).where(eq(character.id, existing.id));
  await logAudit(dbx, {
    actor: "system",
    action: "character.reclaimed",
    target: String(existing.id),
    details: { fromAccount: existing.accountId },
  });
  if (oldAcc?.mainCharacterId === existing.id) {
    await applyNoMainRule(dbx, existing.accountId, "character transferred");
  } else {
    await enqueueSync(dbx, { kind: "account", accountId: existing.accountId });
  }
  await revokeAccountSessions(dbx, existing.accountId);
}

async function createAccountWithCharacter(
  dbx: DbTx,
  cfg: Config,
  ch: EveCallbackCharacter,
): Promise<string> {
  const [acc] = await dbx
    .insert(account)
    .values({ tier: "green", mainCharacterId: ch.characterId })
    .returning();
  await dbx.insert(character).values({
    id: ch.characterId,
    accountId: acc.id,
    ...tokenFields(cfg, ch),
  });
  await logAudit(dbx, {
    actor: "system",
    action: "account.created",
    target: acc.id,
    details: { mainCharacterId: ch.characterId },
  });
  await enqueueSync(dbx, { kind: "account", accountId: acc.id });
  await maybeGrantBootstrapAdmin(dbx, cfg, acc.id, {
    characterId: ch.characterId,
    ownerHash: ch.ownerHash,
  });
  return acc.id;
}

export async function handleEveLogin(
  dbx: DbTx,
  cfg: Config,
  ch: EveCallbackCharacter,
): Promise<{ accountId: string }> {
  const existing = await findCharacterForUpdate(dbx, ch.characterId);
  if (existing && existing.ownerHash === ch.ownerHash) {
    await reauthCharacter(dbx, cfg, existing.accountId, ch);
    return { accountId: existing.accountId };
  }
  if (existing) {
    // sold character: owner-hash comparison precedes any rejection
    await reclaimCharacter(dbx, existing);
  }
  return { accountId: await createAccountWithCharacter(dbx, cfg, ch) };
}

export async function linkCharacter(
  dbx: DbTx,
  cfg: Config,
  accountId: string,
  ch: EveCallbackCharacter,
): Promise<{ ok: true } | { ok: false; error: "already_linked" }> {
  const existing = await findCharacterForUpdate(dbx, ch.characterId);
  if (existing) {
    if (existing.accountId === accountId) {
      await reauthCharacter(dbx, cfg, accountId, ch);
      return { ok: true };
    }
    if (existing.ownerHash === ch.ownerHash) {
      return { ok: false, error: "already_linked" };
    }
    // two accounts involved: lock both in sorted order before mutating
    await lockAccounts(dbx, [existing.accountId, accountId]);
    await reclaimCharacter(dbx, existing);
  }
  // Lock the account row BEFORE inserting the character: the insert's FK
  // acquires FOR KEY SHARE on the account row, and taking FOR UPDATE first
  // avoids a KEY SHARE -> FOR UPDATE upgrade deadlock between concurrent
  // linkCharacter calls (or setMainCharacter) targeting the same account.
  const [acc] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  await dbx.insert(character).values({
    id: ch.characterId,
    accountId,
    ...tokenFields(cfg, ch),
  });
  if (acc && acc.mainCharacterId === null) {
    await dbx
      .update(account)
      .set({ mainCharacterId: ch.characterId })
      .where(eq(account.id, accountId));
  }
  await logAudit(dbx, {
    actor: accountId,
    action: "character.linked",
    target: String(ch.characterId),
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  await maybeGrantBootstrapAdmin(dbx, cfg, accountId, {
    characterId: ch.characterId,
    ownerHash: ch.ownerHash,
  });
  return { ok: true };
}

export type UnlinkResult =
  { ok: true } | { ok: false; error: "not_found" | "not_owned" | "last_character" };

export async function unlinkCharacter(
  dbx: DbTx,
  cfg: Config,
  actor: string,
  characterId: number,
  opts: { revokeSessions?: boolean; expectedAccountId?: string } = {},
): Promise<UnlinkResult> {
  const existing = await findCharacterForUpdate(dbx, characterId);
  if (!existing) return { ok: false, error: "not_found" };
  // Re-check ownership under the lock: a caller's pre-lock SELECT can be
  // stale if a transfer-reclaim committed between its check and this lock.
  if (opts.expectedAccountId && existing.accountId !== opts.expectedAccountId) {
    return { ok: false, error: "not_owned" };
  }
  // Never let an account unlink its final character: the account would be
  // orphaned (a fresh SSO login with that character creates a NEW account).
  // Transfer reclaim doesn't go through here, so this only gates unlink flows.
  const siblings = await dbx
    .select()
    .from(character)
    .where(eq(character.accountId, existing.accountId));
  if (siblings.length <= 1) return { ok: false, error: "last_character" };
  await dbx.delete(contactSyncState).where(eq(contactSyncState.characterId, characterId));
  await dbx.delete(character).where(eq(character.id, characterId));
  await logAudit(dbx, {
    actor,
    action: "character.unlinked",
    target: String(characterId),
  });
  const [acc] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, existing.accountId))
    .for("update");
  if (acc?.mainCharacterId === characterId) {
    await applyNoMainRule(dbx, existing.accountId, "main unlinked");
  } else {
    await enqueueSync(dbx, { kind: "account", accountId: existing.accountId });
  }
  if (opts.revokeSessions) await revokeAccountSessions(dbx, existing.accountId);
  return { ok: true };
}

export async function setMainCharacter(
  dbx: DbTx,
  accountId: string,
  characterId: number,
): Promise<{ ok: true } | { ok: false; error: "not_on_account" }> {
  const rows = await dbx
    .select()
    .from(character)
    .where(and(eq(character.id, characterId), eq(character.accountId, accountId)))
    .for("update");
  if (rows.length === 0) return { ok: false, error: "not_on_account" };
  await dbx.select().from(account).where(eq(account.id, accountId)).for("update");
  await dbx
    .update(account)
    .set({ mainCharacterId: characterId })
    .where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor: accountId,
    action: "account.main_changed",
    target: accountId,
    details: { mainCharacterId: characterId },
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true };
}

export async function maybeGrantBootstrapAdmin(
  dbx: DbTx,
  cfg: Config,
  accountId: string,
  ch: { characterId: number; ownerHash: string },
): Promise<boolean> {
  if (!cfg.bootstrapAdminCharacterIds.includes(ch.characterId)) return false;
  const inserted = await dbx
    .insert(bootstrapAdminGrant)
    .values({ characterId: ch.characterId, ownerHash: ch.ownerHash, accountId })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) return false; // grant already consumed, ever
  await dbx.update(account).set({ isAdmin: true }).where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor: "system",
    action: "admin.bootstrap_granted",
    target: accountId,
    details: { characterId: ch.characterId },
  });
  return true;
}

/**
 * Transfer reclaim for background detection (token health): unlike
 * unlinkCharacter there is NO last-character guard — that guard exists only
 * for ordinary unlink flows, while a sold character always leaves its old
 * account, which may legitimately end with zero characters (spec: it stays
 * Green until an admin deletes it). Locks, deletes the link, applies the
 * no-main rule (demotion unless tier_locked + outbox enqueue), and revokes
 * the account's sessions.
 */
export async function reclaimTransferredCharacter(
  dbx: DbTx,
  characterId: number,
  expected: { accountId: string; ownerHash: string },
): Promise<{ ok: true } | { ok: false; error: "not_found" | "changed" }> {
  const existing = await findCharacterForUpdate(dbx, characterId);
  if (!existing) return { ok: false, error: "not_found" };
  // Stale-decision guard: re-verify under the lock. If the row already
  // changed hands (the new owner's login reclaimed it, or a re-auth updated
  // the owner hash), this caller's decision is based on dead data.
  if (
    existing.accountId !== expected.accountId ||
    existing.ownerHash !== expected.ownerHash
  ) {
    return { ok: false, error: "changed" };
  }
  await reclaimCharacter(dbx, existing);
  return { ok: true };
}

export async function demoteAdmin(
  dbx: DbTx,
  actor: string,
  accountId: string,
): Promise<{ ok: boolean; error?: "last_admin" | "not_authorized" }> {
  // Lock ALL admin rows first: two admins demoting each other serialize here,
  // and the second transaction re-counts after the first commits.
  const admins = await dbx
    .select()
    .from(account)
    .where(eq(account.isAdmin, true))
    .orderBy(asc(account.id))
    .for("update");
  // Defense-in-depth: only "system" or a current admin may demote. Routes must
  // still gate this, but the service refuses unauthorized actors regardless.
  if (actor !== "system" && !admins.some((a) => a.id === actor)) {
    return { ok: false, error: "not_authorized" };
  }
  const otherAdmins = admins.filter((a) => a.id !== accountId);
  if (otherAdmins.length === 0) return { ok: false, error: "last_admin" };
  await dbx.update(account).set({ isAdmin: false }).where(eq(account.id, accountId));
  await logAudit(dbx, { actor, action: "admin.demoted", target: accountId });
  return { ok: true };
}

export async function promoteAdmin(
  dbx: DbTx,
  actor: string,
  accountId: string,
): Promise<{ ok: boolean; error?: "not_authorized" | "not_found" }> {
  // Same lock order as demoteAdmin: the sorted admin set first, so concurrent
  // promote/demote serialize on it, then the (non-admin) target row.
  const admins = await dbx
    .select()
    .from(account)
    .where(eq(account.isAdmin, true))
    .orderBy(asc(account.id))
    .for("update");
  if (actor !== "system" && !admins.some((a) => a.id === actor)) {
    return { ok: false, error: "not_authorized" };
  }
  const [target] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  if (!target) return { ok: false, error: "not_found" };
  if (!target.isAdmin) {
    await dbx.update(account).set({ isAdmin: true }).where(eq(account.id, accountId));
    await logAudit(dbx, { actor, action: "admin.promoted", target: accountId });
  }
  return { ok: true };
}

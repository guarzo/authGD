import { and, asc, eq, sql } from "drizzle-orm";
import type { Config } from "@/config";
import type { DbTx } from "@/db";
import {
  account,
  bootstrapAdminGrant,
  character,
  contactSyncState,
  discordLink,
  payoutOperation,
  payoutParticipant,
  payoutPayment,
  session,
} from "@/db/schema";
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

/** Lock a single account row and return it (or undefined if missing). */
async function lockAccount(dbx: DbTx, accountId: string) {
  const rows = await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  return rows[0];
}

/**
 * Member self-service: wake the caller's OWN account out of cryo. This is
 * intentionally the only direction a member can move status themselves — a
 * member must never be able to freeze their own account, since that would
 * let them dodge the corp's inactivity policy. Freezing stays admin-only via
 * `setAccountStatus` in admin-accounts.ts.
 *
 * No authorization check here: the caller's identity is the account itself,
 * proven by session upstream (route layer), not by an actor/target split
 * like the admin mutations above. There is nothing to authorize against.
 */
export async function wakeSelf(
  dbx: DbTx,
  accountId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const acc = await lockAccount(dbx, accountId);
  if (!acc) return { ok: false, error: "not_found" };
  if (acc.status !== "cryo") return { ok: true }; // already active: idempotent no-op
  await dbx
    .update(account)
    .set({ status: "active", statusChangedAt: new Date() })
    .where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor: accountId,
    action: "status.changed",
    target: accountId,
    details: { from: acc.status, to: "active", self: true },
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true };
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
  // Demote only from an earned tier. Alumni is already the floor, and pending
  // is BELOW it — demoting a pending account to alumni would turn losing your
  // main into an automatic approval.
  const demote = !acc.tierLocked && acc.tier !== "alumni" && acc.tier !== "pending";
  await dbx
    .update(account)
    .set({
      mainCharacterId: null,
      ...(demote
        ? { tier: "alumni" as const, tierChangedAt: new Date(), tierChangedBy: "system" }
        : {}),
    })
    .where(eq(account.id, accountId));
  if (demote) {
    await logAudit(dbx, {
      actor: "system",
      action: "tier.changed",
      target: accountId,
      details: { from: acc.tier, to: "alumni", cause },
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
    // Explicit, not the column default: the default stays alumni because a
    // migration cannot use a newly added enum value in the transaction that
    // adds it. Deploy 1 taught every reader about pending; this line is
    // deploy 2, and must never ship in the same release as deploy 1.
    .values({ tier: "pending", mainCharacterId: ch.characterId })
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

/**
 * Why this account is more than the character being moved — or null when it is
 * nothing more, and the merge may proceed.
 *
 * The reason is returned rather than a bare boolean because it is the only
 * thing that makes the refusal actionable. Four of these (`admin`,
 * `tier_locked`, `status`, `note`) name a field an admin can clear from
 * /admin/accounts in seconds, and a member who is told which one can go and
 * ask for exactly that. The remaining three are genuine refusals with no
 * cheap fix, and say so.
 *
 * FIRST MATCH WINS, in declaration order. An account can trip several at once;
 * reporting one keeps the copy a single sentence, and the member retries after
 * clearing it, which surfaces the next. The order below is deliberate — the
 * cheap-to-clear fields come first, so a member is never sent to ask about
 * payout history when clearing a note would have been enough.
 */
export type MergeBlocker =
  "admin" | "tier_locked" | "status" | "note" | "characters" | "discord" | "payouts";

/**
 * What makes this account more than the character being moved, if anything.
 *
 * An account created by an accidental SSO login holds exactly one character
 * and no other trace: no admin bit, no Discord link, no payout history of any
 * kind, no admin-set tier, and no status or note an admin curated. Cryo and a
 * status note are each reachable on their own (setAccountStatus /
 * setStatusNote), so both are checked — an established account must never be
 * dissolved, and its note destroyed, by someone clicking "link character".
 *
 * "Payout history" means all three tables, not just the two that name the
 * account as a subject. payout_payment.actor is a set-null FK (schema.ts:320),
 * so deleting an account that recorded a payment silently detaches financial
 * attribution. Note this is reachable WITHOUT the account being member now:
 * recordPayment requires active member (payouts.ts:445), but a derole to alumni
 * is automatic and unlocked, and nothing below inspects tier. A one-character
 * ex-operator with no Discord link would otherwise pass every other check.
 *
 * Callers must already hold the source account row FOR UPDATE.
 */
async function mergeBlocker(
  dbx: DbTx,
  acc: typeof account.$inferSelect,
  characterId: number,
): Promise<MergeBlocker | null> {
  if (acc.isAdmin) return "admin";
  if (acc.tierLocked) return "tier_locked";
  if (acc.status !== "active") return "status";
  if (acc.statusNote !== null) return "note";
  const chars = await dbx.select().from(character).where(eq(character.accountId, acc.id));
  if (chars.length !== 1 || chars[0].id !== characterId) return "characters";
  const [linked] = await dbx
    .select()
    .from(discordLink)
    .where(eq(discordLink.accountId, acc.id));
  if (linked) return "discord";
  const [participant] = await dbx
    .select()
    .from(payoutParticipant)
    .where(eq(payoutParticipant.accountId, acc.id));
  if (participant) return "payouts";
  const [operation] = await dbx
    .select()
    .from(payoutOperation)
    .where(eq(payoutOperation.createdBy, acc.id));
  if (operation) return "payouts";
  const [payment] = await dbx
    .select()
    .from(payoutPayment)
    .where(eq(payoutPayment.actor, acc.id));
  if (payment) return "payouts";
  return null;
}

/**
 * Fold `sourceId` into `targetId`: the character moves, the source account and
 * its sessions are deleted. Callers must hold the advisory character lock and
 * BOTH account rows FOR UPDATE in sorted id order.
 *
 * The source's main is cleared first for clarity only — account's composite
 * main-character FK is DEFERRABLE INITIALLY DEFERRED
 * (drizzle/0001_main_character_fk.sql), so the reassignment is validated at
 * COMMIT rather than statement by statement.
 *
 * Deleting the sessions is mandatory, not tidiness: session.account_id has no
 * ON DELETE clause (schema.ts:89), so it defaults to NO ACTION and the account
 * DELETE below raises a foreign key violation if any session survives. The
 * stray account's browser session is exactly the one the operator used to make
 * the accident, so it is very likely to exist.
 *
 * Two deletion side effects, both intended. audit_log.actor is plain text with
 * no FK, so rows the source wrote survive with an id that resolves to nothing
 * (actorKind "unresolved"); they are NOT rewritten to the target, because
 * falsifying history to make it read better is worse than an unresolved id,
 * and the account.merged row records the mapping. bootstrap_admin_grant
 * .account_id IS a nulling FK and nulls — correct, since the grant must stay
 * permanently consumed and unearnable through a merge.
 */
async function mergeAccountInto(
  dbx: DbTx,
  sourceId: string,
  targetId: string,
  characterId: number,
): Promise<void> {
  await dbx
    .update(account)
    .set({ mainCharacterId: null })
    .where(eq(account.id, sourceId));
  await dbx
    .update(character)
    .set({ accountId: targetId })
    .where(eq(character.id, characterId));
  await dbx.delete(session).where(eq(session.accountId, sourceId));
  await dbx.delete(account).where(eq(account.id, sourceId));
  await logAudit(dbx, {
    actor: targetId,
    action: "account.merged",
    target: targetId,
    details: { sourceAccountId: sourceId, characterId },
  });
}

export async function linkCharacter(
  dbx: DbTx,
  cfg: Config,
  accountId: string,
  ch: EveCallbackCharacter,
): Promise<
  { ok: true } | { ok: false; error: "already_linked"; blocker?: MergeBlocker }
> {
  const existing = await findCharacterForUpdate(dbx, ch.characterId);
  if (existing) {
    if (existing.accountId === accountId) {
      await reauthCharacter(dbx, cfg, accountId, ch);
      return { ok: true };
    }
    if (existing.ownerHash === ch.ownerHash) {
      // Same character, same owner hash, a different account. EVE rotates the
      // owner hash on every transfer and handleEveLogin reclaims on mismatch,
      // so this state is reachable ONLY when the same owner authenticated
      // twice — an accidental second login, provably the same person as the
      // caller. Absorb that account if it holds nothing but this character;
      // anything richer is a real account and still refuses — with the reason,
      // so the member can be told which field to have an admin clear.
      await lockAccounts(dbx, [existing.accountId, accountId]);
      const [source] = await dbx
        .select()
        .from(account)
        .where(eq(account.id, existing.accountId));
      // A missing source row is unreachable through the FK on
      // character.account_id, and names no field anyone could clear: it
      // refuses with the generic copy rather than inventing a reason.
      if (!source) return { ok: false, error: "already_linked" };
      const blocker = await mergeBlocker(dbx, source, ch.characterId);
      if (blocker) return { ok: false, error: "already_linked", blocker };
      await mergeAccountInto(dbx, existing.accountId, accountId, ch.characterId);
      // Store the credentials this SSO round just produced, audit the re-auth
      // and enqueue the target's sync — all three are reauthCharacter's job.
      await reauthCharacter(dbx, cfg, accountId, ch);
      // Plain select, no FOR UPDATE: lockAccounts above already holds this row.
      const [target] = await dbx.select().from(account).where(eq(account.id, accountId));
      if (target && target.mainCharacterId === null) {
        await dbx
          .update(account)
          .set({ mainCharacterId: ch.characterId })
          .where(eq(account.id, accountId));
      }
      // maybeGrantBootstrapAdmin is deliberately NOT called: the grant for this
      // character was already consumed when the source account was created, and
      // the grant row survives that account's deletion precisely so it cannot
      // be re-earned.
      return { ok: true };
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
  const [acc] = await dbx
    .select()
    .from(account)
    .where(eq(account.id, existing.accountId))
    .for("update");
  // Logged after the account read, not before: wasMain needs that row, and the
  // character row carrying the name is already deleted above, so the name has
  // to come from `existing` or it is gone for good.
  const wasMain = acc?.mainCharacterId === characterId;
  await logAudit(dbx, {
    actor,
    action: "character.unlinked",
    target: String(characterId),
    details: { name: existing.name, wasMain },
  });
  if (wasMain) {
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
 * Alumni until an admin deletes it). Locks, deletes the link, applies the
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

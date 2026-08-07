import { eq } from "drizzle-orm";
import type { DbTx } from "@/db";
import { account } from "@/db/schema";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";

export type AdminMutationResult =
  { ok: true } | { ok: false; error: "not_authorized" | "not_found" };

/**
 * `setTierManual`'s own result, distinct from the shared `AdminMutationResult`
 * above: the caller (`setTierAction`) has to know whether THIS press left the
 * account locked in order to word the confirmation honestly — see
 * `accountsConfirmation`'s "tier" case (`view.ts`). `tierLocked` is the
 * account's state after this call returns, whether this press just set it,
 * left a pre-existing lock alone, or (the no-op case) changed nothing at all.
 */
export type SetTierResult =
  | { ok: true; tierLocked: boolean }
  | { ok: false; error: "not_authorized" | "not_found" };

/** Defense in depth: routes gate too, but services refuse unauthorized actors. */
async function isAuthorized(dbx: DbTx, actor: string): Promise<boolean> {
  if (actor === "system") return true;
  const [a] = await dbx.select().from(account).where(eq(account.id, actor));
  return a?.isAdmin === true;
}

async function lockTarget(dbx: DbTx, accountId: string) {
  const rows = await dbx
    .select()
    .from(account)
    .where(eq(account.id, accountId))
    .for("update");
  return rows[0];
}

/**
 * Spec tier state machine: ANY manual set (member, associate, or alumni) locks
 * the account — the membership job never touches locked accounts, including a
 * set to the tier the account already holds. That is deliberate: `tierLocked`
 * exists so an admin can pin a member BEFORE they leave the alliance, which is
 * exactly the moment the account already shows that tier. The row's arm step
 * (`ConfirmSubmit`, `admin/accounts/page.tsx`) is what makes the accidental
 * press and the deliberate pin distinguishable, not this guard — see that
 * file for how the currently-selected chip carries both `aria-pressed` and
 * the arm step together. Change + audit + outbox commit in one transaction
 * (the caller supplies the DbTx).
 */
export async function setTierManual(
  dbx: DbTx,
  actor: string,
  accountId: string,
  tier: "member" | "associate" | "alumni",
): Promise<SetTierResult> {
  if (!(await isAuthorized(dbx, actor))) return { ok: false, error: "not_authorized" };
  const acc = await lockTarget(dbx, accountId);
  if (!acc) return { ok: false, error: "not_found" };
  // Only a press that changes nothing at all — same tier, already locked — is
  // a no-op. A same-tier press on an UNLOCKED account still locks it: that is
  // the pin, not a bug, and `enqueueSync`/the audit row below are what make it
  // a real, visible action rather than a silent one now that the row arms
  // first.
  if (acc.tier === tier && acc.tierLocked) return { ok: true, tierLocked: true };
  await dbx
    .update(account)
    .set({ tier, tierLocked: true, tierChangedAt: new Date(), tierChangedBy: actor })
    .where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor,
    action: "tier.changed",
    target: accountId,
    details: { from: acc.tier, to: tier, locked: true, cause: "manual" },
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true, tierLocked: true };
}

/**
 * Clears the lock ONLY. The tier itself is stamped by the next membership run
 * (enqueued here), keeping "system decided" provenance in tier_changed_by.
 */
export async function returnTierToAuto(
  dbx: DbTx,
  actor: string,
  accountId: string,
): Promise<AdminMutationResult> {
  if (!(await isAuthorized(dbx, actor))) return { ok: false, error: "not_authorized" };
  const acc = await lockTarget(dbx, accountId);
  if (!acc) return { ok: false, error: "not_found" };
  if (!acc.tierLocked) return { ok: true };
  await dbx.update(account).set({ tierLocked: false }).where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor,
    action: "tier.unlocked",
    target: accountId,
    details: { tier: acc.tier },
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true };
}

export async function setAccountStatus(
  dbx: DbTx,
  actor: string,
  accountId: string,
  status: "active" | "cryo",
): Promise<AdminMutationResult> {
  if (!(await isAuthorized(dbx, actor))) return { ok: false, error: "not_authorized" };
  const acc = await lockTarget(dbx, accountId);
  if (!acc) return { ok: false, error: "not_found" };
  if (acc.status === status) return { ok: true };
  await dbx
    .update(account)
    .set({ status, statusChangedAt: new Date() })
    .where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor,
    action: "status.changed",
    target: accountId,
    details: { from: acc.status, to: status },
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true };
}

export type ApproveResult =
  { ok: true } | { ok: false; error: "not_authorized" | "not_found" | "not_pending" };

/**
 * Approve a pending account onto alumni or associate. Separate from setTierManual
 * because the lock differs and the guard differs.
 *
 * Alumni is left UNLOCKED so the account rejoins the automatic state machine:
 * if the member later joins the alliance, the membership job promotes them to
 * member with no admin involved. An unlocked alumni is stable, because
 * decideTier already wants alumni for a confirmed non-alliance main.
 *
 * Associate MUST lock. An unlocked associate is converged straight back to alumni on the
 * next membership run, which is why associate is inherently a locked tier.
 *
 * member is not an approval target — it is the system's to grant, or an admin's
 * via setTierManual.
 */
export async function approveAccount(
  dbx: DbTx,
  actor: string,
  accountId: string,
  tier: "alumni" | "associate",
): Promise<ApproveResult> {
  if (!(await isAuthorized(dbx, actor))) return { ok: false, error: "not_authorized" };
  const acc = await lockTarget(dbx, accountId);
  if (!acc) return { ok: false, error: "not_found" };
  // Re-checked under the lock: two admins approving the same account race here,
  // and the second must not re-stamp a tier the first already granted.
  if (acc.tier !== "pending") return { ok: false, error: "not_pending" };
  const locked = tier === "associate";
  await dbx
    .update(account)
    .set({ tier, tierLocked: locked, tierChangedAt: new Date(), tierChangedBy: actor })
    .where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor,
    action: "tier.approved",
    target: accountId,
    details: { to: tier, locked },
  });
  await enqueueSync(dbx, { kind: "account", accountId });
  return { ok: true };
}

export async function setStatusNote(
  dbx: DbTx,
  actor: string,
  accountId: string,
  note: string,
): Promise<AdminMutationResult> {
  if (!(await isAuthorized(dbx, actor))) return { ok: false, error: "not_authorized" };
  const acc = await lockTarget(dbx, accountId);
  if (!acc) return { ok: false, error: "not_found" };
  const value = note.trim() || null;
  if (acc.statusNote === value) return { ok: true };
  await dbx.update(account).set({ statusNote: value }).where(eq(account.id, accountId));
  await logAudit(dbx, {
    actor,
    action: "status.note_changed",
    target: accountId,
    // Whether a note changed, not what it says: the text lives on the account
    // where it is current, rather than frozen here at write time.
    details: { had: acc.statusNote !== null, has: value !== null },
  });
  return { ok: true };
}

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireAdminAction } from "@/lib/admin-guard";
import { demoteAdmin, promoteAdmin } from "@/services/accounts";
import {
  approveAccount,
  returnTierToAuto,
  setAccountStatus,
  setStatusNote,
  setTierManual,
} from "@/services/admin-accounts";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";

// `not_authorized` is a real race, not a bug: the actor's own admin bit can be
// cleared by another admin (demoteAdminAction) between this row rendering and
// the click, since actions don't re-run the page's guard on soft navigation.
// Redirect to the styled notice rather than throw, same as demoteAdminAction's
// `last_admin` case below. `not_found` is now reachable too: mergeAccountInto
// (services/accounts.ts) deletes the source row outright, and its
// isAbsorbable check doesn't gate on tier, so a pending account can be merged
// away out from under an admin who has its approval button on screen. See
// approveAction's `not_found` branch below for the same reasoning.
function redirectNotAdmin(): never {
  redirect("/admin/accounts?error=not_admin");
}

export async function setTierAction(
  accountId: string,
  tier: "flygd" | "blue" | "green",
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    setTierManual(tx, actor, accountId, tier),
  );
  if (!result.ok && result.error === "not_authorized") redirectNotAdmin();
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function approveAction(
  accountId: string,
  tier: "green" | "blue",
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    approveAccount(tx, actor, accountId, tier),
  );
  if (!result.ok && result.error === "not_authorized") redirectNotAdmin();
  // not_pending is a race, not a bug: two admins working the queue, or one
  // with a stale tab. Send them back to the queue with a notice rather than
  // the error boundary — the account is approved, just not by them.
  if (!result.ok && result.error === "not_pending") {
    redirect("/admin/accounts?tier=pending&error=not_pending");
  }
  // not_found is a race too, and specifically the merge feature's fault: the
  // pilot re-authed that character onto their real account, mergeAccountInto
  // absorbed and deleted the pending row, and this admin's click landed on a
  // row that's no longer there. Same treatment as not_pending — the queue
  // with a notice, not the error boundary, since nothing actually broke.
  if (!result.ok && result.error === "not_found") {
    redirect("/admin/accounts?tier=pending&error=not_found");
  }
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function returnToAutoAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    returnTierToAuto(tx, actor, accountId),
  );
  if (!result.ok && result.error === "not_authorized") redirectNotAdmin();
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function setStatusAction(
  accountId: string,
  status: "active" | "cryo",
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    setAccountStatus(tx, actor, accountId, status),
  );
  if (!result.ok && result.error === "not_authorized") redirectNotAdmin();
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function saveNoteAction(
  accountId: string,
  formData: FormData,
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const raw = formData.get("note");
  // FormData.get() is string | File | null. Coercing a File or a missing field
  // to "" would silently CLEAR the note (setStatusNote maps "" to null) and
  // write a status.note_changed audit entry for an edit nobody requested.
  // Reject the malformed request instead; "" itself stays valid — that is how
  // the form asks for the note to be cleared. This can only happen if the
  // form itself is tampered with, so it stays a throw rather than a race.
  if (typeof raw !== "string") throw new Error("invalid_note");

  const result = await getDb().transaction((tx) =>
    setStatusNote(tx, actor, accountId, raw),
  );
  if (!result.ok && result.error === "not_authorized") redirectNotAdmin();
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function syncAccountAction(
  accountId: string,
  // The page's current tier/status/sort/dir query string, plus queued=account,
  // bound in by the caller: without it the redirect below would always land
  // on the unfiltered list, dropping whatever filter the admin was scanning.
  redirectTo: string,
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  await getDb().transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.requested", target: accountId });
    await enqueueSync(tx, { kind: "account", accountId });
  });
  revalidatePath("/admin/accounts");
  redirect(redirectTo);
}

export async function promoteAdminAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => promoteAdmin(tx, actor, accountId));
  if (!result.ok && result.error === "not_authorized") redirectNotAdmin();
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function demoteAdminAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => demoteAdmin(tx, actor, accountId));
  if (!result.ok && result.error === "last_admin") {
    // Surface the service's protection instead of a 500 (carry-over).
    redirect("/admin/accounts?error=last_admin");
  }
  if (!result.ok && result.error === "not_authorized") redirectNotAdmin();
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

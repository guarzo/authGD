"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireAdminAction } from "@/lib/admin-guard";
import { demoteAdmin, promoteAdmin } from "@/services/accounts";
import {
  returnTierToAuto,
  setAccountStatus,
  setStatusNote,
  setTierManual,
} from "@/services/admin-accounts";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";

export async function setTierAction(
  accountId: string,
  tier: "flygd" | "blue" | "green",
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => setTierManual(tx, actor, accountId, tier));
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function returnToAutoAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => returnTierToAuto(tx, actor, accountId));
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
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function saveNoteAction(accountId: string, formData: FormData): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const note = String(formData.get("note") ?? "");
  const result = await getDb().transaction((tx) => setStatusNote(tx, actor, accountId, note));
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

export async function syncAccountAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  await getDb().transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.requested", target: accountId });
    await enqueueSync(tx, { kind: "account", accountId });
  });
  revalidatePath("/admin/accounts");
}

export async function promoteAdminAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => promoteAdmin(tx, actor, accountId));
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
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

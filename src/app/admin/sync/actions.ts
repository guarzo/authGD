"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireAdminAction } from "@/lib/admin-guard";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";

export async function syncAllAction(): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  await getDb().transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.requested", target: "all" });
    await enqueueSync(tx, { kind: "all" });
  });
  revalidatePath("/admin/sync");
  // The worker hasn't run by the time this re-renders, so the enqueue itself
  // is invisible; redirect carries a query flag the page turns into a notice.
  redirect("/admin/sync?queued=all");
}

export async function recheckInvalidAction(): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  await getDb().transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.recheck_requested", target: "all" });
    await enqueueSync(tx, { kind: "membership-recheck" });
  });
  revalidatePath("/admin/sync");
  redirect("/admin/sync?queued=recheck");
}

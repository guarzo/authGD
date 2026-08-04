"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { JOB_CRON } from "@/core/schedules";
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

/**
 * Re-run one named job. The lever a failed row actually wants: before this,
 * the only way to retry `wanderer` after a 502 was the fan-out, which also
 * re-ran three jobs that were fine.
 *
 * `target` carries the job type rather than "all". The audit page filters
 * actions by prefix, so `sync.requested` still matches everything it did
 * before, and the column that was always the literal "all" now says which job.
 */
export async function syncJobAction(formData: FormData): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const jobType = formData.get("jobType");
  // A server action takes whatever the wire sends, and `jobType` becomes a
  // queue name downstream. Only the schedules table's own keys are accepted,
  // so a tampered form cannot enqueue against an arbitrary queue. The dispatch
  // side checks again; this one keeps the bad row out of the outbox and the
  // audit log entirely. Unreachable from the rendered page, so it throws
  // rather than earning notice copy.
  if (typeof jobType !== "string" || !Object.hasOwn(JOB_CRON, jobType)) {
    throw new Error("invalid_job_type");
  }

  await getDb().transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.requested", target: jobType });
    await enqueueSync(tx, { kind: "job", jobType });
  });
  revalidatePath("/admin/sync");
  redirect(`/admin/sync?queued=${encodeURIComponent(jobType)}`);
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

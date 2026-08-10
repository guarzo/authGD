"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { isJobType, type JobType } from "@/core/schedules";
import { HEARTBEAT_STALE_AFTER_MS, evaluateFreshness } from "@/core/health";
import { requireAdminAction } from "@/lib/admin-guard";
import { logAudit } from "@/services/audit";
import { enqueueSync } from "@/services/outbox";
import { workerHeartbeat } from "@/services/health";
import { elapsedShort } from "@/app/_components/format-ago";
import { type ActionOutcome } from "@/app/_components/confirm-group";
import { queuedNotice } from "./view";

/** Derives its enum from `isJobType` (`@/core/schedules`) — the one place a
 *  job's schedule is written down — rather than duplicating that job-type
 *  list here. `z.custom` is the v4 way to lift an existing type guard into a
 *  schema without re-deriving the literals it checks. */
const jobTypeSchema = z.custom<JobType>(isJobType, { error: "invalid_job_type" });

export async function syncAllAction(): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  await getDb().transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.requested", target: "all" });
    await enqueueSync(tx, { kind: "all" });
  });
  revalidatePath("/admin/sync");
  // The worker hasn't run by the time this re-renders, so the enqueue itself
  // is invisible; redirect carries a query flag the page turns into a notice
  // via `ConfirmNotice` (`@/app/_components/confirm-notice`), which also
  // moves focus there so the confirmation is reachable from a button that
  // sits below seven job rows and however many drawers are open. `at` is the
  // enqueue instant, and it is what makes the *second* press of the same
  // button confirm again: the redirect target is otherwise constant, and
  // without a changing `at` in its effect dependency only the first press
  // would move focus. See `queuedNotice`.
  redirect(`/admin/sync?queued=all&at=${Date.now()}`);
}

/**
 * Re-run one named job. The lever a failed row actually wants: before this,
 * the only way to retry `wanderer` after a 502 was the fan-out, which also
 * re-ran three jobs that were fine.
 *
 * `target` carries the job type rather than "all". The audit page filters
 * actions by prefix, so `sync.requested` still matches everything it did
 * before, and the column that was always the literal "all" now says which job.
 *
 * Unlike its two siblings above, this does NOT redirect. Its `<form>`
 * (page.tsx) sits inside that job's own `Disclosure`, whose open/closed state
 * is a plain `useState` (`_components/disclosure.tsx`) with nowhere else to
 * live — a redirect back to this same route, even carrying nothing but
 * `?queued=&at=`, replaces the whole route tree and resets it, closing the
 * drawer the admin opened to press this button on the very first press. An
 * e2e run of the original all-redirect version of this fix caught it, the
 * same way an earlier one caught the identical failure on `/admin/accounts`'s
 * row drawer (see `_components/confirm-group.tsx`). `syncAllAction` and
 * `recheckInvalidAction` keep the redirect shape: their controls sit in
 * `btn-row--controls`, below the strip entirely, so a redirect back to this
 * page costs nothing stateful.
 *
 * Returns its confirmation through `useActionState` instead, for
 * `confirm-group.tsx`'s `ConfirmingForm`/`ConfirmGroup` (page.tsx wraps this
 * job's form in both) to focus — no query string, no navigation. The
 * sentence itself still comes from `queuedNotice` (`./view`), called with no
 * `at`: that argument only exists to make a repeat press of the *same*
 * redirect target announce again (`queuedNotice`'s own doc), and
 * `ConfirmGroup`'s counter-based effect already re-fires on every press
 * regardless of whether the text repeats, so there is nothing for `at` to buy
 * here that the drawer-scoped plumbing doesn't already give for free.
 */
export async function syncJobAction(
  _prevState: ActionOutcome,
  formData: FormData,
): Promise<ActionOutcome> {
  const { accountId: actor } = await requireAdminAction();
  const rawJobType = formData.get("jobType");
  // A server action takes whatever the wire sends, and `jobType` becomes a
  // queue name downstream. Only the schedules table's own keys are accepted,
  // so a tampered form cannot enqueue against an arbitrary queue. The dispatch
  // side checks again; this one keeps the bad row out of the outbox and the
  // audit log entirely. Unreachable from the rendered page, so it throws
  // rather than earning notice copy.
  const parsed = jobTypeSchema.safeParse(rawJobType);
  if (!parsed.success) {
    throw new Error("invalid_job_type");
  }
  const jobType = parsed.data;

  const db = getDb();
  await db.transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.requested", target: jobType });
    await enqueueSync(tx, { kind: "job", jobType });
  });
  revalidatePath("/admin/sync");

  // Same worker-liveness signal page.tsx's own render computes for the
  // worker line above the strip — read fresh here rather than threaded
  // through, since this action returns straight into the drawer with no
  // round trip through the page's own server-component render.
  //
  // A ternary, not `page.tsx`'s exhaustive switch, is a deliberate choice
  // here rather than an accidentally-narrower copy: this call site only ever
  // needs a binary "do I have a real instant or not" for `evaluateFreshness`,
  // and `heartbeat.status === "error"` is consumed directly and separately
  // below, passed straight into `queuedNotice`. A future fourth
  // `WorkerHeartbeat` variant can't silently fall through to the wrong
  // sentence here the way it could before — there is no sentence built from
  // this ternary's result, only a `Date | null` for freshness math, and
  // `queuedNotice`'s own `heartbeatErrored` param is what actually varies the
  // copy for a bad read.
  const heartbeat = await workerHeartbeat(db);
  const worker = evaluateFreshness(
    heartbeat.status === "ok" ? heartbeat.at : null,
    new Date(),
    HEARTBEAT_STALE_AFTER_MS,
  );
  const workerAge = worker.ageSec === null ? null : elapsedShort(worker.ageSec * 1000);
  return {
    text: queuedNotice(jobType, undefined, workerAge, heartbeat.status === "error"),
  };
}

export async function recheckInvalidAction(): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  await getDb().transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.recheck_requested", target: "all" });
    await enqueueSync(tx, { kind: "membership-recheck" });
  });
  revalidatePath("/admin/sync");
  redirect(`/admin/sync?queued=recheck&at=${Date.now()}`);
}

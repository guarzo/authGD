"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireAdminAction } from "@/lib/admin-guard";
import { enqueueSync } from "@/services/outbox";
import { designateStructureHolder } from "@/services/structures";

/**
 * Both actions gate themselves with `requireAdminAction`. The admin layout's
 * guard does not protect server actions and does not re-run on soft
 * navigation, so "the page checked already" is not a check.
 *
 * Neither calls ESI. This page reads Postgres and enqueues; the worker
 * performs every read.
 */

/** An id that will become a bigint column and an audit target, parsed with
 *  zod rather than cast — a server action takes whatever the wire sends.
 *  Copied verbatim from `admin/access-lists/actions.ts`: the input is a
 *  `FormDataEntryValue | null`, never bare `string`. */
const idSchema = z.preprocess(
  (value) => Number(value),
  // The `error` on the type gate is not redundant with the refine's, and both
  // are read: `parseId` below throws the code it takes off the rejected issue,
  // so a path left without one would surface zod's own generated wording as
  // the thrown message. `Number()` runs first and maps a non-numeric spelling
  // to `NaN`, which `z.number()` rejects at the gate — the refine never runs —
  // so the most likely bad input ("12abc") rejects through the gate while a
  // well-formed-but-out-of-range one ("-1") rejects through the refine. Both
  // spell it the same way, so the caller gets `invalid_id` either way.
  z
    .number({ error: "invalid_id" })
    .refine((n) => Number.isSafeInteger(n) && n > 0, { error: "invalid_id" }),
);

/** Unreachable from the rendered page, so a bad value throws rather than
 *  earning notice copy — the same posture `syncJobAction` takes on `jobType`.
 *  The code comes off the rejected issue rather than being restated here, so
 *  `invalid_id` has one spelling (the schema's) rather than two that can
 *  drift; same shape as `admin/accounts/actions.ts`'s `assertValid`. */
function parseId(value: FormDataEntryValue | null): number {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "invalid_id");
  return parsed.data;
}

/**
 * `corporationId` comes from a hidden input the page renders from the
 * candidate character's current `character.corporationId`, so the pin records
 * the corp the admin was actually looking at when they pressed the button.
 */
export async function designateStructureHolderAction(formData: FormData): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const characterId = parseId(formData.get("characterId"));
  const corporationId = parseId(formData.get("corporationId"));
  await designateStructureHolder(getDb(), characterId, corporationId, actor);
  revalidatePath("/admin/structures");
  redirect(`/admin/structures?done=holder&at=${Date.now()}`);
}

/** Asking for a read changes no state, so this writes no audit row. */
export async function checkNowAction(): Promise<void> {
  await requireAdminAction();
  const db = getDb();
  await enqueueSync(db, { kind: "job", jobType: "structures" });
  await enqueueSync(db, { kind: "job", jobType: "structure-events" });
  revalidatePath("/admin/structures");
  redirect(`/admin/structures?done=check&at=${Date.now()}`);
}

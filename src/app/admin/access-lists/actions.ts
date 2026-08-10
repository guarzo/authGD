"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireAdminAction } from "@/lib/admin-guard";
import { enqueueSync } from "@/services/outbox";
import { addWatch, designateHolder, removeWatch } from "@/services/access-lists";
import { type ActionOutcome } from "@/app/_components/confirm-group";

/**
 * Every action here gates itself with `requireAdminAction`. The admin layout's
 * guard does not protect server actions and does not re-run on soft
 * navigation, so "the page checked already" is not a check.
 *
 * None of the four calls ESI. This page reads Postgres and enqueues; the
 * worker performs every read.
 */

/** A server action takes whatever the wire sends, so an id that will become a
 *  bigint column and an audit target is parsed rather than trusted.
 *  Unreachable from the rendered page, so a bad value throws rather than
 *  earning notice copy — the same posture `syncJobAction` takes on `jobType`. */
function parseId(value: FormDataEntryValue | null): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("invalid_id");
  return n;
}

export async function designateHolderAction(formData: FormData): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const characterId = parseId(formData.get("characterId"));
  await designateHolder(getDb(), characterId, actor);
  revalidatePath("/admin/access-lists");
  redirect(`/admin/access-lists?done=holder&at=${Date.now()}`);
}

export async function addWatchAction(formData: FormData): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const accessListId = parseId(formData.get("accessListId"));
  await addWatch(getDb(), accessListId, actor);
  revalidatePath("/admin/access-lists");
  redirect(`/admin/access-lists?done=watch&at=${Date.now()}`);
}

/**
 * Enqueues the read and writes NO audit row. Asking for a read changes no
 * state, and `runJob` already records the run in `syncRun` — the same reason
 * `/admin/sync`'s re-run buttons audit at the request rather than the
 * execution, except that this request is not itself a state change at all.
 */
export async function checkNowAction(): Promise<void> {
  await requireAdminAction();
  await enqueueSync(getDb(), { kind: "job", jobType: "access-lists" });
  revalidatePath("/admin/access-lists");
  redirect(`/admin/access-lists?done=check&at=${Date.now()}`);
}

/**
 * The one action that does NOT redirect, and this is not a stylistic choice.
 * Its control sits inside that row's `Disclosure`, whose open/closed state is a
 * plain `useState` with nowhere else to live (`_components/disclosure.tsx`). A
 * `redirect()` — even back to this same route carrying nothing but
 * `?done=&at=` — replaces the whole route tree on navigation and resets that
 * `useState`, closing the drawer the admin opened in order to reach this
 * button. Two separate e2e runs have already caught this exact failure on two
 * separate pages (`/admin/accounts`'s row drawer and `/admin/sync`'s job
 * drawer); `_components/confirm-group.tsx`'s docblock is the record of both.
 * The confirmation comes back through `useActionState` instead.
 */
export async function removeWatchAction(
  _prevState: ActionOutcome,
  formData: FormData,
): Promise<ActionOutcome> {
  const { accountId: actor } = await requireAdminAction();
  const accessListId = parseId(formData.get("accessListId"));
  await removeWatch(getDb(), accessListId, actor);
  revalidatePath("/admin/access-lists");
  return { text: `Access list ${accessListId} removed from the watchlist.` };
}

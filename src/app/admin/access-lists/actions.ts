"use server";

import { z } from "zod";
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

/** An id that will become a bigint column and an audit target, parsed with
 *  zod rather than cast — a server action takes whatever the wire sends.
 *  `removeWatchAction`'s `accessListId` arrives as a submit button's own
 *  name/value, not a hidden input, so a scripted POST with no submitter gives
 *  `null`; the input type is `FormDataEntryValue | null`, never bare `string`. */
const idSchema = z.preprocess(
  (value) => Number(value),
  z.number().refine((n) => Number.isSafeInteger(n) && n > 0, { error: "invalid_id" }),
);

/** Unreachable from the rendered page, so a bad value throws rather than
 *  earning notice copy — the same posture `syncJobAction` takes on `jobType`. */
function parseId(value: FormDataEntryValue | null): number {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid_id");
  return parsed.data;
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
  const added = await addWatch(getDb(), accessListId, actor);
  revalidatePath("/admin/access-lists");
  // Two markers, because a press that inserted nothing is not the press the
  // admin thinks they made: the `<select>` only offers lists that were not
  // watched when the page rendered, so landing here means someone else added
  // it first (or this tab is a stale back-button). Unlike `removeWatchAction`
  // below there is no tone channel — this control redirects, so its copy comes
  // back through `doneNotice`/`ConfirmNotice`, which carry a sentence and
  // nothing else — so the wording is the whole of the correction.
  redirect(
    `/admin/access-lists?done=${added ? "watch" : "watch-already"}&at=${Date.now()}`,
  );
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
  const { removed, name } = await removeWatch(getDb(), accessListId, actor);
  revalidatePath("/admin/access-lists");
  // Same `#id` fallback the page itself uses for a name-less row
  // (`page.tsx`'s `label`), so the confirmation and the row it described can
  // never disagree about what an unnamed list was called.
  const label = name ?? `#${accessListId}`;
  // A press that deleted no row gets a `warn` outcome rather than the ordinary
  // confirmation, the same shape and for the same reason as
  // `admin/accounts/actions.ts`'s `not_linked` branch: the admin pressed a
  // button on a row that another tab (or another admin) had already removed,
  // and `revalidatePath` above is what makes the row disappear. Confirming it
  // as a removal would credit this press with someone else's act.
  if (!removed) {
    return { text: `${label} was already off the watchlist.`, tone: "warn" };
  }
  return { text: `${label} removed from the watchlist.` };
}

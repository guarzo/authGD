"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireAdminAction } from "@/lib/admin-guard";
import { adminAccountsErrorUrl } from "@/lib/error-redirects";
import { demoteAdmin, promoteAdmin } from "@/services/accounts";
import {
  approveAccount,
  returnTierToAuto,
  setAccountStatus,
  setStatusNote,
  setTierManual,
} from "@/services/admin-accounts";
import { logAudit } from "@/services/audit";
import { unlinkDiscord } from "@/services/discord-link";
import { enqueueSync } from "@/services/outbox";

// `not_authorized` is a real race, not a bug: the actor's own admin bit can be
// cleared by another admin (demoteAdminAction) between this row rendering and
// the click, since actions don't re-run the page's guard on soft navigation.
// Redirect to the styled notice rather than throw, same as demoteAdminAction's
// `last_admin` case below.
function redirectNotAdmin(listSearch: string): never {
  redirect(adminAccountsErrorUrl("not_admin", listSearch));
}

/**
 * The single place a mutation's error union becomes a redirect destination —
 * one switch instead of five (going on six) copy-pasted `if` chains, and
 * exhaustive the same way admin-guard's `denyAdmin` is: annotated `: never`
 * and returning (not just calling) each `redirect`, so TS only accepts this as
 * terminating control flow — and the moment a variant is added to
 * `AdminMutationResult` or `ApproveResult` without a matching case here, the
 * build fails — TS2345 at the call sites, because the widened error type is no
 * longer assignable to this function's parameter — instead of a new variant
 * silently reaching the old catch-all `throw new Error(result.error)` and
 * turning into a 500.
 *
 * `not_found` is reachable from every action here, not just approval:
 * mergeAccountInto (services/accounts.ts) deletes the source account outright
 * on merge, and isAbsorbable deliberately doesn't gate on tier, so any admin
 * control targeting an account can find the row gone between page render and
 * the click — a race between two legitimate users, not a server fault.
 *
 * `listSearch` is the page's own tier/status/sort/dir query string, bound into
 * every control by admin/accounts/page.tsx. It replaces the old `fromQueue`
 * flag and the forced `tier=pending` on `not_pending`: both were the same
 * guess, that an admin hitting one of these races was looking at the approval
 * queue, and both were wrong for everyone who was not — an admin who filtered
 * to `?status=cryo`, sorted by tier changed, and lost a race was returned to
 * an unfiltered list sorted by name. The page now hands over the view it
 * actually rendered, so nothing here has to infer it. Approval controls only
 * appear on `pending` rows, so a caller who WAS working the queue still
 * carries `tier=pending` — by observation instead of by assumption.
 *
 * Exhaustive on a SECOND axis since the destination URLs moved behind
 * `adminAccountsErrorUrl`: the `?error=` codes below are `keyof
 * ADMIN_ACCOUNTS_ERRORS`, so a code with no entry in the page's map — which
 * would redirect and then render nothing at all — fails typecheck here too.
 * The two axes are independent: the service union says which failures exist,
 * the code union says which ones the page can explain.
 */
function redirectOnMutationError(
  error: "not_authorized" | "not_found" | "not_pending",
  listSearch: string,
): never {
  switch (error) {
    case "not_authorized":
      return redirectNotAdmin(listSearch);
    case "not_pending":
      // Two admins working the queue, or one with a stale tab: the account is
      // approved, just not by them.
      return redirect(adminAccountsErrorUrl("not_pending", listSearch));
    case "not_found":
      return redirect(adminAccountsErrorUrl("not_found", listSearch));
  }
}

export async function setTierAction(
  accountId: string,
  tier: "flygd" | "blue" | "green",
  listSearch: string,
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    setTierManual(tx, actor, accountId, tier),
  );
  if (!result.ok) redirectOnMutationError(result.error, listSearch);
  revalidatePath("/admin/accounts");
}

export async function approveAction(
  accountId: string,
  tier: "green" | "blue",
  listSearch: string,
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    approveAccount(tx, actor, accountId, tier),
  );
  if (!result.ok) redirectOnMutationError(result.error, listSearch);
  revalidatePath("/admin/accounts");
}

export async function returnToAutoAction(
  accountId: string,
  listSearch: string,
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    returnTierToAuto(tx, actor, accountId),
  );
  if (!result.ok) redirectOnMutationError(result.error, listSearch);
  revalidatePath("/admin/accounts");
}

export async function setStatusAction(
  accountId: string,
  status: "active" | "cryo",
  listSearch: string,
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    setAccountStatus(tx, actor, accountId, status),
  );
  if (!result.ok) redirectOnMutationError(result.error, listSearch);
  revalidatePath("/admin/accounts");
}

// `useActionState` needs the bound action shaped `(prevState, formData) =>
// newState`, hence the extra `prevState` param ahead of `formData` — the
// write itself is a plain overwrite either way, `prevState` only exists to be
// incremented. Returning `prevState + 1` rather than a clock reading
// (`Date.now()`) is the point: a monotonic counter can't collide with itself,
// where a millisecond timestamp can — two saves resolving inside the same
// millisecond would return the same value, and the client's "did a save just
// land" check (a `state !== seen` comparison) would never fire for the
// second one, silently dropping its confirmation.
//
// Both bound args therefore sit AHEAD of `prevState`: `useActionState` supplies
// the last two, so anything the caller binds has to come first.
export async function saveNoteAction(
  accountId: string,
  listSearch: string,
  prevState: number,
  formData: FormData,
): Promise<number> {
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
  if (!result.ok) redirectOnMutationError(result.error, listSearch);
  revalidatePath("/admin/accounts");
  return prevState + 1;
}

export async function syncAccountAction(
  accountId: string,
  // The page's current tier/status/sort/dir query string, plus queued=account,
  // bound in by the caller: without it the redirect below would always land
  // on the unfiltered list, dropping whatever filter the admin was scanning.
  // A full href rather than the bare search string every other action takes,
  // because this one is the success path and picks its own destination; the
  // error paths go through `adminAccountsErrorUrl`, which owns the path.
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

export async function promoteAdminAction(
  accountId: string,
  listSearch: string,
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => promoteAdmin(tx, actor, accountId));
  if (!result.ok) {
    // promoteAdmin predates AdminMutationResult and returns `error` as
    // optional rather than discriminated on `ok` (accounts.ts is out of scope
    // for this fix); both of its `ok: false` returns set it, so this can only
    // fire if a future change to promoteAdmin forgets to.
    if (result.error === undefined) {
      throw new Error("promoteAdmin: ok:false without an error code");
    }
    redirectOnMutationError(result.error, listSearch);
  }
  revalidatePath("/admin/accounts");
}

export async function demoteAdminAction(
  accountId: string,
  listSearch: string,
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => demoteAdmin(tx, actor, accountId));
  if (!result.ok && result.error === "last_admin") {
    // Surface the service's protection instead of a 500 (carry-over).
    redirect(adminAccountsErrorUrl("last_admin", listSearch));
  }
  if (!result.ok && result.error === "not_authorized") redirectNotAdmin(listSearch);
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

/** Admin control: disconnect a member's Discord.
 *
 *  This is what `ACCOUNT_ERRORS.merge_discord` now names. A member blocked
 *  from linking a character because the SOURCE account holds a Discord link
 *  cannot clear it themselves — they are signed in as the target — so without
 *  this the only remedy was signing out and back in as the accidental account.
 *
 *  `not_found` is the merge race every control here shares. `not_linked` is a
 *  stale tab: the cell renders the control only when the row says linked, and
 *  a second admin clearing it first is not an error worth a notice.
 *
 *  Takes `listSearch` like every other mutation on this page, unlike the
 *  brief's sketch: `redirectOnMutationError` here is the same one every other
 *  action calls, and it has required the admin's current filter/sort since
 *  #89 — passing only the error code would not compile. */
export async function unlinkDiscordAction(
  accountId: string,
  listSearch: string,
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    unlinkDiscord(tx, actor, accountId, "admin"),
  );
  if (!result.ok) {
    // Every sibling passes result.error straight to redirectOnMutationError,
    // whose union does not carry "not_linked", so this one has to narrow. The
    // `never` default is what makes it exhaustive: a third variant on
    // unlinkDiscord becomes a compile error rather than a silent no-op.
    switch (result.error) {
      case "not_found":
        return redirectOnMutationError("not_found", listSearch);
      // The row is already in the state the admin asked for. Nothing to say.
      case "not_linked":
        break;
      default: {
        const unhandled: never = result.error;
        throw new Error(`unhandled unlinkDiscord error: ${String(unhandled)}`);
      }
    }
  }
  revalidatePath("/admin/accounts");
}

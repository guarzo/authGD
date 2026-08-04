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
import { enqueueSync } from "@/services/outbox";

// `not_authorized` is a real race, not a bug: the actor's own admin bit can be
// cleared by another admin (demoteAdminAction) between this row rendering and
// the click, since actions don't re-run the page's guard on soft navigation.
// Redirect to the styled notice rather than throw, same as demoteAdminAction's
// `last_admin` case below.
function redirectNotAdmin(): never {
  redirect(adminAccountsErrorUrl("not_admin"));
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
 * `fromQueue` sends `not_found` back to the pending-tier filter rather than
 * the unfiltered list: only approveAction's callers were looking at that
 * filter when they clicked. `not_pending` always goes there regardless of the
 * flag, since it can only ever be produced by approveAccount.
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
  opts: { fromQueue?: boolean } = {},
): never {
  switch (error) {
    case "not_authorized":
      return redirectNotAdmin();
    case "not_pending":
      // Two admins working the queue, or one with a stale tab: the account is
      // approved, just not by them.
      return redirect(adminAccountsErrorUrl("not_pending", { tier: "pending" }));
    case "not_found":
      return redirect(
        adminAccountsErrorUrl("not_found", opts.fromQueue ? { tier: "pending" } : {}),
      );
  }
}

export async function setTierAction(
  accountId: string,
  tier: "flygd" | "blue" | "green",
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    setTierManual(tx, actor, accountId, tier),
  );
  if (!result.ok) redirectOnMutationError(result.error);
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
  if (!result.ok) redirectOnMutationError(result.error, { fromQueue: true });
  revalidatePath("/admin/accounts");
}

export async function returnToAutoAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    returnTierToAuto(tx, actor, accountId),
  );
  if (!result.ok) redirectOnMutationError(result.error);
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
  if (!result.ok) redirectOnMutationError(result.error);
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
export async function saveNoteAction(
  accountId: string,
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
  if (!result.ok) redirectOnMutationError(result.error);
  revalidatePath("/admin/accounts");
  return prevState + 1;
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
  if (!result.ok) {
    // promoteAdmin predates AdminMutationResult and returns `error` as
    // optional rather than discriminated on `ok` (accounts.ts is out of scope
    // for this fix); both of its `ok: false` returns set it, so this can only
    // fire if a future change to promoteAdmin forgets to.
    if (result.error === undefined) {
      throw new Error("promoteAdmin: ok:false without an error code");
    }
    redirectOnMutationError(result.error);
  }
  revalidatePath("/admin/accounts");
}

export async function demoteAdminAction(accountId: string): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) => demoteAdmin(tx, actor, accountId));
  if (!result.ok && result.error === "last_admin") {
    // Surface the service's protection instead of a 500 (carry-over).
    redirect(adminAccountsErrorUrl("last_admin"));
  }
  if (!result.ok && result.error === "not_authorized") redirectNotAdmin();
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/admin/accounts");
}

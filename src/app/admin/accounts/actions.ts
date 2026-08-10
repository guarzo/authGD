"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { requireAdminAction } from "@/lib/admin-guard";
import { adminAccountsErrorUrl } from "@/lib/error-redirects";
import { tierLabel } from "@/app/_components/labels";
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
import { type ActionOutcome } from "@/app/_components/confirm-group";
import { type NoteSaveState } from "@/app/_components/note-form";
import {
  accountsConfirmation,
  accountsDiscordAlreadyUnlinked,
  accountsNoChange,
  type AdminAccountsDoneCode,
} from "./view";

/**
 * `/admin/accounts?[<listSearch>&]done=<code>&name=<name>&at=<instant>`.
 *
 * Three of this page's nine actions redirect through this on success —
 * `promoteAdminAction`, `demoteAdminAction`, `syncAccountAction`. Their
 * controls sit in the row's always-visible `cells`, not the `Disclosure`
 * drawer, so a redirect back to this same route costs nothing: nothing
 * stateful the admin cares about lives in a control that isn't there.
 * `ConfirmNotice` (mounted once, at the top of the page) is where focus
 * lands — same shape as `/account`'s `setMainAction` and `/admin/sync`'s
 * `queuedNotice`, and the same `?done=&name=&at=` triple `/account` uses.
 *
 * The other five mutating actions (`setTierAction`, `approveAction`,
 * `returnToAutoAction`, `setStatusAction`, `unlinkDiscordAction`) do NOT use
 * this — they live inside the drawer, where a redirect resets the drawer's
 * own open/closed `useState` (`disclosure.tsx`) by replacing the route tree.
 * They call `accountsConfirmation` (`view.ts`) directly and return it
 * through `useActionState` instead; see `view.ts`'s docblock for the full
 * account, including the failing e2e run that found the drawer-reset
 * problem, and `confirm-group.tsx` for how that half lands focus without
 * navigating. `unlinkDiscordAction` moved into this group under
 * docs/design-walkthrough.md's ruling R2, which moved its control off the
 * row's always-visible cells and into the drawer alongside them.
 *
 * `name` is the row's own `identity` — page.tsx's mainName-or-firstName-or-id
 * pick — bound in by the caller below rather than looked up here, so this
 * function itself makes no extra query. Same reasoning as
 * `adminAccountsErrorUrl` for carrying `listSearch`: this page is a filtered,
 * sorted list, and a row a mutation just changed may no longer be in the
 * admin's own view (a tier change can drop it straight out of a `?tier=`
 * filter), so the confirmation naming the account by name is the only trace
 * of the change left on screen. None of the three codes that still reach
 * this function (`grant`, `revoke`, `sync`) need a tier label —
 * `accountsConfirmation`'s `tier` argument is only ever read for `tier` and
 * `approve`, both handled by actions in the drawer group above — so this no
 * longer carries a `doneTier`; the earlier version of this fix did, and
 * dropping it here is what stopped it from being dead weight on every one of
 * these redirects.
 *
 * Drops `error`, `queued`, `done`, `name` and `at` from the inherited search
 * before setting them again — same one-shot-notice reasoning as
 * `adminAccountsErrorUrl`. `queued` is dropped rather than reused: this
 * supersedes the old `?queued=account` scheme `syncAccountAction` alone used
 * to carry, which named no account and used a bare `{cond && <Notice>}` that
 * defeats the live region it asked for (`ui.tsx`'s `Notice` docblock).
 */
function doneUrl(code: AdminAccountsDoneCode, listSearch: string, name: string): string {
  const search = new URLSearchParams(listSearch);
  for (const key of ["error", "queued", "done", "name", "at"]) {
    search.delete(key);
  }
  search.set("done", code);
  search.set("name", name);
  search.set("at", String(Date.now()));
  return `/admin/accounts?${search.toString()}`;
}

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

// These five (through `unlinkDiscordAction`, below) live in the row's
// `Disclosure` drawer, unlike their four siblings — and that is why they
// don't `redirect()` on success. A drawer row holds its open/closed state in
// a plain `useState` (`disclosure.tsx`) with nowhere else to live; navigating,
// even back to this exact URL, replaces the route tree and resets it,
// closing the very drawer the admin had open to press the button (an e2e run
// of the first, all-redirect version of this fix caught this: the drawer
// collapsed on the first tier change). `revalidatePath` alone refreshes the
// row without navigating, so these return their confirmation through
// `useActionState` instead, for `confirm-group.tsx`'s `ConfirmingForm` to
// carry — no `doneUrl`, no query string. See `view.ts`'s docblock for the
// full two-shapes account and `confirm-group.tsx`'s for the focus mechanics.
export async function setTierAction(
  accountId: string,
  tier: "member" | "associate" | "alumni",
  listSearch: string,
  // The row's own display identity (page.tsx's mainName-or-firstName-or-id
  // pick), bound in purely to name the account in the confirmation this
  // returns — see `view.ts`'s docblock for why the confirmation has to name
  // the account on a filtered list page.
  identity: string,
  _prevState: ActionOutcome,
  _formData: FormData,
): Promise<ActionOutcome> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    setTierManual(tx, actor, accountId, tier),
  );
  if (!result.ok) redirectOnMutationError(result.error, listSearch);
  revalidatePath("/admin/accounts");
  // Not a bare return: `ConfirmGroup`'s `Notice` (`confirm-group.tsx`) is what
  // gets focus after this action settles, and it has nothing to focus
  // without text here.
  //
  // `changed` splits a press that pinned the account from one that found it
  // already pinned to this very tier — the only shape `setTierManual` treats
  // as a no-op, and the one where "pinned to Alumni. Press auto to unpin."
  // would claim a write that never happened. Note this is NOT the same-tier
  // press on an unlocked account: that one IS the pin, writes a row, and
  // takes the success sentence.
  const label = tierLabel(tier);
  return {
    text: result.changed
      ? accountsConfirmation("tier", identity, label)
      : accountsNoChange("tier", identity, label),
  };
}

export async function approveAction(
  accountId: string,
  tier: "alumni" | "associate",
  listSearch: string,
  identity: string,
  _prevState: ActionOutcome,
  _formData: FormData,
): Promise<ActionOutcome> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    approveAccount(tx, actor, accountId, tier),
  );
  if (!result.ok) redirectOnMutationError(result.error, listSearch);
  revalidatePath("/admin/accounts");
  // The pending-only "Approve as …" buttons unmount into the ordinary
  // three-tier row the instant approval succeeds.
  return { text: accountsConfirmation("approve", identity, tierLabel(tier)) };
}

export async function returnToAutoAction(
  accountId: string,
  listSearch: string,
  identity: string,
  _prevState: ActionOutcome,
  _formData: FormData,
): Promise<ActionOutcome> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    returnTierToAuto(tx, actor, accountId),
  );
  if (!result.ok) redirectOnMutationError(result.error, listSearch);
  revalidatePath("/admin/accounts");
  // The "auto" button only renders while `r.tierLocked`, so it unmounts
  // outright the moment this succeeds — the tier it exists to unlock is gone.
  // When it does not (`changed: false`, an account that was never locked),
  // the button is still there and the sentence has to explain why.
  return {
    text: result.changed
      ? accountsConfirmation("auto", identity, undefined)
      : accountsNoChange("auto", identity, undefined),
  };
}

export async function setStatusAction(
  accountId: string,
  status: "active" | "cryo",
  listSearch: string,
  identity: string,
  _prevState: ActionOutcome,
  _formData: FormData,
): Promise<ActionOutcome> {
  const { accountId: actor } = await requireAdminAction();
  const result = await getDb().transaction((tx) =>
    setAccountStatus(tx, actor, accountId, status),
  );
  if (!result.ok) redirectOnMutationError(result.error, listSearch);
  revalidatePath("/admin/accounts");
  // freeze/wake are two branches of the same slot (page.tsx), so whichever
  // one was pressed unmounts into the other — unless nothing changed, in
  // which case the same button is still sitting there and saying "frozen"
  // would read as though it had just done something.
  const done = status === "cryo" ? "freeze" : "wake";
  return {
    text: result.changed
      ? accountsConfirmation(done, identity, undefined)
      : accountsNoChange(done, identity, undefined),
  };
}

// `useActionState` needs the bound action shaped `(prevState, formData) =>
// newState`, hence the extra `prevState` param ahead of `formData` — the
// write itself is a plain overwrite either way, `prevState` only exists to be
// incremented. Returning `prevState.seq + 1` rather than a clock reading
// (`Date.now()`) is the point: a monotonic counter can't collide with itself,
// where a millisecond timestamp can — two saves resolving inside the same
// millisecond would return the same value, and the client's "did a save just
// land" check (a `state.seq !== seen` comparison) would never fire for the
// second one, silently dropping its confirmation. The counter therefore
// advances even when `setStatusNote` wrote nothing; `changed` is what carries
// that apart, so `NoteForm` can say "already saved" instead of "saved".
//
// Both bound args therefore sit AHEAD of `prevState`: `useActionState` supplies
// the last two, so anything the caller binds has to come first.
export async function saveNoteAction(
  accountId: string,
  listSearch: string,
  prevState: NoteSaveState,
  formData: FormData,
): Promise<NoteSaveState> {
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
  return { seq: prevState.seq + 1, changed: result.changed };
}

export async function syncAccountAction(
  accountId: string,
  // The page's current tier/status/sort/dir query string, bound in by the
  // caller — same reasoning every other mutation on this page carries it: an
  // admin who filtered or sorted the list must land back on that view, not
  // the unfiltered default. Used to take a full pre-built `redirectTo` href
  // instead; that shape predates `doneUrl` naming the account, which needs
  // `listSearch` and `identity` as separate values rather than one baked URL.
  listSearch: string,
  identity: string,
): Promise<void> {
  const { accountId: actor } = await requireAdminAction();
  await getDb().transaction(async (tx) => {
    await logAudit(tx, { actor, action: "sync.requested", target: accountId });
    await enqueueSync(tx, { kind: "account", accountId });
  });
  revalidatePath("/admin/accounts");
  redirect(doneUrl("sync", listSearch, identity));
}

export async function promoteAdminAction(
  accountId: string,
  listSearch: string,
  identity: string,
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
  // "grant" unmounts into "revoke" the instant this succeeds.
  redirect(doneUrl("grant", listSearch, identity));
}

export async function demoteAdminAction(
  accountId: string,
  listSearch: string,
  identity: string,
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
  // "revoke" unmounts into "grant" the instant this succeeds.
  redirect(doneUrl("revoke", listSearch, identity));
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
 *  a second admin clearing it first between that render and this press. It is
 *  not an unhandled error, but it is worth a notice — see the case below and
 *  `view.ts`'s `accountsDiscordAlreadyUnlinked`.
 *
 *  Moved into the drawer group above (docs/design-walkthrough.md, ruling R2):
 *  this control used to sit in the row's always-visible cells and redirect
 *  through `doneUrl` like `promoteAdminAction`/`demoteAdminAction` still do,
 *  but it is now the rare, destructive control ruling R2 moves behind
 *  per-row disclosure, so it takes this file's other shape — `ActionOutcome`
 *  through `useActionState`, no redirect — for the same reason
 *  `setTierAction` and its three siblings already do. */
export async function unlinkDiscordAction(
  accountId: string,
  listSearch: string,
  identity: string,
  _prevState: ActionOutcome,
  _formData: FormData,
): Promise<ActionOutcome> {
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
      // Unlike every other race this switch handles, this one is not a
      // no-op: the row still reads as linked, because the drawer group that
      // renders this control is gated on exactly that (`page.tsx`), and
      // nothing else has re-run the query since. `/account`'s own
      // `unlinkDiscordAction` gets away with silence on the identical race
      // because it redirects and the fresh render corrects the display for
      // free; this control's redirect-free drawer shape means the stale
      // "linked" state would otherwise sit under the admin's press with no
      // notice at all. `revalidatePath` clears the display; the `tone: "warn"`
      // outcome (`confirm-group.tsx`'s `ActionOutcome`) is what tells the
      // admin their press did not do what they thought it would.
      case "not_linked":
        revalidatePath("/admin/accounts");
        return { text: accountsDiscordAlreadyUnlinked(identity), tone: "warn" };
      default: {
        const unhandled: never = result.error;
        throw new Error(`unhandled unlinkDiscord error: ${String(unhandled)}`);
      }
    }
  }
  revalidatePath("/admin/accounts");
  // The Discord drawer group unmounts entirely the instant a genuine unlink
  // succeeds — `r.discordLinked` is what gates it (page.tsx). This sentence
  // survives that only because the `ConfirmGroup` hosting it is hoisted above
  // that conditional; nested inside, it would be returned into a subtree
  // already being removed and never paint. Anything else this action wants to
  // say after a success has the same constraint.
  return { text: accountsConfirmation("discord", identity, undefined) };
}

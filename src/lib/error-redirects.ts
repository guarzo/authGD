/**
 * The `?error=` codes `/login`, `/account` and `/admin/accounts` can render,
 * the copy each one shows, and the typed URL builders that produce them.
 *
 * Same invariant `src/app/payouts/errors.ts` holds for the payout pages: a code
 * with no entry in the destination page's map renders nothing at all — the page
 * loads unchanged with no explanation, which is the one failure these pages
 * cannot show a member. Every producer now goes through a builder typed to its
 * destination's own union, so a bad code is a typecheck failure rather than a
 * deploy.
 *
 * WHY `src/lib/` AND NOT `src/app/`. Payouts could colocate because every
 * producer was already under `src/app/`. These cannot: `src/lib/admin-guard.ts`
 * redirects to `/account?error=not_admin`, and nothing outside `src/app/`
 * imports `src/app/` anywhere in this repo. Putting these under `src/app/`
 * would make admin-guard the first inversion, for a UI string. admin-guard
 * already hardcodes that exact URL and already imports `next/navigation`; this
 * module only names what was there, and itself imports nothing.
 *
 * WHY BUILDERS RETURNING A STRING, and not payouts' `: never` redirectors.
 * Two incompatible mechanisms consume these. Server actions and page guards
 * call `redirect()` from `next/navigation`, which returns `never` — and
 * `denyAdmin` and `redirectOnMutationError` both depend on that `never` for
 * their exhaustiveness over a service error union. The OAuth callbacks are
 * route handlers that must *return a Response*, built by a local `to()`
 * wrapping `NextResponse.redirect`. A `: never` helper cannot be returned from
 * a route handler, and a Response-returning one would destroy the `never` the
 * two switches rely on. A string sits underneath both, and neither loses
 * anything. It also lets a single call site pick between two DESTINATIONS —
 * `to(sess ? accountErrorUrl("link_expired") : loginErrorUrl("session_expired"))`
 * — with each branch checked against its own page's union. A per-file helper
 * could not: the code and its destination have to be typed together.
 *
 * THREE MAPS, NOT ONE, and codes are deliberately NOT globally unique.
 * `not_admin` appears in both `/account` and `/admin/accounts` with different
 * copy, and both are correct for where they land: `/account` is where a
 * genuinely de-roled admin is sent ("your admin access was removed"), while
 * `/admin/accounts` is reached by a stale tab whose actor lost the bit between
 * render and click ("refresh to see the current state"). One message would be
 * wrong on one of them, and `not_admin_account` / `not_admin_admin` would be
 * uniqueness as bookkeeping with no property gained. `session_expired` likewise
 * reaches `/login` from four unrelated producers. Each page's map is its
 * namespace; the types are what make that namespace enforceable.
 */

/** Codes reaching `/login`. `oauth_*` come from the EVE callback;
 *  `session_expired` from account/actions.ts, account/page.tsx, admin-guard.ts
 *  and either callback when the session is gone mid-link. Sign-in links expire
 *  10 minutes after you start them (src/services/oauth-tx.ts). */
export const LOGIN_ERRORS = {
  oauth_denied: "Sign-in was cancelled. No access was granted.",
  oauth_expired:
    "That sign-in link expired before you finished. They last 10 minutes. Start again below.",
  oauth_failed:
    "EVE couldn't be reached, so sign-in didn't finish. Nothing changed. Try again.",
  session_expired: "Your session ended. Sign in again below.",
} as const;

/**
 * Which `/login` codes are not faults, and so must not render in the alarm
 * tone. PRODUCT.md principle 4: "Reserve alarm colour for things the user can
 * and should fix." A member who clicked cancel on EVE's consent screen chose
 * that, and a session cookie reaching its TTL is the cookie doing its job —
 * neither is broken, and painting both `bad` told four different stories in one
 * colour. The two that remain `bad` are genuine faults: a link that ran out
 * before the member finished, and EVE being unreachable.
 *
 * CARRIED ALONGSIDE THE MAP, NOT INSIDE IT. Moving the values to
 * `{tone, text}` would either diverge `LOGIN_ERRORS` from its two siblings
 * below, or force the same reshape through `/account` and `/admin/accounts` —
 * and through the payout pages as well, because `lookupErrorMessage` is
 * re-exported by `src/app/payouts/errors.ts` and read against `OPERATION_ERRORS`
 * and `NEW_OPERATION_ERRORS` too. That is five maps across four surfaces to
 * restyle one notice. A sparse sidecar keyed by the same union costs nothing to
 * the four maps that do not want it, and stays typed: a code renamed in
 * `LOGIN_ERRORS` fails to compile here.
 *
 * Sparse on purpose — a `LOGIN_ERRORS` code that is absent here renders `bad`,
 * so the default is still the loud one and a new code has to opt out
 * deliberately rather than be quietly demoted by forgetting to list it. (A
 * string that is not a `LOGIN_ERRORS` key at all is a separate case, and
 * `loginErrorTone` below handles it separately.)
 */
export const LOGIN_ERROR_TONES: Partial<Record<LoginErrorCode, "info">> = {
  oauth_denied: "info",
  session_expired: "info",
};

/** The tone `/login` should render `code` in.
 *
 *  `bad` is reserved for a code that actually resolves to a message: no code at
 *  all, and a code nobody recognises, both render an EMPTY slot, and `Notice`
 *  derives `role` from the tone whether or not the slot has text in it. Sending
 *  those through the `bad` branch would put `role="alert"` — the assertive one —
 *  on every ordinary visit to the sign-in page, for a region that stays empty.
 *  Inert in practice, since this page only ever fills that slot by a full
 *  navigation, but an empty assertive region is not a thing to leave lying
 *  around on the app's front door. The sparse default still holds where it was
 *  meant to: a real code with no sidecar entry is `bad`. */
export function loginErrorTone(code: string | undefined): "bad" | "info" {
  if (code === undefined || !Object.hasOwn(LOGIN_ERRORS, code)) return "info";
  return Object.hasOwn(LOGIN_ERROR_TONES, code) ? "info" : "bad";
}

/** Codes reaching `/account`. All but `not_admin` and `stale_character` are
 *  emitted by a callback route redirect. The distinction the copy has to carry
 *  is "retry works" (expired/failed) versus "retrying will do the same thing"
 *  (`merge_*`). Sign-in links expire 10 minutes after you start them
 *  (src/services/oauth-tx.ts).
 *
 *  THE `merge_*` SET IS ONE REFUSAL WITH SEVEN REASONS, not seven failures.
 *  Each maps 1:1 to a `MergeBlocker` from src/services/accounts.ts, and the
 *  split exists because the remedies differ: the first five name a field an
 *  admin clears from /admin/accounts in seconds, and the last two have no
 *  cheap fix and must not pretend otherwise. The generic `already_linked` this
 *  set replaced said only "ask an admin" — which sent members looking for an
 *  admin merge tool that does not exist, when clearing a stale status note
 *  would have done it.
 *
 *  Both audiences read these. A member who isn't an admin still gets a usable
 *  sentence ("ask an admin to clear X") rather than a dead end, and the admin
 *  they forward it to is told the lever by name. Nothing here leaks: this copy
 *  is reachable only after EVE confirmed the caller's owner hash matches the
 *  account being described, so they provably own both sides. */
export const ACCOUNT_ERRORS = {
  already_linked:
    "That character belongs to an account with its own history, so it can't be merged automatically. Ask an admin.",
  merge_admin:
    "That character sits on an account with admin rights. An admin can remove those, then link it again.",
  merge_tier_locked:
    "That character sits on an account with a manually set tier. An admin can return it to automatic, then link it again.",
  merge_status:
    "That character sits on an account that isn't active. An admin can reactivate it, then link it again.",
  merge_note:
    "That character sits on an account carrying an admin note. An admin can clear the note, then link it again.",
  merge_discord:
    "That character sits on an account with its own Discord link. An admin can remove it, then link it again.",
  merge_characters:
    "That character sits on an account with other characters of its own, so it can't be merged automatically. Ask an admin.",
  merge_payouts:
    "That character sits on an account with payout history, so it can't be merged automatically. Ask an admin.",
  discord_already_linked: "That Discord account is already linked to another account.",
  discord_denied: "Discord authorization was cancelled.",
  discord_expired:
    "That Discord link expired before it finished. Nothing changed. Start it again below.",
  discord_failed:
    "Discord couldn't be reached, so the link didn't finish. Nothing changed. Try again.",
  link_expired:
    "That character link expired before it finished. Nothing changed. Start it again below.",
  link_failed:
    "EVE couldn't be reached, so the character didn't finish linking. Nothing changed. Try again.",
  stale_character:
    "That character isn't on this account anymore. The page below is current.",
  not_admin: "Your admin access was removed. This is your account page.",
} as const;

/** Codes reaching `/admin/accounts`. Every one of these is a race between two
 *  legitimate admins rather than a fault, which is why they are notices on a
 *  refreshed list and not error-boundary throws. */
export const ADMIN_ACCOUNTS_ERRORS = {
  last_admin: "Cannot demote the last admin.",
  not_admin:
    "Your admin access changed since this page loaded. Refresh to see the current state.",
  not_pending:
    "That account was already approved by someone else. Refresh to see its current tier.",
  // Shared by every admin mutation, not just approval (actions.ts): the merge
  // feature can delete the row an admin's control targeted between page
  // render and click, regardless of which action they clicked.
  not_found:
    "That account is gone: its character was linked to another account and merged in. There's nothing left to act on.",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERRORS;
export type AccountErrorCode = keyof typeof ACCOUNT_ERRORS;
export type AdminAccountsErrorCode = keyof typeof ADMIN_ACCOUNTS_ERRORS;

/** `/login?error=<code>`. */
export function loginErrorUrl(code: LoginErrorCode): string {
  return `/login?error=${code}`;
}

/** `/account?error=<code>`. */
export function accountErrorUrl(code: AccountErrorCode): string {
  return `/account?error=${code}`;
}

/**
 * `/admin/accounts?[<the list's own params>&]error=<code>`.
 *
 * The only one of the three that carries anything besides the code, and the
 * reason is that this page is a filtered, sorted list an admin is scanning
 * rather than a single fixed screen. `listSearch` is that list's own query
 * string — `tier`, `status`, `sort`, `dir` — handed over by
 * admin/accounts/page.tsx, which bound it into every control it rendered. Every
 * code here is a race between two legitimate admins, so the admin is going to
 * carry on working immediately after reading the notice, and returning them to
 * the unfiltered default list sorted by name is throwing away the view they
 * built.
 *
 * This supersedes the earlier forced `tier=pending`, which sent `not_pending`
 * and a queue-raised `not_found` to the pending filter on the theory that only
 * the approval queue produced them. That theory was right about the approval
 * queue and silently wrong about everyone else: `not_found` reaches every
 * mutation on the page (the merge feature can delete any row mid-scan), so an
 * admin filtered to `?status=cryo` lost their filter, and an admin already on
 * `?tier=pending` had it "restored" without their sort. Nothing has to be
 * guessed now — the page knows which view it rendered and says so.
 *
 * `error` and `queued` are dropped off the inherited string before the new
 * `error` is set: both are one-shot notices belonging to the request that
 * produced them, and re-emitting `queued=account` would show "Sync queued"
 * again beside a failure notice. `URLSearchParams` rather than concatenation —
 * same reason `createFailed` does (src/app/payouts/actions.ts) — so the
 * inherited params are preserved by construction. They keep the page's own
 * emission order and `error` lands last.
 *
 * Required, with no default. An omitted `listSearch` would compile to exactly
 * the unfiltered redirect this parameter exists to prevent, and it would fail
 * silently — a lost filter looks like a page that merely loaded. There is
 * nothing a default could mean here that is not the bug.
 */
export function adminAccountsErrorUrl(
  code: AdminAccountsErrorCode,
  listSearch: string,
): string {
  const search = new URLSearchParams(listSearch);
  search.delete("error");
  search.delete("queued");
  search.set("error", code);
  return `/admin/accounts?${search.toString()}`;
}

/** Reads a code that came off the query string, where it is a `string` and not
 *  yet one of ours — anyone can type `?error=nonsense`. An unrecognized code
 *  yields no message and the page renders without a notice, exactly as it did
 *  before these maps were typed. What changed is that a code WE emit can no
 *  longer be the unrecognized one: the builders above only accept keys of these
 *  maps. Shared with `src/app/payouts/errors.ts`, which holds the same
 *  invariant for the payout pages. */
export function lookupErrorMessage(
  map: Readonly<Record<string, string>>,
  code: string | undefined,
): string | undefined {
  return code !== undefined && Object.hasOwn(map, code) ? map[code] : undefined;
}

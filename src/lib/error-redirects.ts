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
  oauth_denied: "Nothing changed. No access was granted. Sign in whenever you're ready.",
  oauth_expired:
    "That sign-in link expired before you finished. They last 10 minutes. Start again below.",
  oauth_failed:
    "EVE couldn't be reached, so sign-in didn't finish. Nothing changed. Try again.",
  session_expired: "Your session ended. Sign in again to pick up where you left off.",
} as const;

/** Codes reaching `/account`. All but `not_admin` and `stale_character` are
 *  emitted by a callback route redirect. The distinction the copy has to carry
 *  is "retry works" (expired/failed) versus "retrying will do the same thing"
 *  (`merge_*`). Sign-in links expire 10 minutes after you start them
 *  (src/services/oauth-tx.ts).
 *
 *  THE `merge_*` SET IS ONE REFUSAL WITH SEVEN REASONS, not seven failures.
 *  Each maps 1:1 to a `MergeBlocker` from src/services/accounts.ts, and the
 *  split exists because the remedies differ: the first four name a field an
 *  admin clears from /admin/accounts in seconds, and the last three have no
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
  merge_characters:
    "That character sits on an account with other characters of its own, so it can't be merged automatically. Ask an admin.",
  merge_discord:
    "That character sits on an account with its own Discord link, so it can't be merged automatically. Ask an admin.",
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
 * `/admin/accounts?[tier=…&]error=<code>`.
 *
 * The only one of the three that carries a second param: `not_pending` and a
 * `not_found` raised from the approval queue both send the admin back to the
 * pending FILTER they were working, not the unfiltered list. Built with
 * `URLSearchParams` rather than concatenated — same reason `createFailed` does
 * (src/app/payouts/actions.ts) — so the extra param is preserved by
 * construction instead of by remembering to include it. `tier` is emitted
 * before `error`, matching the URLs these call sites wrote by hand.
 */
export function adminAccountsErrorUrl(
  code: AdminAccountsErrorCode,
  params: { tier?: "pending" } = {},
): string {
  const search = new URLSearchParams();
  if (params.tier) search.set("tier", params.tier);
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

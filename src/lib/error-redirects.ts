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
 *  (already_linked). Sign-in links expire 10 minutes after you start them
 *  (src/services/oauth-tx.ts). */
export const ACCOUNT_ERRORS = {
  already_linked:
    "That character belongs to an account with its own history, so it can't be merged automatically. Ask an admin.",
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

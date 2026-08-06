import type { NavItem } from "./ui";

/**
 * The one list of shell destinations, and the one place that decides who gets
 * to see which of them. Before this file the same five links were hand-copied
 * into ten call sites across eight components — `admin-nav.tsx`, three
 * `payouts/*` pages, `account/page.tsx`, and three session-blind boundaries —
 * and each copy re-derived its own subset from whatever the surrounding page
 * happened to know. That made membership a property of the *section* you were
 * standing in rather than of *you*: an admin on `/admin/audit` had no route to
 * `/payouts` anywhere in the chrome, not because the rule said so but because
 * `admin-nav.tsx`'s `ITEMS` array had never been taught payouts existed. The
 * bug was the architecture, not a missing conditional.
 *
 * The rule this module encodes instead: the bar lists every destination the
 * viewer is *provably authorized to reach*, independent of which one of those
 * destinations they are currently on.
 *
 *   Your account  — always
 *   Payouts       — iff canReadPayouts (tier === "member"; services/payouts.ts)
 *   Members       — iff isAdmin
 *   Audit log     — iff isAdmin
 *   Sync          — iff isAdmin
 *
 * `isAdmin` and `tier` are orthogonal columns (db/schema.ts) — an admin is not
 * necessarily a payouts reader (default tier is `alumni`), and a payouts
 * reader is not necessarily an admin. `navFor` takes both bits explicitly
 * rather than inferring one from the other, so there is no call site left that
 * can render Payouts unconditionally just because the viewer is an admin.
 *
 * Order is fixed and identical everywhere: Your account, Payouts, Members,
 * Audit log, Sync — broadest access first. A member-only reader, a payouts
 * reader, and an admin all see a strict prefix (in membership, not merely in
 * count) of the same five-item list, in the same order, rather than five
 * per-surface orderings that happened to agree by convention. This is also
 * why the admin bar's order changes here: "Your account" moves from last to
 * first. That is a consequence of there being one order, not a separate
 * decision about the admin bar.
 *
 * The label strings live here exactly once, which is the point rather than a
 * side effect. Two routes carrying two names for one destination fails WCAG
 * 3.2.4 Consistent Identification — the same link has to read the same way
 * everywhere a reader (sighted or not) can encounter it. `error.tsx` used to
 * carry its own `ADMIN_ITEMS` copy with a comment asking a future editor to
 * hand-sync it with `admin-nav.tsx`'s `ITEMS` whenever the list changed. A
 * hand-sync comment is a bug report against the architecture: it is only
 * needed because two arrays exist to drift apart. With one array, "keep them
 * in sync" is not an instruction a comment has to give — there is nothing
 * left to keep in sync.
 *
 * "Members", not "Accounts", for the destination at `/admin/accounts`: the
 * member nav shows "Your account" and the admin nav shows this one beside it,
 * so the shared name cannot contain "account" — a pair reading "Your account
 * | Accounts" is separated only by a possessive, which is not a distinction a
 * reader should have to notice to tell the two apart. "Members" names the same
 * thing the page's own H1 does and collides with nothing else in the bar.
 *
 * `navFor` is the rule. `navFromPath` is the same rule run with weaker
 * evidence, for the three surfaces that cannot read a session at all
 * (`error.tsx`, `not-found.tsx`, `payouts/[id]/not-found.tsx`) and have only
 * the URL to go on. It is written as calls to `navFor`, not as a second
 * literal list, so that "the boundary is the same rule under weaker evidence"
 * is a fact about the code rather than a claim in a comment:
 *
 *   - `/admin/*`   proves nothing about tier, but the route itself is behind
 *     the admin guard — so `isAdmin: true`. It cannot prove payouts access
 *     (tier and isAdmin are orthogonal, see above), so `canReadPayouts: false`
 *     — the safe direction, since the alternative is a link that bounces.
 *   - `/payouts/*` is behind `requirePayoutReader`, proving `canReadPayouts:
 *     true`. It proves nothing about `isAdmin` — that bit is exactly what a
 *     payouts-scoped guard does not check — so `isAdmin: false`.
 *   - anything else (including an unrouted 404, which cleared no guard at
 *     all) proves neither, so both are `false` and the bar is just
 *     `Your account`.
 */

const ACCOUNT: NavItem = { href: "/account", label: "Your account" };
const PAYOUTS: NavItem = { href: "/payouts", label: "Payouts" };
const MEMBERS: NavItem = { href: "/admin/accounts", label: "Members" };
const AUDIT: NavItem = { href: "/admin/audit", label: "Audit log" };
const SYNC: NavItem = { href: "/admin/sync", label: "Sync" };

/** So `AdminNav` can attach the pending badge to the Members item without
 *  re-typing its route string a second time. */
export const MEMBERS_HREF = MEMBERS.href;

/**
 * Exported for `error.tsx`'s "Back to …" escape link, which names one of these
 * destinations in a button rather than in the bar. It is the same destination
 * under the same name, so it has to be the same string — a "Back to Members"
 * button beside a nav that had been renamed is the WCAG 3.2.4 divergence this
 * module exists to prevent, just reached from the button instead of from a
 * second array.
 *
 * The third branch of that escape does NOT use these: it hand-writes "your
 * account", lower-cased, because that label lands mid-sentence and is a common
 * noun where these two are proper names of sections. That one is a sentence
 * fragment that happens to resemble a label, not a copy of one, and it is
 * correct for it to live at its own call site.
 */
export const MEMBERS_ITEM = MEMBERS;
export const PAYOUTS_ITEM = PAYOUTS;

export type Reach = { canReadPayouts: boolean; isAdmin: boolean };

/** The rule, given what is provably true about the viewer. */
export function navFor({ canReadPayouts, isAdmin }: Reach): NavItem[] {
  return [
    ACCOUNT,
    ...(canReadPayouts ? [PAYOUTS] : []),
    ...(isAdmin ? [MEMBERS, AUDIT, SYNC] : []),
  ];
}

/**
 * `/admin` and `/admin/…`, but not `/admin-old`. The whole rule in this module
 * is that a link is offered only on proof, and "the string starts with these
 * letters" is not proof: a sibling route whose name merely shares a prefix sits
 * behind none of the guards the branch below is citing.
 *
 * Not reachable today — no such route exists, and an unmatched URL renders the
 * root `not-found.tsx`, which calls `navFor` directly rather than coming
 * through here. It is the next `/admin-old`-shaped route that would make it
 * reachable, which is exactly when nobody would think to look at this file.
 *
 * Exported because `error.tsx` branches on the same question a second time, for
 * its `admin` register marker and its "Back to …" escape. Two spellings of one
 * predicate is how the chrome ends up claiming ADMIN over a member's nav.
 */
export function inSection(pathname: string, section: string): boolean {
  return pathname === section || pathname.startsWith(`${section}/`);
}

/**
 * The same rule, evaluated from the URL alone — see the module docblock for
 * why each branch proves what it claims. Expressed as `navFor` calls rather
 * than separate literal arrays, so a change to the rule above cannot be
 * applied to a session-aware surface while silently missing a session-blind
 * one.
 */
export function navFromPath(pathname: string): NavItem[] {
  if (inSection(pathname, "/admin")) {
    return navFor({ canReadPayouts: false, isAdmin: true });
  }
  if (inSection(pathname, "/payouts")) {
    return navFor({ canReadPayouts: true, isAdmin: false });
  }
  return navFor({ canReadPayouts: false, isAdmin: false });
}

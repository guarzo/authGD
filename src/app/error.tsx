"use client";

import { useEffect, useTransition } from "react";
import { usePathname } from "next/navigation";
import { FocusHeading } from "@/app/_components/focus-heading";
import { Notice, SiteHeader, type NavItem } from "@/app/_components/ui";

/**
 * Route-level error boundary (App Router: client component, `{error, reset}`).
 * This is the landing spot for every server action's genuine bugs — the ones
 * actions deliberately still throw rather than redirect for, per the decision
 * in admin/accounts/actions.ts and account/actions.ts. Without this file, that
 * throw fell through to Next's unstyled digest page, on surfaces as routine as
 * clicking SYNC NOW (a DB hiccup while enqueueing the job is enough to hit it;
 * the web tier never calls ESI directly, so an ESI outage itself shows up in
 * the worker, not here).
 *
 * `error.digest` is the only thing shown from the thrown value: it is a
 * correlation id, not the message, so it is safe to print. The message itself
 * (`error.message`) is never rendered — it can carry a raw DB or ESI string
 * that means nothing to a member and shouldn't be handed to one.
 *
 * There is deliberately no `global-error.tsx` beside this file, and it is not
 * an oversight. That boundary catches only two things this one cannot: a throw
 * inside `RootLayout`, and a throw inside this file. `RootLayout` is font
 * registration and a `<body>` — the faces are self-hosted at build time, so it
 * has no request-time failure path — and this file reads one optional string
 * off `error`. The cost of covering them is not small: `global-error.tsx` must
 * emit its own `<html>`/`<body>`, so it renders *without* the root layout and
 * therefore without `globals.css` and both faces. That is a second, divergent,
 * permanently off-brand copy of the shell for a failure this layout cannot
 * produce. Leave it absent.
 */

// Matched to `admin-nav.tsx`'s own list, "Members" included — the same route
// must not acquire a second name just because the page under it threw
// (WCAG 3.2.4). If that list changes, this one has to follow.
const ADMIN_ITEMS: NavItem[] = [
  { href: "/admin/accounts", label: "Members" },
  { href: "/admin/audit", label: "Audit log" },
  { href: "/admin/sync", label: "Sync" },
  { href: "/account", label: "Your account" },
];

// `payouts/page.tsx` builds this same pair and appends `Members` when
// `access.isAdmin` — which is exactly the bit a client boundary cannot read.
// The subset is the safe half: a payouts reader who is also an admin loses one
// shortcut, rather than a plain reader being shown a link that bounces.
const PAYOUT_ITEMS: NavItem[] = [
  { href: "/account", label: "Your account" },
  { href: "/payouts", label: "Payouts" },
];

const MEMBER_ITEMS: NavItem[] = [{ href: "/account", label: "Your account" }];

/**
 * Which register the boundary is framing, derived from the URL because the URL
 * is the only session-free signal a client component has.
 *
 * The honesty question is worth answering in writing rather than leaving to
 * the next reader, because this shows an `ADMIN` marker to someone whose admin
 * bit was never checked here. The path is evidence, not proof: `/admin/*` is
 * behind the admin guard and `/payouts/*` behind `requirePayoutReader`, so a
 * member standing on either one cleared that guard at their last render. The
 * gap is a de-role landing between that render and this throw. What that
 * member gets is links that redirect them to `/account` when followed — which
 * is precisely where the un-branched boundary sent them anyway. So the bad
 * case costs one extra hop and the good case stops stranding an admin four
 * destinations away from the section they were working in. That trade is worth
 * taking; a wrong chrome that self-corrects on click is a smaller lie than a
 * member-shaped page handed to an admin every time.
 *
 * It is a *deliberately* different answer from the one `not-found.tsx` gives.
 * That file also cannot read the session and shows a minimal nav anyway —
 * because it has no path evidence at all. An unrouted URL proves nothing about
 * who is holding it. This one is standing on a guarded route.
 */
function sectionFor(pathname: string): {
  items: NavItem[];
  admin: boolean;
  back: NavItem;
} {
  if (pathname.startsWith("/admin")) {
    return {
      items: ADMIN_ITEMS,
      admin: true,
      back: { href: "/admin/accounts", label: "Members" },
    };
  }
  if (pathname.startsWith("/payouts")) {
    return {
      items: PAYOUT_ITEMS,
      admin: false,
      back: { href: "/payouts", label: "Payouts" },
    };
  }
  return {
    items: MEMBER_ITEMS,
    admin: false,
    // Lower-cased where the nav item is capitalised: this label lands
    // mid-sentence inside "Back to …", and the other two are proper names of
    // sections while this one is a common noun.
    back: { href: "/account", label: "your account" },
  };
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  const [retrying, startRetry] = useTransition();

  // The only trace a client-side failure leaves anywhere. A throw from one of
  // the app's client components never reaches a server log and — measured, not
  // assumed — carries no `digest` either, so without this line the incident is
  // recorded nowhere at all and the member has nothing to relay. Server throws
  // are already in Next's own log under the same digest shown below; this is
  // duplicate for those and the sole record for the rest.
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <>
      {/* React hoists this into <head>, and it wins: measured on `/payouts`
          with its list query broken, whose `page.tsx` exports a static
          `metadata.title = "Payouts"` that resolves regardless, the tab reads
          "Something broke · Zoo Landers". Do not carry that result across to
          `payouts/[id]/not-found.tsx` — the opposite was measured there, and
          that file's comment records it. A not-found boundary loses to the
          segment's resolved `metadata`; an error boundary, which replaces the
          segment rather than rendering beside its metadata, does not. */}
      <title>Something broke · Zoo Landers</title>
      <SiteHeader items={section.items} admin={section.admin} />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          {/* Same mechanism and the same reason as the two 404 boundaries: the
              subtree is swapped in place with no document load, the control
              that was pressed unmounts, and focus falls to `<body>`. It earns
              more here than it does there, because of what a failed retry
              does — see the button. */}
          <FocusHeading>Something broke</FocusHeading>
          <p className="page__lede">
            That&rsquo;s a fault on this end, not something you did. If you had just
            submitted something, check whether it took effect before you send it again.
          </p>
        </div>

        {/* The lede used to open "The request didn't go through." — a claim
            this component has no evidence for. All it holds is a thrown Error
            and an optional digest, which prove the render or the action ended
            badly and nothing about whether the write landed. This file's own
            comment names the counterexample four paragraphs up: a DB hiccup
            *while enqueueing* is a throw that follows a committed tier change.
            `e2e/admin.spec.ts` records the team hitting the same sentence from
            the other side and calling it a lie. The replacement keeps the
            fault assignment verbatim — it is the best sentence on the page —
            and spends the freed clause on the one thing that changes the
            member's next move. */}

        <Notice tone="bad">
          {error.digest ? (
            <>
              Try again. If it keeps happening, tell an admin what you were doing and
              quote reference <code className="mono">{error.digest}</code>.
            </>
          ) : (
            // Measured: a component that throws during render reaches this
            // boundary with `digest` undefined. The old markup dropped the
            // whole line in that case and left the instruction pointing at
            // nothing, so a member told to "tell an admin" had nothing to
            // tell them.
            <>
              Try again. If it keeps happening, tell an admin what you were doing and
              roughly when — there&rsquo;s no reference for this one.
            </>
          )}
        </Notice>

        <div className="btn-row">
          {/* `aria-busy` alone, no `disabled`: the styling for it already
              exists at globals.css `.btn[aria-busy="true"]`, and disabling the
              button would move focus to `<body>` at the exact moment the
              member is waiting to hear something.

              What a *failed* retry does was measured rather than assumed,
              because it decides how much this control can promise. `reset()`
              tears this boundary down and remounts it: an attempt counter held
              in component state was seen going 1 → 0 across one press, so
              "that hasn't cleared, escalate" copy is not available here
              without `sessionStorage` keyed on the digest — deliberately not
              built, and recorded as the reason.

              The same remount pays most of that back for free. It re-runs
              `FocusHeading`, so a failed retry re-focuses the h1 and a screen
              reader hears "Something broke, heading level 1" again — an
              announcement that the press landed and got the same answer, which
              is the thing that was missing. The visual half is the busy state
              in flight; it is brief against a local failure and grows with the
              round trip, which is the right way round.

              `Try again` keeps the one gold ration. The audit argued for
              demoting it, on the grounds that it is the control that can fail
              — but it is also the only one that keeps the member where they
              are, and the Notice names it in its own words. */}
          <button
            type="button"
            className="btn btn--primary"
            aria-busy={retrying}
            onClick={() =>
              startRetry(() => {
                reset();
              })
            }
          >
            {retrying ? "Trying…" : "Try again"}
          </button>
          {/* Stays an `<a href>`, not a `<Link>`: a full document load is the
              one escape guaranteed to work from a client tree that has already
              thrown once, and it is the arrival the browser announces itself. */}
          <a className="btn" href={section.back.href}>
            Back to {section.back.label}
          </a>
        </div>
      </main>
    </>
  );
}

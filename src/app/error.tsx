"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import { FocusHeading } from "@/app/_components/focus-heading";
import { utcHhmm } from "@/app/_components/utc-time";
import {
  MEMBERS_ITEM,
  PAYOUTS_ITEM,
  inSection,
  navFromPath,
} from "@/app/_components/nav-items";
import { Notice, RuleHead, SiteHeader, type NavItem } from "@/app/_components/ui";
import { useBrand } from "@/app/_components/brand-context";

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
 *
 * The `items` themselves come from `nav-items.ts`'s `navFromPath`, which
 * derives the same `{canReadPayouts, isAdmin}` reach this comment argues for
 * from the path alone — see that module for why each branch proves what it
 * claims. This function keeps its own `admin` and `back`, neither of which
 * `navFromPath` knows about: `admin` also drives the mark's destination and
 * the `ADMIN` register marker (see `SiteHeader`), and `back` is a single
 * escape link, not a member of the bar. One consequence of routing `items`
 * through the shared rule: the admin branch's list now opens with "Your
 * account" rather than closing with it, because order is fixed everywhere
 * (see `nav-items.ts`) rather than chosen per surface.
 */
function sectionFor(pathname: string): {
  items: NavItem[];
  admin: boolean;
  back: NavItem;
} {
  if (inSection(pathname, "/admin")) {
    return {
      items: navFromPath(pathname),
      admin: true,
      // The same item, not a retyped copy of its label — see `MEMBERS_ITEM`.
      back: MEMBERS_ITEM,
    };
  }
  if (inSection(pathname, "/payouts")) {
    return {
      items: navFromPath(pathname),
      admin: false,
      back: PAYOUTS_ITEM,
    };
  }
  return {
    items: navFromPath(pathname),
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
  // A client component cannot read config; the root layout's provider carries
  // the values down. `useBrand()` falls back to the generic defaults rather
  // than throwing — an error boundary is the last place that should be able
  // to fail for a second reason.
  const brand = useBrand();
  const [retrying, startRetry] = useTransition();

  // Set after mount rather than during render. This boundary renders on the
  // server for a server-side throw, and a clock read in the render body would
  // be a hydration mismatch on every one of those. `null` until the effect
  // runs, and the block below renders the row as `—` in the meantime rather
  // than dropping it — the row is the one an admin needs to bracket a search,
  // and a row that appears late moves the buttons under it. See the comment on
  // the block itself.
  const [seenAt, setSeenAt] = useState<string | null>(null);
  useEffect(() => {
    setSeenAt(`${utcHhmm(new Date())} UTC`);
  }, []);

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
          "Something broke · <brand name>". Do not carry that result across to
          `payouts/[id]/not-found.tsx` — the opposite was measured there, and
          that file's comment records it. A not-found boundary loses to the
          segment's resolved `metadata`; an error boundary, which replaces the
          segment rather than rendering beside its metadata, does not. */}
      <title>{`Something broke · ${brand.name}`}</title>
      <SiteHeader
        items={section.items}
        admin={section.admin}
        brandName={brand.name}
        brandTagline={brand.tagline}
        brandMarkUrl={brand.markUrl}
      />
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

        {/* `live={false}`. This box holds guidance, not the fault — the fault is
            the h1 and the lede above it — and `FocusHeading` already announces
            the arrival by moving focus to that h1. A `role="alert"` rendering in
            the same commit preempts it, so the member hears the instruction and
            not the thing it is an instruction about. Opting out of the region
            keeps the announcement order the page actually wants. The tone stays
            `bad`: it is the visual grade the boundary needs, `p.notice--bad` is
            what `e2e/error-boundary.spec.ts` locates by, and `live` is exactly
            the knob 1A added so those two decisions could be made separately. */}
        <Notice tone="bad" live={false}>
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

        {/* The escalation the sentence above asks for used to dead-end. The
            member is told to quote a digest, and the admin they quote it to has
            one tool — /admin/audit, which filters on actor, action, target and
            before, and has no free-text search at all. A digest alone matches
            none of those columns. What does narrow that log is the route and a
            time, and neither was on screen: the route is in the URL bar the
            member is about to navigate away from, and the mount time was
            nowhere.

            One block, selectable as a unit, so "copy this" is one gesture
            rather than three. The digest repeats deliberately — the sentence
            above has to keep carrying it, because an instruction that names a
            reference and then puts it somewhere else is the failure this page
            already fixed once. Here it is a field in a record; there it is the
            thing the sentence points at.

            `seenAt` is absent on the server render and arrives after mount, so
            the row prints `—` in the meantime rather than being omitted. Both
            options are honest; only one keeps the block the same height. What
            sits directly below this is the button row, and the lede above warns
            that a submitted action may already have taken effect — so **Try
            again** is a control with consequences, and a reader who has read
            that, decided, and moved to press it should not have it slide out
            from under the pointer when the effect fires. `—` is this app's
            existing answer to a value that is not there (`admin/accounts` falls
            back to it directly, `admin/sync` wraps it in `Absent`), so a block
            copied during that first moment reads as a record with one field
            pending rather than as a rendering fault.

            `error.digest` stays conditional for the opposite reason: it is
            absent *permanently* for client-side throws, per the comment above,
            so there is no arrival and no shift — only a line of noise on every
            client error.

            `as="h2"` rather than the `span` default: it is the only section
            heading on the page, under the h1, and a reader navigating by
            heading is exactly the reader who would otherwise land on the button
            row having never been offered the thing this block exists to hand
            over. Every other `RuleHead` in the app passes `as` for the same
            reason. */}
        <RuleHead as="h2">What to send</RuleHead>
        <pre className="escalation mono">
          <code>
            {`page    ${pathname}`}
            {`\nseen    ${seenAt ?? "—"}`}
            {error.digest ? `\nref     ${error.digest}` : ""}
          </code>
        </pre>

        <div className="btn-row">
          {/* Plain grade, not `btn--primary`. The lede directly above warns that
              a submitted action may have taken effect and to check before
              sending it again — and pressing this is that second send. Gold is
              the page's one emphasis ration, and spending it here made the
              reading the lede warns about the most prominent thing on screen.
              Nothing on this page earns gold instead: a boundary has no action
              it can recommend, which is the honest state and is now what the
              page looks like.

              `aria-busy` alone, no `disabled`: the styling for it already
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
              round trip, which is the right way round. */}
          <button
            type="button"
            className="btn"
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

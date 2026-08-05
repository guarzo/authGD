import { FocusHeading } from "@/app/_components/focus-heading";
import { SiteHeader } from "@/app/_components/ui";

/**
 * The 404 for a payout operation that isn't there — `page.tsx`'s
 * `if (!detail) notFound()`.
 *
 * A segment-scoped copy rather than letting the root one catch it, for one
 * reason that is worth more than the duplicated markup: this boundary is
 * reachable *only* through `page.tsx`, and `page.tsx` calls
 * `requirePayoutReader()` before it calls `notFound()`. So everyone who lands
 * here has already cleared the payouts guard — which is what lets this file
 * offer `/payouts` in the nav and as its primary action without reading the
 * session. The root boundary has no such proof and has to send everyone to
 * `/account`.
 *
 * That matters most for the path that makes this page reachable at all: the
 * member was reading the operations list and clicked a row. Sending them back
 * to the list puts them where they were; sending them to `/account` makes them
 * navigate back.
 *
 * `/admin/accounts` is deliberately absent even though the wide pages offer it
 * conditionally — `access.isAdmin` is exactly the thing this file cannot know.
 *
 * No `metadata` export here, and it is not an oversight: it was tried and
 * measured inert. A segment-scoped not-found does not get to set the title —
 * `page.tsx`'s own metadata is resolved and applied even though the page
 * threw, on hard and soft navigation alike. (The root boundary is different
 * and does export one: no page segment matched, so nothing competes with it.
 * `error.tsx` is a third case and different again — a hoisted `<title>` there
 * *does* beat the failed segment's resolved metadata, measured on `/payouts`
 * with its list query broken. Do not generalise from this file to that one.)
 *
 * So the title is set from the other end. `page.tsx` exports
 * `generateMetadata` instead of a static `metadata`, and it returns "No such
 * operation" — this heading — for the same lookup that returns null. The
 * second lookup that seemed to cost is free: both callers go through one
 * `cache()`d loader, and Next resolves metadata and render in the same
 * request.
 */

export default function PayoutOperationNotFound() {
  return (
    <>
      <SiteHeader
        items={[
          { href: "/account", label: "Your account" },
          { href: "/payouts", label: "Payouts" },
        ]}
        current="/payouts"
        section
      />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <FocusHeading>No such operation</FocusHeading>
          <p className="page__lede">
            That link points at an operation authGD doesn&rsquo;t have. It was either
            deleted after the link was made, or the id arrived truncated.
          </p>
        </div>

        <div className="btn-row">
          {/* A plain anchor, not `next/link`, and the lint rule is silenced
              rather than obeyed. Every exit in the app's chrome is a hard
              navigation — `SiteHeader`'s own `/payouts` item, four lines up on
              this very page, and both of `error.tsx`'s. Switching just this one
              control to a soft navigation would make the primary action behave
              differently from the identical link directly above it. A document
              load is also the more robust way to leave a boundary: it is the
              one arrival the browser announces by itself. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- see above; matches SiteHeader and error.tsx, which the rule does not flag. */}
          <a className="btn btn--primary" href="/payouts">
            All operations
          </a>
        </div>
      </main>
    </>
  );
}

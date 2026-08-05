import type { Metadata } from "next";
import { FocusHeading } from "@/app/_components/focus-heading";
import { brandProps } from "@/app/_components/brand-server";
import { SiteHeader } from "@/app/_components/ui";

/**
 * Catch-all 404. Without this file `notFound()` — and any unrouted URL — falls
 * through to Next's built-in `HTTPAccessErrorFallback`, which is not this app
 * in three specific ways: it injects `body{color:#000;background:#fff}` and
 * wins on source order over `background: var(--void)` (both of those colours
 * are banned by name in DESIGN.md, and its dark branch keys off the *OS*
 * preference rather than the `colorScheme: "dark"` this app declares, so a
 * member on a light-mode OS gets a full-bleed white screen from a dark-only
 * app); it sets `font-family: system-ui` inline, losing Archivo and IBM Plex
 * Mono; and it contains zero links, so the first Tab leaves the document and
 * the only exits are Back and the URL bar.
 *
 * Shipping any file here means that fallback is never reached, under Next 15
 * or 16 — which is why this is version-independent, and worth having while
 * `package.json` and the lockfile still disagree about which one we are on.
 *
 * This one cannot read the session, and does not try. Adding `cookies()` would
 * change its render mode, and a not-found boundary renders inside the root
 * layout only, so `AdminNav` could not appear on it regardless. The nav is
 * therefore fixed and minimal: `/payouts` and `/admin/*` are both gated
 * (`requirePayoutReader`, the admin guard), and offering a link that bounces
 * the member straight back out is worse than not offering it. `/account` is
 * the one destination every signed-in member can reach, and a signed-*out*
 * visitor who follows it lands on login, which is where they were going.
 *
 * `/payouts/[id]` has its own copy of this boundary, which can say more,
 * because everyone who reaches *that* one has already cleared the guard.
 */
export const metadata: Metadata = {
  title: "Not found",
};

export default function NotFound() {
  return (
    <>
      <SiteHeader
        items={[{ href: "/account", label: "Your account" }]}
        {...brandProps()}
      />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <FocusHeading>Nothing at that address</FocusHeading>
          <p className="page__lede">
            That address doesn&rsquo;t match anything in authGD. Check it for a typo, or
            for a link that was truncated on its way here.
          </p>
        </div>

        <div className="btn-row">
          <a className="btn btn--primary" href="/account">
            Your account
          </a>
        </div>
      </main>
    </>
  );
}

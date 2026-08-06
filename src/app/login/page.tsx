import type { Metadata } from "next";
import { Notice } from "@/app/_components/ui";
import { getConfig } from "@/config";
import { LOGIN_ERRORS, loginErrorTone, lookupErrorMessage } from "@/lib/error-redirects";

// `await searchParams` below already forces dynamic rendering, so the
// getConfig() call cannot run at build time today. Declared anyway, matching
// every other getConfig() caller under src/app/: the ordering is load-bearing
// and undeclared otherwise, and a later edit that drops searchParams would turn
// this into a Docker build failure, where no config env is present.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in",
};

// Codes reaching this page: oauth_denied / oauth_expired / oauth_failed from
// the EVE callback, session_expired from account/actions.ts, account/page.tsx,
// admin-guard.ts, and either callback when the session is gone mid-link. The
// map itself lives in src/lib/error-redirects.ts, beside the builder every one
// of those producers now goes through — see that file for why.

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const message = lookupErrorMessage(LOGIN_ERRORS, error);
  const tone = loginErrorTone(error);
  const cfg = getConfig();
  const scopes = cfg.eveSso.scopes;
  const label = cfg.standings.label;
  const brand = cfg.brand;
  return (
    <main className="launch">
      <div className="launch__panel">
        {/* Empty alt, like the same mark in `SiteHeader` (ui.tsx:117) and every
            other decorative image in the app: the `<h1>` directly below already
            carries `brand.name`, so `"<name> emblem"` made a screen reader read
            the brand twice before reaching anything actionable — on the one
            page an unauthenticated visitor can get to. The emblem adds nothing
            the heading does not already say, which is what `alt=""` is for. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- what next/image
            would add here is a re-encode at its default quality 75, and
            PRODUCT.md principle 5 asks for this artwork at "full quality" or not
            at all. This is the image that principle is about. Nothing else it
            offers applies: the mark is a fixed 180px at a known intrinsic size,
            so there is no layout shift to prevent and no art direction to do.
            emblem.webp is 512x512 — a ~3x cut for the 180px it is drawn at, which
            is the retina source, not principle 5's "large file scaled down".
            (The one thing next/image WOULD buy is a 1x srcset entry; that is a
            real cost, paid deliberately to keep the encode untouched.) */}
        <img
          className="launch__seal"
          src={brand.sealUrl}
          alt=""
          width={180}
          height={180}
        />
        <h1 className="launch__title">{brand.name}</h1>
        {/* Omitted entirely when unset rather than rendered empty: an empty
            <p> still occupies the stack's row gap, which reads as a missing
            image rather than as "this deployment has no motto". A newline in
            the value is a line break — the only formatting the field takes. */}
        {brand.motto && (
          <p className="launch__motto">
            {brand.motto.split("\n").map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
          </p>
        )}
        {/* Same slot account/page.tsx uses: after the page head, before the
            body content. The seal and motto are this page's head, so a member
            bounced back here reads the reason before the disclosure rather
            than hunting for it underneath. Mounted unconditionally in 1A's slot
            mode rather than behind `message &&`: the `&&` form inserts a live
            region with its text already inside it, which is the case AT
            announces least reliably. Tone is per-code — a cancelled sign-in and
            an expired cookie are not faults, and only faults get the alarm. */}
        <Notice tone={tone}>{message}</Notice>
        <div className="launch__disclosure">
          <p className="launch__disclosure-note">
            Sign in with any EVE character. authGD sets your Discord role; while your main
            is in the alliance it also syncs your Wanderer map access and manages the
            contacts under the <code>{label}</code> label on your characters, adding,
            updating and removing them at a set standing. Leaving the alliance drops your
            tier, never your account, characters, or Discord link.
          </p>
          {/* Guarded rather than always rendered: a whitespace-only
              EVE_SSO_SCOPES passes the zod .min(1) check and filters down to an
              empty array, and a bare "Scopes requested" heading with nothing
              under it reads as "authGD requests no scopes" instead of "this
              deployment is misconfigured". */}
          {scopes.length > 0 && (
            <dl className="launch__scopes">
              <dt>Scopes requested</dt>
              {/* One dd per scope. A <dl> permits several dd under one dt, and
                  joining these into a single space-delimited string put four
                  identifiers in a ~30ch box with `overflow-wrap: anywhere` —
                  at the consent moment, with nothing to distinguish a scope
                  boundary from a line break. */}
              {scopes.map((scope) => (
                <dd key={scope}>{scope}</dd>
              ))}
            </dl>
          )}
        </div>
        <a className="launch__action" href="/auth/eve/login">
          {/* Self-hosted, and the white cut. Hot-linked from
              web.ccpgamescdn.com this was a third-party request on the one
              unauthenticated page in the app: every visitor's IP and UA reached
              CCP's CDN before any sign-in was attempted, and with no
              preconnect, no fetchPriority and no fallback ground the degraded
              state was bare alt text on navy — for the product's only entry
              control. Served from /public it is same-origin, cached with the
              app, and cannot fail independently of the page. The black-large
              cut also made the primary action the darkest object on a dark
              page; CCP publishes this one. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- a vendor
              brand mark, published by CCP at exactly the 270x45 it is drawn at
              and already down to 2,248 bytes. Nothing for the optimizer to
              reclaim, and re-encoding somebody else's brand asset is not ours
              to do. */}
          <img
            src="/brand/eve-sso-login-white-large.png"
            alt="Log in with EVE Online"
            width={270}
            height={45}
            fetchPriority="high"
          />
        </a>
        {brand.footer && <p className="launch__foot">{brand.footer}</p>}
      </div>
    </main>
  );
}

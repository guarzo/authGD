import type { Metadata } from "next";
import { Notice } from "@/app/_components/ui";
import { getConfig } from "@/config";
import { LOGIN_ERRORS, lookupErrorMessage } from "@/lib/error-redirects";

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
  const cfg = getConfig();
  const scopes = cfg.eveSso.scopes;
  const label = cfg.standings.label;
  return (
    <main className="launch">
      <div className="launch__panel">
        <img
          className="launch__seal"
          src="/brand/seal.webp"
          alt="Zoo Landers mission seal"
          width={180}
          height={180}
        />
        <h1 className="launch__title">Zoo Landers</h1>
        <p className="launch__motto">
          Center for kids
          <br />
          who can&rsquo;t fly good
        </p>
        {/* Same slot account/page.tsx uses: after the page head, before the
            body content. The seal and motto are this page's head, so a member
            bounced back here reads the reason before the disclosure rather
            than hunting for it underneath. */}
        {message && <Notice tone="bad">{message}</Notice>}
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
              <dd>{scopes.join(" ")}</dd>
            </dl>
          )}
        </div>
        <a className="launch__action" href="/auth/eve/login">
          <img
            src="https://web.ccpgamescdn.com/eveonlineassets/developers/eve-sso-login-black-large.png"
            alt="Log in with EVE Online"
            width={270}
            height={45}
          />
        </a>
        <p className="launch__foot">Est. MMXXV · [FLYGD]</p>
      </div>
    </main>
  );
}

"use client";

import { Notice, SiteHeader } from "@/app/_components/ui";

/**
 * Route-level error boundary (Next 15 App Router: client component, `{error,
 * reset}`). This is the landing spot for every server action's genuine bugs —
 * the ones actions deliberately still throw rather than redirect for, per the
 * decision in admin/accounts/actions.ts and account/actions.ts. Without this
 * file, that throw fell through to Next's unstyled digest page, on surfaces
 * as routine as clicking SYNC NOW (a DB hiccup while enqueueing the job is
 * enough to hit it; the web tier never calls ESI directly, so an ESI outage
 * itself shows up in the worker, not here).
 *
 * `error.digest` is the only thing shown from the thrown value: it is a
 * correlation id, not the message, so it is safe to print. The message itself
 * (`error.message`) is never rendered — it can carry a raw DB or ESI string
 * that means nothing to a member and shouldn't be handed to one.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <SiteHeader
        items={[{ href: "/account", label: "Your account" }]}
        measure="narrow"
      />
      <main id="main" tabIndex={-1} className="page page--narrow">
        <div className="page__head">
          <h1>Something broke</h1>
          <p className="page__lede">
            The request didn&rsquo;t go through. That&rsquo;s a fault on this end, not
            something you did.
          </p>
        </div>

        <Notice tone="bad">
          Try again in a moment. If it keeps happening, tell an admin what you were doing.
        </Notice>

        {error.digest && <p className="dim mono">Reference {error.digest}</p>}

        <div className="btn-row">
          <button type="button" className="btn btn--primary" onClick={() => reset()}>
            Try again
          </button>
          <a className="btn" href="/account">
            Back to your account
          </a>
        </div>
      </main>
    </>
  );
}

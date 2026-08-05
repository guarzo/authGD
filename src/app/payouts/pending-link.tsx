"use client";

import type { ReactNode } from "react";
import Link, { useLinkStatus } from "next/link";

/**
 * A `next/link` that says it was pressed.
 *
 * The three soft navigations in the app are all on `/payouts` — the New
 * operation control, every operation name in the list, and the empty state's
 * way back. A press produced nothing visible: `globals.css` declares no
 * `:active` rule anywhere, and a soft navigation paints nothing until the
 * server component resolves. The documented human response to a control that
 * appears not to have fired is to fire it again.
 *
 * A `loading.tsx` is the usual answer and it is the wrong one here, at the root
 * and at this segment alike: `SiteHeader` is rendered by each page rather than
 * by a layout, and there is no `payouts/layout.tsx` to hold it, so a suspense
 * fallback anywhere under `/payouts` replaces the chrome along with the
 * content. Blanking the header to report a press is worse than the silence it
 * replaces. The status belongs on the control that was pressed, which is what
 * `useLinkStatus` reads — it is scoped to its enclosing `<Link>` and is only
 * true while that link's navigation is in flight.
 *
 * The indicator is a sibling element rather than an attribute on the anchor
 * because `useLinkStatus` only works from inside the `<Link>` subtree. It is
 * `aria-hidden`: the arrival is announced by the destination, and a live region
 * on every row link would be noise. `.link-pending`'s own rule is a static
 * mark under `prefers-reduced-motion`, so it never becomes a moving thing the
 * global collapse leaves running.
 */
function PendingMark() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <span className="link-pending" aria-hidden="true" />;
}

export function PendingLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={className}>
      {children}
      <PendingMark />
    </Link>
  );
}

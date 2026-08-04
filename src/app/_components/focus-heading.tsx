"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A page `h1` that takes focus once, when it mounts.
 *
 * This exists for the two `not-found.tsx` boundaries and `error.tsx`, and the
 * reason is that all three are usually reached without a document load. For a
 * 404 that is `/payouts`, the app's only `next/link` call site
 * (payouts/page.tsx): a member holding an open list who clicks an operation
 * that has since been deleted gets a *soft* navigation into `notFound()`.
 * React swaps the subtree, the link they pressed unmounts, and focus falls
 * back to `<body>`. Their next Tab restarts at the top of the document, on a
 * page they were never told they had arrived at.
 *
 * `error.tsx` is the same shape with a different trigger — a server action
 * throwing replaces the page in place, and the button that was pressed is the
 * thing that unmounts. It also gets a second use out of this that the 404s do
 * not: `reset()` remounts the boundary rather than reusing it (measured), so a
 * retry that fails again re-runs this effect and re-announces the heading.
 * That is the only signal a screen-reader user gets that the press landed and
 * produced the same answer.
 *
 * Nothing in the framework moves focus for us. The App Router does call
 * `focus()` on arrival, but it targets the first element of the changed
 * segment — which is the `<header>` — and a `<header>` is not focusable, so
 * the call is a no-op and focus stays wherever it fell.
 *
 * Next's `AppRouterAnnouncer` is a separate mechanism and is *not* what this
 * relies on. It portals `document.title` into an `aria-live="assertive"`
 * region, falling back to the first `h1` when the title is empty — and on a
 * soft navigation into a boundary it was measured taking the `h1` fallback,
 * because React is mid-swap on the hoisted `<title>` when the effect runs.
 * That is a race that happens to land well, not a contract; it is deliberately
 * not asserted in `e2e/not-found.spec.ts`. Focus is the half that is ours and
 * is deterministic, so it is the half the boundaries are built on.
 *
 * Focusing the heading rather than `<main>` is deliberate — it is what gets
 * the new page's name read out, since a focused `h1` announces its own text.
 * `tabIndex={-1}` makes it focusable without adding a tab stop.
 *
 * The cost, stated plainly: on a *hard* navigation (a pasted URL) the document
 * load already announces the page, and this moves focus past the skip link a
 * beat later. That is the lesser problem. Focus landing inside `<main>` is
 * where the skip link would have put it anyway, and the header stays one
 * Shift+Tab away — whereas focus stranded on `<body>` after a soft navigation
 * has no equivalent recovery.
 */
export function FocusHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // No focus ring appears: the global ring is `:focus-visible` (globals.css),
  // which a programmatic focus on a non-input element does not match.
  return (
    <h1 ref={ref} tabIndex={-1}>
      {children}
    </h1>
  );
}

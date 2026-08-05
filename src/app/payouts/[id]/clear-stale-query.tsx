"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Drops `?error=`/`?dropped=` at the moment the NEXT submit starts, so a notice
 * from an earlier failure cannot outlive the thing it described.
 *
 * The two halves of this are in tension and the timing is the whole design:
 *
 *  - A failure reaches this page as a redirect (`actions.ts:94`) to
 *    `?error=<code>`, and the notice is rendered from that param. So the param
 *    must SURVIVE the arrival that created it. Clearing on mount destroys every
 *    error notice on the page instantly, because for an error the mount IS the
 *    failure — three e2e specs catch exactly that.
 *  - A success does not redirect. Every editor here (`setNameAction`,
 *    `setCorpShareAction`, ...) calls `revalidatePath` and returns, so nothing
 *    rewrites the URL and no remount happens. Left alone, `?error=shares_positive`
 *    from a failed edit of one row sits in the address bar forever, and the next
 *    successful edit of a DIFFERENT row re-renders that stale alarm as though it
 *    described the save that just worked.
 *
 * Submitting is the one instant that separates them: it is after the reader has
 * had the failed notice in front of them, and before the next result exists. So
 * the param is cleared there. If that submit fails, its own redirect puts a
 * fresh param back; if it succeeds, the URL is already clean and the notice is
 * correctly gone.
 *
 * `router.replace` rather than a server-side `redirect()` on the success paths:
 * every `Disclosure` on this page (`../../_components/disclosure.tsx`) holds its
 * open/closed state in `useState`, and a route transition remounts it, silently
 * closing whatever loot-pool or roster panel the operator had open elsewhere. A
 * same-route, query-only `replace` patches the current segment's params without
 * counting as a navigation, so that state survives. `{ scroll: false }` for the
 * same reason: clearing a query string should not jump the page to the top.
 *
 * Capture phase, on the document: the forms are spread across server-rendered
 * markup and several client leaves, and a listener per form would have to be
 * threaded through all of them. Capture also runs before React's own submit
 * handling, so the URL is clean before the action is dispatched.
 *
 * Forms whose action performs its own `redirect()` opt out with
 * `data-navigates`. Those are the appraisal form (which redirects to
 * `?dropped=` on a partial parse) and the delete form (which leaves for
 * `/payouts` entirely, or comes back with `?error=delete_has_paid`). For them
 * the replace is not merely redundant but actively unsafe: two client
 * transitions to different destinations would be in flight at once, and this
 * one targets the page the delete is trying to leave. Every other form here
 * settles with `revalidatePath` and no navigation, so the replace is the only
 * thing touching the URL.
 */
export function ClearStaleQuery() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const stale = searchParams.has("error") || searchParams.has("dropped");

  useEffect(() => {
    if (!stale) return;
    const onSubmit = (ev: Event) => {
      const form = ev.target;
      if (form instanceof HTMLElement && form.hasAttribute("data-navigates")) return;
      router.replace(pathname, { scroll: false });
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, [stale, pathname, router]);

  return null;
}

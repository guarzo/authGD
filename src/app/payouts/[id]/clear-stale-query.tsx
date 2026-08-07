"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Drops `?error=`/`?dropped=`/`?unresolved=` at the moment the NEXT submit
 * starts, so a notice from an earlier failure cannot outlive the thing it
 * described.
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
 * Forms whose action performs its own server-side `redirect()` opt out with
 * `data-navigates` — today that is only the delete form, which leaves for
 * `/payouts` entirely, or comes back with `?error=delete_has_paid`. For it the
 * replace is not merely redundant but actively unsafe: two client transitions
 * to different destinations would be in flight at once, and this one targets
 * the page the delete is trying to leave.
 *
 * The appraisal form used to be a second opt-out here, redirecting to
 * `?dropped=<payload>` itself on a partial parse — removed once that redirect
 * turned out to be the exact bug this docblock's first bullet warns about: a
 * route transition back to the SAME page still remounts every `Disclosure`,
 * so a paste that dropped a line was silently closing whatever pool or
 * roster panel the operator had open elsewhere. `AppraiseForm` now carries
 * the dropped payload home through `useActionState` and does its own
 * `router.replace` once the action resolves (see that component's docblock),
 * the same query-only mechanism this file uses rather than a second one.
 * Nothing here opts it out anymore: its submit clears a stale `?dropped=`/
 * `?error=` exactly like every other form's does, and its own replace fires
 * strictly later — only after the action's promise has resolved, which is
 * necessarily after this listener's synchronous, capture-phase clear — so the
 * two `replace` calls are sequenced, never concurrent. Every other form here
 * settles with `revalidatePath` and no navigation, so the replace is the only
 * thing touching the URL.
 *
 * `?unresolved=` (an unresolved roster name from `createOperationAction`,
 * decoded by `../unresolved`) joined the `stale` check for the identical
 * reason `?dropped=` is in it: it arrives once, on the redirect that created
 * this page, and nothing else on this page ever rewrites it, so left out of
 * this check it would sit in the address bar and be silently re-rendered
 * against whatever edit came next.
 */
export function ClearStaleQuery() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const stale =
    searchParams.has("error") ||
    searchParams.has("dropped") ||
    searchParams.has("unresolved");

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

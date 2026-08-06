"use client";

import { useActionState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Notice, RuleHead } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { addAppraisedPoolAction, type AppraiseActionState } from "../actions";
import { OPERATION_ERRORS, lookupErrorMessage } from "../errors";

/**
 * Its own client component and its own `useActionState`, unlike every other
 * form on this page, because an appraisal failure is the one rejection here
 * that a `?error=` redirect cannot explain without losing what caused it: the
 * query string is the wrong channel for a paste that can run hundreds of
 * lines (see `errors.ts`'s docblock and `addAppraisedPoolAction`'s own).
 *
 * `useActionState` returns state instead of navigating on that failure, so
 * this component never unmounts — the loot paste the operator typed is still
 * exactly what it was, because nothing ever replaced the DOM it is sitting in.
 *
 * A SUCCESS that dropped lines used to navigate too — `addAppraisedPoolAction`
 * redirected straight to `?dropped=<payload>`, because the dropped-lines
 * notice itself renders at page level (`[id]/page.tsx`), not in this form. That
 * was its own defect: a `redirect()` back to the very page already on screen
 * is still a route transition, and every `Disclosure` on this page remounts on
 * one, silently closing whatever pool or roster panel the operator had open
 * elsewhere — see `AppraiseActionState`'s own comment and
 * `clear-stale-query.tsx`'s docblock for the full argument. The payload now
 * travels home as state instead, same as the failure path, and this effect is
 * what pushes it into the URL — a same-route `router.replace`, not a
 * `redirect()`, so the page re-renders with the new `?dropped=` param without
 * the transition that collapses everything else. Nothing to do when
 * `state.dropped` is null: a clean success needs no query change, and any
 * *stale* `?dropped=`/`?error=` from an earlier submit was already cleared by
 * `ClearStaleQuery`'s document-level listener the instant this form's own
 * submit began — strictly before this effect can run, since it depends on the
 * action's promise having resolved. That ordering is also why this form no
 * longer needs `data-navigates`: it now settles exactly like every other form
 * here (a same-route `replace`, never a hard navigation), so the two
 * mechanisms cannot collide.
 *
 * This used to also collect a pricing mode (four options), a price-at kind
 * (station or region), and a station/region id (free numeric, defaulted to
 * Jita 4-4). This deployment has one pricing policy and always will — Jita
 * sell-best — so those were three controls that only ever took their own
 * default. `addAppraisedPoolAction` now hardcodes both (see its own comment
 * for the constants and why they satisfy the same DB constraint the removed
 * controls did). The `pricing_mode`, `location_kind`, `station_invalid` and
 * `region_invalid` error codes stay in `errors.ts` as backstops even though
 * nothing in this form can produce them anymore — see that file's docblock.
 */
export function AppraiseForm({ operationId }: { operationId: string }) {
  const [state, formAction] = useActionState<AppraiseActionState, FormData>(
    addAppraisedPoolAction.bind(null, operationId),
    null,
  );
  const router = useRouter();
  const pathname = usePathname();

  // See the docblock above: pushes a dropped-lines payload into the URL with
  // a query-only `replace` rather than letting the action redirect there
  // itself, so the `Disclosure`s elsewhere on this page survive a paste that
  // drops a line. `state` is a fresh object every time the action resolves
  // (even a paste that drops the exact same line twice), so this effect fires
  // once per submission and never on a stale `state` left over from before.
  useEffect(() => {
    if (state?.ok && state.dropped) {
      router.replace(`${pathname}?dropped=${state.dropped}`, { scroll: false });
    }
  }, [state, pathname, router]);

  return (
    <form action={formAction} className="form-stack">
      <RuleHead as="h3">Appraise a loot paste</RuleHead>
      {/* Only rendered once a submit has actually failed — `state === null`
          covers both "hasn't submitted yet" and "still pending", and neither
          of those is a rejection worth announcing. */}
      {state && !state.ok && (
        <Notice tone="bad">{lookupErrorMessage(OPERATION_ERRORS, state.code)}</Notice>
      )}
      <label className="form-stack__field">
        Loot paste
        <textarea className="field" name="rawPaste" rows={10} required />
      </label>
      <Submit className="btn btn--primary" pendingLabel="Pricing…">
        Appraise
      </Submit>
    </form>
  );
}

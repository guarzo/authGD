"use client";

import { useActionState, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Notice, RuleHead } from "@/app/_components/ui";
import { Disclosure } from "@/app/_components/disclosure";
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
 * this component never unmounts. Staying mounted is necessary but NOT
 * sufficient: React 19 resets an uncontrolled field after a `<form action>`
 * submit settles, so an uncontrolled textarea here lost the paste on rejection
 * even though the DOM around it never moved. This claim used to be written as
 * if not-unmounting were the whole story; it wasn't. The value is controlled
 * below, which is what actually makes the paste survive a rejection — the
 * state is re-applied on the very render that shows the failure notice. The
 * composer at `new/new-operation-form.tsx` carries the same fix for the same
 * reason, proven by an e2e round trip.
 *
 * That composer test is this component's coverage too, by proxy, and
 * deliberately so. There is no way to reject THIS form without the network:
 * `appraiseLoot` only fails via `TriffError`/`EsiError`, the clients are built
 * inside `addAppraisedPoolAction` rather than injected, and `TRIFF_QUOTE_URL`
 * is a constant — so a direct test would mean making an external client
 * injectable purely for test reach. What can actually regress here is React's
 * post-submit reset behaviour, and `e2e/payouts.spec.ts`'s "a rejected
 * composer submit keeps the loot paste" asserts exactly that against the
 * identical mechanism. If React changes, that test goes red and this file is
 * wrong in the same way. Keep the two in step: a controlled value here is not
 * a style choice, and reverting it to `defaultValue` will not fail any test.
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
export function AppraiseForm({
  operationId,
  primary = true,
  collapsed = false,
  children,
}: {
  operationId: string;
  /** Defaults to true — the common case is an empty operation, where this
   *  paste is the only thing worth doing. Once loot already exists, the
   *  ledger's single gold control moves on ("Set roster", then "Finalize" —
   *  see `[id]/page.tsx`'s one-primary-per-state comment), and this form
   *  renders again from "Add another paste" at the plain grade instead, so
   *  the page never shows two gold buttons at once. */
  primary?: boolean;
  /** Wraps this form (and `children`) in the "Add another paste" disclosure
   *  instead of rendering it bare. A prop rather than a second call site in
   *  `page.tsx`, because two call sites under opposite conditions unmount this
   *  component on the commit where the first paste lands — taking the
   *  dropped-lines effect below with it. See that page's comment on the slot. */
  collapsed?: boolean;
  /** The flat-value escape hatch, which belongs beside this form in both
   *  states. Passed in rather than imported so the collapsed wrapper can hold
   *  both without `page.tsx` needing a second copy of either. */
  children?: React.ReactNode;
}) {
  const [state, formAction] = useActionState<AppraiseActionState, FormData>(
    addAppraisedPoolAction.bind(null, operationId),
    null,
  );
  const router = useRouter();
  const pathname = usePathname();
  const [paste, setPaste] = useState("");

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

  // Controlled means React's post-submit reset no longer empties the field, so
  // the success case has to do it explicitly: the paste has been priced and
  // banked into a pool by this point, and leaving it sitting in the box reads
  // as "that didn't take". Keyed off `state` rather than `state.ok` because a
  // fresh object arrives per submit, so a second successful paste clears too.
  //
  // Kept separate from the `dropped` effect above rather than folded into it:
  // that one fires only for the drop case and this one for every success, and
  // merging them would tie a URL write to a field reset that has no need of
  // one. They share a dependency, not a purpose.
  useEffect(() => {
    if (state?.ok) setPaste("");
  }, [state]);

  const form = (
    <form action={formAction} className="form-stack">
      <RuleHead as="h3">Appraise a loot paste</RuleHead>
      {/* Mounted unconditionally, with the condition moved into the children:
          the text still appears only once a submit has actually failed —
          `state === null` covers both "hasn't submitted yet" and "still
          pending", and neither of those is a rejection worth announcing — but
          the live region now exists before the message does. `useActionState`
          keeps this component mounted across the rejection, so the `&&` form
          inserted a fresh `role="alert"` node with its text already inside it
          into an otherwise stable tree: exactly the shape `Notice`'s docblock
          (ui.tsx:255-270) calls out as the one that defeats the region it just
          asked for. Empty children render the reserved `.notice-slot`, which is
          out of flow and draws nothing, so the form's spacing is unchanged. */}
      <Notice tone="bad">
        {state && !state.ok ? lookupErrorMessage(OPERATION_ERRORS, state.code) : null}
      </Notice>
      <label className="form-stack__field">
        {/* Same hint as the composer's Loot field
            (`../new/new-operation-form.tsx`), which takes the same paste
            through the same parser: an operator who learns the format on one
            form should not have to rediscover it on the other. Not marked
            optional here — this field is `required`. Same substring-collision
            constraint on the wording as the composer's copy of this label. */}
        Loot paste (one line per item, quantity before or after)
        <textarea
          className="field"
          name="rawPaste"
          rows={10}
          required
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
        />
      </label>
      <Submit className={primary ? "btn btn--primary" : "btn"} pendingLabel="Pricing…">
        Appraise
      </Submit>
    </form>
  );

  if (!collapsed) {
    return (
      <>
        {form}
        {children}
      </>
    );
  }

  return (
    <Disclosure
      as="details"
      className="disc"
      summary="Add another paste"
      ariaLabel="Add another paste: appraise more loot, or enter a flat value"
    >
      <div className="form-stack">
        {form}
        {children}
      </div>
    </Disclosure>
  );
}

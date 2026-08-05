"use client";

import { useActionState } from "react";
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

  return (
    <form action={formAction} className="form-stack" data-navigates>
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

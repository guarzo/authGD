"use client";

import { useActionState } from "react";
import { Notice, RuleHead } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { PRICING_MODES, type PricingMode } from "@/core/pricing";
import { addAppraisedPoolAction, type AppraiseActionState } from "../actions";
import { OPERATION_ERRORS, lookupErrorMessage } from "../errors";

// Duplicated from `[id]/page.tsx` rather than imported from it: the labels
// are display-only, four lines, and importing across a route boundary from a
// page module into the component it renders is a stranger coupling than
// repeating a short map that changes exactly when `PricingMode` does.
const PRICING_LABELS: Record<PricingMode, string> = {
  sell_best: "Sell (best)",
  sell_p05: "Sell (5th percentile)",
  buy_best: "Buy (best)",
  buy_p05: "Buy (5th percentile)",
};

/**
 * Its own client component and its own `useActionState`, unlike every other
 * form on this page, because an appraisal failure is the one rejection here
 * that a `?error=` redirect cannot explain without losing what caused it: the
 * query string is the wrong channel for a paste that can run hundreds of
 * lines (see `errors.ts`'s docblock and `addAppraisedPoolAction`'s own).
 *
 * `useActionState` returns state instead of navigating on that failure, so
 * this component never unmounts — the loot paste, the pricing mode, and the
 * location fields are all still exactly what the operator typed, because
 * nothing ever replaced the DOM they are sitting in. A `?error=` redirect
 * still happens for the other three rejections here (`pricing_mode`,
 * `location_kind`, `station_invalid`/`region_invalid`) — those are backstops
 * behind a `<select>` and a pattern-guarded input, unreachable by filling the
 * form in, so there is no paste to protect on those paths.
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
      <label className="form-stack__field">
        Pricing
        <select className="field" name="pricingMode" defaultValue="sell_best">
          {PRICING_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {PRICING_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>
      {/* Kind + id, rather than a station box and a region box the operator
          must leave one of blank. triff accepts exactly one, and this is the
          only form on the page whose failure would cost the operator a long
          paste, so the rule is expressed as a shape that cannot be filled in
          wrongly rather than as prose above two inputs that can. */}
      <label className="form-stack__field">
        Price at
        <select className="field" name="locationKind" defaultValue="station">
          <option value="station">Station</option>
          <option value="region">Region</option>
        </select>
      </label>
      <div className="form-stack__field">
        <label htmlFor="appraise-location-id">Station or region ID</label>
        <input
          id="appraise-location-id"
          className="field"
          name="locationId"
          inputMode="numeric"
          pattern="[0-9]+"
          defaultValue="60003760"
          required
          aria-describedby="appraise-location-hint"
        />
        <span className="dim" id="appraise-location-hint">
          Digits only. Jita 4-4 is station 60003760; The Forge is region 10000002.
        </span>
      </div>
      <Submit className="btn" pendingLabel="Pricing…">
        Appraise
      </Submit>
    </form>
  );
}

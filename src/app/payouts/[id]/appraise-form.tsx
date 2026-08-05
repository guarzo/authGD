"use client";

import { useActionState, useEffect, useState } from "react";
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
}: {
  operationId: string;
  /** Defaults to true — the common case is an empty operation, where this
   *  paste is the only thing worth doing. Once loot already exists, the
   *  ledger's single gold control moves on ("Set roster", then "Finalize" —
   *  see `[id]/page.tsx`'s one-primary-per-state comment), and this form
   *  renders again from "Add another paste" at the plain grade instead, so
   *  the page never shows two gold buttons at once. */
  primary?: boolean;
}) {
  const [state, formAction] = useActionState<AppraiseActionState, FormData>(
    addAppraisedPoolAction.bind(null, operationId),
    null,
  );
  const [paste, setPaste] = useState("");

  // Controlled means React's post-submit reset no longer empties the field, so
  // the success case has to do it explicitly: the paste has been priced and
  // banked into a pool by this point, and leaving it sitting in the box reads
  // as "that didn't take". Keyed off `state` rather than `state.ok` because a
  // fresh object arrives per submit, so a second successful paste clears too.
  useEffect(() => {
    if (state?.ok) setPaste("");
  }, [state]);

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
}

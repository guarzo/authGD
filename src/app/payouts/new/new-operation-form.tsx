"use client";

import { useActionState, useEffect, useState } from "react";
import { Notice, RuleHead } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { createOperationAction, type CreateOperationState } from "../actions";
import { NEW_OPERATION_ERRORS, lookupErrorMessage } from "../errors";

/** The `Notice` this form moves focus to on a rejection — see the effect
 *  below. */
const ERROR_NOTICE_ID = "new-operation-error";

/**
 * One screen, one submit: name, date, an optional battle report link, an
 * optional loot paste and an optional roster paste, all landing on a
 * fully-populated operation in a single round trip (`createOperationAction` →
 * `createOperationWithContents`).
 *
 * A client component built on `useActionState`, following `AppraiseForm`'s
 * own precedent (`../[id]/appraise-form.tsx`) for the same reason that form
 * exists: a rejected submit must not lose a paste that can run hundreds of
 * lines. `createOperationAction` RETURNS `{ ok: false, code }` on every
 * rejection rather than redirecting through a `?error=` query string — a
 * redirect can only carry a fixed code, and losing the redirect is what keeps
 * this component mounted with both textareas exactly as the operator left
 * them. A success always redirects, whether or not the roster paste left a
 * name unresolved — see `CreateOperationState`'s own doc for where that
 * report goes instead (`/payouts/[id]`'s own `?unresolved=` notice, the
 * roster twin of that page's `?dropped=` one).
 *
 * Every field is controlled (`useState`, not `defaultValue`) rather than
 * left to the DOM: React DOM's `<form action>` integration resets a form's
 * *uncontrolled* fields the instant the action promise settles, success or
 * rejection alike — there is no return value that opts a submission out of
 * it. An uncontrolled `defaultValue` textarea would lose a hundred-line paste
 * on the very rejection this component exists to survive, which is exactly
 * backwards. A controlled value survives that reset because React re-applies
 * it on the next render, the same one that shows the rejection notice. The
 * battle report field follows the same rule though it never holds more than a
 * URL, for consistency: nothing on this form is left uncontrolled to save a
 * `useState` call.
 *
 * `data-navigates` on the form opts it out of `ClearStaleQuery`
 * (`../[id]/clear-stale-query.tsx`); that component doesn't run on this page
 * at all, since it lives beside `/payouts/[id]`, but the attribute costs
 * nothing and keeps this form consistent with every other one that redirects
 * on success.
 *
 * The rejection `Notice`, mounted unconditionally rather than behind `&&`,
 * for the reason the primitive's own doc gives — a region has to exist
 * before the text that fills it, or AT meets a node born already holding a
 * message rather than a change to announce. It carries an `id` and is
 * focused when it gains content: a rejection is answered by staying on this
 * page rather than navigating, and without an explicit focus move the
 * operator is left standing at the Submit button roughly 1000px below where
 * the notice renders (item 10, this pass's design sweep). `state` is the
 * effect's dependency rather than a derived boolean because `useActionState`
 * hands back a brand-new object on every submit regardless of whether the
 * code repeats — the same distinction `InlineEdit` (`../[id]/inline-edit.tsx`)
 * draws for its own per-field rejection.
 */
export function NewOperationForm({ today }: { today: string }) {
  const [state, formAction] = useActionState<CreateOperationState, FormData>(
    createOperationAction,
    null,
  );
  const [name, setName] = useState("");
  const [occurredAt, setOccurredAt] = useState(today);
  const [battleReportUrl, setBattleReportUrl] = useState("");
  const [lootPaste, setLootPaste] = useState("");
  const [rosterPaste, setRosterPaste] = useState("");

  useEffect(() => {
    if (state && !state.ok) document.getElementById(ERROR_NOTICE_ID)?.focus();
  }, [state]);

  return (
    <form action={formAction} className="form-stack" data-navigates>
      {/* Mounted unconditionally, not behind `&&`: the reserved slot registers
          the live region before the text arrives, so AT announces a change to
          it rather than a region born holding its own message. */}
      <Notice tone="bad" id={ERROR_NOTICE_ID}>
        {state && !state.ok ? lookupErrorMessage(NEW_OPERATION_ERRORS, state.code) : null}
      </Notice>

      <RuleHead as="h2">Operation</RuleHead>
      {/* Requiredness is spelled into the label rather than left to the
          `required` attribute alone. */}
      <label className="form-stack__field">
        Name (required)
        <input
          className="field"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label className="form-stack__field">
        Date (required)
        {/* Same reasoning `/payouts/[id]` uses for its own date field: the
            operation cannot be dated into the future, and the action parses
            `yyyy-mm-dd` as UTC midnight — EVE time — so today's date is the
            right default rather than a local-timezone guess. */}
        <input
          className="field mono"
          type="date"
          name="occurredAt"
          value={occurredAt}
          onChange={(e) => setOccurredAt(e.target.value)}
          max={today}
          required
        />
      </label>
      <label className="form-stack__field">
        Battle report (optional)
        <input
          className="field"
          type="url"
          name="battleReportUrl"
          value={battleReportUrl}
          onChange={(e) => setBattleReportUrl(e.target.value)}
        />
      </label>

      <RuleHead as="h2">Loot</RuleHead>
      <label className="form-stack__field">
        {/* The format goes in the label, like the Roster field ten lines
            below: two sibling pastes on one form, and only one of them used
            to answer "what do I put here". `parseLootPaste` takes a quantity
            on either side of the name and reads column two of a tab-separated
            line, so an EVE inventory paste needs no instruction — but a
            hand-typed list does, and a bare quantity on its own line is
            dropped rather than guessed at (core/loot-paste.ts:145).

            Phrased "one line per item" and NOT "…before or after the name":
            `getByLabel` matches on a substring, so a label containing the
            word "name" is also a match for `getByLabel("Name")` — the Name
            field is ten lines above, and the two resolving together is a
            strict-mode violation that took out 22 payouts specs. Any wording
            added here has to stay clear of every other label on the form. */}
        Loot paste (optional: one line per item, quantity before or after)
        <textarea
          className="field"
          name="lootPaste"
          rows={10}
          value={lootPaste}
          onChange={(e) => setLootPaste(e.target.value)}
        />
      </label>

      <RuleHead as="h2">Roster</RuleHead>
      <label className="form-stack__field">
        Roster paste (optional: one per line, or separated by /)
        <textarea
          className="field"
          name="rosterPaste"
          rows={8}
          value={rosterPaste}
          onChange={(e) => setRosterPaste(e.target.value)}
        />
      </label>

      <Submit className="btn btn--primary" pendingLabel="Creating…">
        Create operation
      </Submit>
    </form>
  );
}

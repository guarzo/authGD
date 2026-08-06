"use client";

import { useActionState, useState } from "react";
import { Notice, RuleHead } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { createOperationAction, type CreateOperationState } from "../actions";
import { NEW_OPERATION_ERRORS, lookupErrorMessage } from "../errors";

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
 * them.
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

  return (
    <form action={formAction} className="form-stack" data-navigates>
      {/* Mounted unconditionally, not behind `&&`: the reserved slot registers
          the live region before the text arrives, so AT announces a change to
          it rather than a region born holding its own message. */}
      <Notice tone="bad">
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
        Loot paste (optional)
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

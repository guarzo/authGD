"use client";

import { useActionState } from "react";
import { Notice } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { addFlatPoolAction, type FlatPoolEditState } from "../actions";
import { OPERATION_ERRORS, lookupErrorMessage } from "../errors";

/**
 * `AppraiseForm`'s sibling for the "enter a flat value" escape hatch — three
 * fields (total, note, and the optional raw paste) that all have to survive
 * a rejection together, not just the one that failed. A `?error=` redirect
 * used to drop all three the moment `total_invalid` or `note_required` fired,
 * so retyping the note (which was fine) was the cost of a mistyped number
 * (which wasn't). `useActionState` returns the three submitted strings
 * alongside the rejection code instead of navigating, the same trick this
 * page's other single-field editors use via `InlineEditField` — this is the
 * multi-field version, because a flat pool has no one value to echo back.
 *
 * Only the rejected values are ever read back (`state.totalValue`, etc.); the
 * success branch passes `""`, so nothing this component computes can ever
 * echo back a value that merely resembles what was just saved.
 *
 * That `""` does NOT clear the fields, and the wording here used to claim it
 * did. `defaultValue` compiles to the `value` *attribute*, and a browser
 * ignores an attribute change on an input whose dirty value flag is set —
 * which it is, the operator having typed in it. So after a successful add the
 * total and note are still on screen. This is not a regression (the previous
 * server-rendered form reconciled the same nodes and kept the same text), but
 * it is a real hazard worth naming: an operator can press "Add flat pool"
 * twice and get two pools. Clearing needs a `ref` reset or a remount `key`
 * keyed on the success, and neither is in this change.
 */
export function FlatPoolForm({ operationId }: { operationId: string }) {
  const [state, formAction] = useActionState<FlatPoolEditState, FormData>(
    addFlatPoolAction.bind(null, operationId),
    null,
  );
  const rejected = state !== null && !state.ok;

  return (
    <form action={formAction} className="form-stack">
      {/* Mounted unconditionally — see ui.tsx's Notice docblock: `{err && ...}`
          inserts a role="alert" node already holding its text, which most ATs
          announce far less reliably than a region born empty and mutated. */}
      <Notice tone="bad">
        {rejected ? lookupErrorMessage(OPERATION_ERRORS, state.code) : ""}
      </Notice>
      <label className="form-stack__field">
        Total value (ISK)
        <input
          className="field"
          type="number"
          step="0.01"
          min="0"
          name="totalValue"
          required
          defaultValue={rejected ? state.totalValue : ""}
        />
      </label>
      <label className="form-stack__field">
        Note (required — why this number)
        <input
          className="field"
          name="notes"
          required
          defaultValue={rejected ? state.notes : ""}
        />
      </label>
      <label className="form-stack__field">
        What was in it (optional)
        <textarea
          className="field"
          name="rawPaste"
          rows={3}
          defaultValue={rejected ? state.rawPaste : ""}
        />
      </label>
      <Submit className="btn">Add flat pool</Submit>
    </form>
  );
}

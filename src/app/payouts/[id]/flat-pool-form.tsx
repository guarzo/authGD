"use client";

import { useActionState, useEffect, useState } from "react";
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
 * (which wasn't). `useActionState` returns state instead of navigating, the
 * same trick this page's in-place editors use via `InlineEdit`, so this form
 * stays mounted across a rejection rather than being torn down by a redirect.
 *
 * Staying mounted is necessary but not what actually preserves the three
 * values — that's the controlled state below, matching `AppraiseForm`.
 * `FlatPoolEditState`'s rejection variant carries only the `code`, not the
 * three submitted strings, precisely because nothing here reads them back:
 * the fields are controlled `useState`, so what the operator typed is still
 * sitting in React state (and the DOM) regardless of what the action returns.
 * This form doesn't go through a native submit or a `redirect()` either —
 * `formAction` settles client-side and never touches the DOM's own value
 * attributes — so a rejection needs no restore code at all: nothing ever
 * clears what the operator typed, on either outcome. That symmetry used to be
 * the bug. `defaultValue` compiles to the `value` *attribute*, and a browser
 * ignores an attribute change on an input whose dirty value flag is set —
 * which it is, the moment the operator types — so an *uncontrolled* version
 * of this form never cleared on success either: the total and note were still
 * there after a successful add, letting a second press of "Add flat pool"
 * bank the same numbers twice. The effect below is the only place that now
 * clears the fields, and it only fires on `state.ok`.
 */
export function FlatPoolForm({ operationId }: { operationId: string }) {
  const [state, formAction] = useActionState<FlatPoolEditState, FormData>(
    addFlatPoolAction.bind(null, operationId),
    null,
  );
  const rejected = state !== null && !state.ok;

  const [totalValue, setTotalValue] = useState("");
  const [notes, setNotes] = useState("");
  const [rawPaste, setRawPaste] = useState("");

  // A fresh `state` object arrives per successful submit (even one that banks
  // the exact same numbers again), so this fires once per add and never on a
  // stale `state` left over from a previous one. Nothing runs on rejection —
  // see the docblock above for why that needs no code of its own.
  useEffect(() => {
    if (state?.ok) {
      setTotalValue("");
      setNotes("");
      setRawPaste("");
    }
  }, [state]);

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
          value={totalValue}
          onChange={(e) => setTotalValue(e.target.value)}
        />
      </label>
      <label className="form-stack__field">
        Note (required — why this number)
        <input
          className="field"
          name="notes"
          required
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <label className="form-stack__field">
        What was in it (optional)
        <textarea
          className="field"
          name="rawPaste"
          rows={3}
          value={rawPaste}
          onChange={(e) => setRawPaste(e.target.value)}
        />
      </label>
      <Submit className="btn">Add flat pool</Submit>
    </form>
  );
}

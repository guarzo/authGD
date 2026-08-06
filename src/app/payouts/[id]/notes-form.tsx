"use client";

import { useActionState, useEffect, useState } from "react";
import { Submit } from "@/app/_components/submit";

type SaveState = { ok: true; at: number } | null;

/**
 * Notes used to render behind `InlineEdit`'s edit/view toggle: "None" and a
 * closed "edit" trigger, right for a field an operator reaches for
 * occasionally (corp share, battle report) and wrong for notes, which read
 * more naturally as a standing field on the operation than as something to
 * unlock first. This form is always open instead: a labelled textarea holding
 * the current notes, and a Save button, with no view/edit toggle at all.
 *
 * The textarea is controlled (`useState`, not `defaultValue`), for the same
 * reason `NewOperationForm`'s fields are (`../new/new-operation-form.tsx`):
 * React DOM's `<form action>` integration resets a form's *uncontrolled*
 * fields to their mount-time value the instant the action promise settles,
 * on success as much as on rejection. `InlineEdit` gets away with
 * `defaultValue` because its form unmounts on success (it swaps back to view
 * mode); this one never unmounts, so an uncontrolled field would snap the
 * just-saved text back to whatever the textarea held when this component
 * first mounted. A controlled value survives that reset because React
 * re-applies it on the next render.
 *
 * `setNotesAction` validates nothing, so unlike `InlineEdit` this component
 * has no bad-input path to convert into a redirect: there is no such thing as
 * a malformed note. It can still reject, though. `setNotes` calls
 * `assertEditable`, which throws `PayoutLockedError` once the operation is
 * finalized or has a payment, and the `canEdit` gate at the call site narrows
 * that window without closing it — a second tab, or another operator
 * finalizing first, freezes the operation while this textarea sits open. That
 * throw is caught in `setNotesAction` and redirected as `?error=locked` rather
 * than left to error.tsx, so the operator is told the operation froze instead
 * of being told we broke. The typed text is gone either way; only the
 * explanation differs.
 */
export function NotesForm({
  action,
  initialValue,
}: {
  /** The server action, already bound to the operation id
   *  (`setNotesAction.bind(null, operation.id)`). */
  action: (formData: FormData) => Promise<void>;
  /** The stored notes as of mount. Deliberately NOT named `value`: this is a
   *  starting point, not a binding. The state below is seeded from it once and
   *  never re-syncs, which is what lets a half-typed note survive an unrelated
   *  action elsewhere on the page revalidating underneath it — and it is why a
   *  note another operator saved in the meantime will not appear here until
   *  the page is reloaded. A last-write-wins field on a page one operator runs
   *  at a time; if that stops being true, this is the line to revisit. */
  initialValue: string;
}) {
  const [notes, setNotes] = useState(initialValue);
  const [announcement, setAnnouncement] = useState("");
  const [state, formAction] = useActionState<SaveState, FormData>(
    async (_prev, formData) => {
      await action(formData);
      return { ok: true, at: Date.now() };
    },
    null,
  );

  useEffect(() => {
    if (!state?.ok) return;
    setAnnouncement("notes saved");
    // Same 2s clear `InlineEdit` uses: long enough to be seen or heard, short
    // enough that it doesn't sit around claiming a save just happened.
    const t = setTimeout(() => setAnnouncement(""), 2000);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <form action={formAction} className="form-stack">
      {/* `aria-label`, not a visible `<label>`: this form is the `dd` of a
          `<dt>Notes</dt>` row in the facts grid, so a visible label would put
          the word "Notes" twice on one row, once as the grid's own label and
          again inside the value. The name is `InlineEdit`'s former one
          verbatim ("operation notes"), so anything keyed to it still finds the
          field. */}
      <textarea
        className="field"
        name="notes"
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        aria-label="operation notes"
      />
      {/* Full 36px: this sits under the notes textarea in the operation's own
          panel, not in a table row, so DESIGN.md's 28px ration does not cover
          it. (An earlier version of this comment said `.field` "beside it" is
          2.25rem — wrong twice over: `.form-stack` puts the textarea *above*
          this button, and a `rows={3}` textarea is far past that floor anyway.
          The 36px is DESIGN.md's standalone grade, not a match to a neighbour.) */}
      <Submit className="btn" aria-label="save notes" pendingLabel="saving…">
        Save
      </Submit>
      {/* Mounted unconditionally, empty at rest — the shape AT most often
          misses (see `ConfirmSubmit`'s own live region, `confirm-submit.tsx`,
          for the same argument). */}
      <span role="status" className="visually-hidden">
        {announcement}
      </span>
    </form>
  );
}

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
 * `setNotesAction` has no rejection path at all — it trims, saves and
 * revalidates unconditionally — so unlike `InlineEdit` this component does
 * not need a redirect-on-reject escape hatch: every submit here either
 * succeeds or throws, and a throw lands on error.tsx like everywhere else on
 * this page.
 */
export function NotesForm({
  action,
  value,
}: {
  /** The server action, already bound to the operation id
   *  (`setNotesAction.bind(null, operation.id)`). */
  action: (formData: FormData) => Promise<void>;
  /** The stored notes, used as the textarea's initial content. */
  value: string;
}) {
  const [notes, setNotes] = useState(value);
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
      <Submit className="btn btn--micro" aria-label="save notes" pendingLabel="saving…">
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

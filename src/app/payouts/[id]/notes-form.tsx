"use client";

import { useActionState, useState } from "react";
import { Submit } from "@/app/_components/submit";

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
 *
 * Owner walkthrough 2026-08-07, finding 1.3: the save confirmation used to be
 * `.visually-hidden` permanently — a sighted operator pressing Save got no
 * feedback at all, the textarea already showed what was typed so nothing else
 * on screen changed, and "saving…" flashes for the length of one round trip
 * and reads as nothing happened. `_components/note-form.tsx`'s `"· saved"` is
 * the precedent this now follows: one `role="status"` span carries both
 * channels — visible text for a sighted operator, the same node's content
 * change for AT — rather than a separate hidden live region saying something
 * different, which would leave the two channels announcing two different
 * things for the same event. What gates it is a comparison, not a flag: the
 * action returns the value it actually sent, and the confirmation shows only
 * while the textarea still holds that same text. See the state block below for
 * why a `dirty` boolean — the shape `note-form.tsx` uses, and this file's own
 * first version — cannot express that correctly.
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
  // The text the server last acknowledged — reported by the action itself, from
  // the `FormData` it actually sent, rather than inferred from a flag. `null`
  // until the first save of this mount. "Saved" then becomes a comparison
  // against what is on screen instead of a second piece of state to keep in
  // sync, which matters because the textarea stays editable while a save is in
  // flight: `Submit` only relabels itself, so it blocks a second click, not
  // typing.
  //
  // A `dirty` boolean cleared on success — `note-form.tsx`'s shape, and this
  // file's first version — gets that case wrong. Type "a", press Save, keep
  // typing during the round trip, and the action resolves for the snapshot it
  // sent; clearing `dirty` there leaves "· saved" standing over characters the
  // server never received, until the next keystroke happens to clear it. That
  // is the exact stale claim the flag was introduced to prevent. Comparing
  // values is correct by construction: the confirmation is shown only while the
  // textarea holds the acknowledged text, so it disappears the moment an edit
  // diverges from it and returns if that edit is undone — which is accurate,
  // since the server does hold that text.
  const [saved, formAction] = useActionState<string | null, FormData>(
    async (_prev, formData) => {
      await action(formData);
      // Narrow rather than coerce: `FormData.get` is typed `string | File |
      // null` for every field, so `String(...)` would quietly turn a `File`
      // into "[object File]" — a value that could never equal the textarea and
      // so would silently disable the confirmation. The impossible branch
      // returns `null`, which reads as "nothing acknowledged" and shows no
      // badge; failing closed is the right direction for a control whose whole
      // job is to not claim a save that did not happen. `action` does not
      // mutate the `FormData`, so reading it here is the same value it sent.
      const submitted = formData.get("notes");
      return typeof submitted === "string" ? submitted : null;
    },
    null,
  );

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
      {/* `notes-form__saved` carries no style rule of its own — `dim mono` do
          that, same as `note-form.tsx`'s `note-form__saved`. It exists so the
          e2e test has a selector that survives a wording or utility-class
          change. Rendered unconditionally, only its text content toggling: AT
          announces a *change* to a live region far more reliably than one born
          already holding text (see `ConfirmSubmit`'s own live region for the
          same argument), and a screen-reader user getting nothing here is
          exactly the dead-click failure finding 1.3 is about. `saved` is `null`
          before the first save, and `notes` is always a string, so the
          comparison is false at rest without needing its own guard. */}
      <span className="notes-form__saved dim mono" role="status">
        {notes === saved ? "· saved" : ""}
      </span>
    </form>
  );
}

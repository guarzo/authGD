"use client";

import { useActionState, useState } from "react";
import { Submit } from "./submit";

/**
 * The note field's own value already showed what was typed and the drawer
 * stays open by design, so a successful save changed nothing else on screen —
 * "saving…" flashed for ~50ms and a click read as dead. `useActionState`'s
 * returned state is the signal that fires only once the write actually
 * completes, so `"· saved"` next to the button is real feedback rather than
 * an optimistic guess.
 *
 * The confirmation has to clear the instant the note is edited again, or it's
 * a stale claim sitting next to unsaved text. `useActionState`'s own state
 * stays at its last value until the *next* submit, so `dirty` tracks "typed
 * since the last save" independently and gates the visible confirmation on
 * it; `onChange` sets it, and the state-vs-`seen` check below clears it the
 * moment a save actually lands.
 */
export function NoteForm({
  action,
  identity,
  defaultValue,
}: {
  action: (prevState: number, formData: FormData) => Promise<number>;
  identity: string;
  defaultValue: string;
}) {
  const [state, formAction] = useActionState(action, 0);
  const [dirty, setDirty] = useState(false);
  // Adjusting state during render (React's documented pattern for reacting to
  // a changed value without the extra render pass an effect would cost):
  // `state` is `saveNoteAction`'s own counter, incremented once per
  // successful save, so comparing it against the last one this component has
  // seen is what tells "a save just landed" apart from "still showing the
  // last one" — including two saves in a row, which a value that could repeat
  // (a fixed sentinel, a clock reading two saves could tie on) would miss.
  const [seen, setSeen] = useState(0);
  if (state !== seen) {
    setSeen(state);
    setDirty(false);
  }

  return (
    <form action={formAction} className="note-form">
      <input
        className="field"
        name="note"
        defaultValue={defaultValue}
        placeholder="notes"
        aria-label={`Note for ${identity}`}
        onChange={() => setDirty(true)}
      />
      <Submit
        className="btn btn--micro"
        pendingLabel="saving…"
        aria-label={`save note for ${identity}`}
      >
        save note
      </Submit>
      {/* Same role choice as `Notice`'s info tone (ui.tsx): a confirmation
          meant to be announced without stealing focus. Rendered
          unconditionally, only its text content toggling, rather than the
          element itself mounting already populated: AT announces a *change* to
          a live region far more reliably than a region born already holding
          text, and a screen-reader user getting nothing here is exactly the
          dead-click failure this whole feature exists to fix. `Notice` now
          holds the same behaviour in its empty-slot mode, so this is the same
          argument made twice rather than a local deviation.

          `note-form__saved` carries no style rule of its own — `dim mono` do
          that. It exists so the e2e test has a selector that survives a
          wording or utility-class change, since the visible text is the
          thing under test. */}
      <span className="note-form__saved dim mono" role="status">
        {state !== 0 && !dirty ? "· saved" : ""}
      </span>
    </form>
  );
}

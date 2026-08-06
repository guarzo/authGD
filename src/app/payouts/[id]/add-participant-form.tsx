"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Notice } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { addParticipantAction } from "../actions";
import type { StringFieldEditState } from "../actions";
import { OPERATION_ERRORS, lookupErrorMessage } from "../errors";

const CHARACTER_LIST_ID = "known-character-names";

/**
 * A client component only because the rejection round trip now needs one —
 * the `<datalist>` itself is still a plain, JS-free browser feature (see the
 * comment this replaced in `page.tsx`); nothing about how it filters changed.
 *
 * Before this, a rejected add (a blank name, or one already on the roster)
 * went out through `operationFailed`'s `?error=` redirect, which cleared the
 * typed name along with everything else on the page render. `useActionState`
 * returns state instead, so this form stays mounted rather than being torn
 * down by a redirect — the same fix `InlineEdit` applies to this page's
 * in-place editors, kept as its own component here only because of the
 * `<datalist>` this one alone renders. The heading lives on the enclosing
 * `Disclosure`'s summary in `page.tsx`, not here.
 *
 * Staying mounted is necessary but not what actually preserves the name —
 * that's the controlled state below, matching `AppraiseForm`. The rejection
 * variant of `StringFieldEditState` still carries `value` (see that type's
 * own docblock — `InlineEdit` reads it back on a real edit), but this
 * component never reads `state.value`: the field is controlled `useState`,
 * so what the operator typed is still sitting in React state (and the DOM)
 * regardless of what the action returns. This form doesn't go through a
 * native submit or a `redirect()` either — `formAction` settles client-side
 * and never touches the DOM's own value attribute — so a rejection needs no
 * restore code at all: nothing ever clears what the operator typed, on either
 * outcome. That symmetry used to be the bug: `defaultValue` sets the `value`
 * *attribute*, which a browser ignores once the input's dirty value flag is
 * set, so an *uncontrolled* version of this field never cleared on success
 * either — the typed name stayed on screen after a successful add, and a
 * second press of "Add participant" added the same person twice, each
 * duplicate drawing a full share. The effect below is the only place that now
 * clears the field, and it only fires on `state.ok`.
 */
export function AddParticipantForm({
  operationId,
  characterNames,
}: {
  operationId: string;
  characterNames: string[] | null;
}) {
  const [state, formAction] = useActionState<StringFieldEditState, FormData>(
    addParticipantAction.bind(null, operationId),
    null,
  );
  const rejected = state !== null && !state.ok;
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // A fresh `state` object arrives per successful submit, so this fires once
  // per add and never on a stale `state` left over from a previous one.
  useEffect(() => {
    if (state?.ok) setValue("");
  }, [state]);

  useEffect(() => {
    if (rejected) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [state]);

  return (
    <form action={formAction} className="form-stack">
      <label className="form-stack__field">
        Character name
        <input
          ref={inputRef}
          className="field"
          name="name"
          list={characterNames ? CHARACTER_LIST_ID : undefined}
          autoComplete="off"
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={rejected || undefined}
        />
      </label>
      {characterNames && (
        <datalist id={CHARACTER_LIST_ID}>
          {characterNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      )}
      {/* Mounted unconditionally — see ui.tsx's Notice docblock. */}
      <Notice tone="bad">
        {rejected ? lookupErrorMessage(OPERATION_ERRORS, state.code) : ""}
      </Notice>
      <Submit className="btn">Add participant</Submit>
    </form>
  );
}

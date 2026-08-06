"use client";

import { useActionState, useEffect, useRef } from "react";
import { Notice, RuleHead } from "@/app/_components/ui";
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
 * returns the rejected name as state instead, so this form stays mounted and
 * the name the operator typed is still sitting in the field when the
 * rejection notice appears next to it — the same fix `InlineEditField`
 * applies to this page's other single-field forms, kept as its own component
 * here only because of the `<datalist>` this one alone renders.
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
  // Empty, not a stored value: this form adds a new row rather than editing
  // one, so there is no "current server value" to fall back to on success.
  // Note that `""` does not blank the field either — `defaultValue` sets the
  // `value` attribute, which a browser ignores once the input's dirty value
  // flag is set, so the typed name stays visible after a successful add. That
  // matches the previous server-rendered form's behaviour; clearing it would
  // need a `ref` reset or a remount `key`, neither of which is in this change.
  const value = rejected ? state.value : "";
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (rejected) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [state]);

  return (
    <form action={formAction} className="form-stack">
      <RuleHead as="h3">Add one participant</RuleHead>
      <label className="form-stack__field">
        Character name
        <input
          ref={inputRef}
          className="field"
          name="name"
          list={characterNames ? CHARACTER_LIST_ID : undefined}
          autoComplete="off"
          required
          defaultValue={value}
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

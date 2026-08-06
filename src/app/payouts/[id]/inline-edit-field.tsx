"use client";

import { useActionState, useEffect, useRef } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { Notice } from "@/app/_components/ui";
import { Submit } from "@/app/_components/submit";
import { OPERATION_ERRORS, lookupErrorMessage } from "../errors";
import type { StringFieldEditState } from "../actions";

/**
 * The single-value twin of `AppraiseForm`: every inline editor on this page
 * that collects exactly one text/number field (unit price, shares, operation
 * name/date/battle-report URL, a new participant's name) used to be a plain
 * `<form action={...}>` that redirected to `?error=` on rejection. That
 * redirect could only carry a fixed code, never the value that produced it —
 * a rejected edit re-rendered from server state and the typed value was
 * simply gone, on exactly the press where an operator correcting a payout
 * number most needed to still see what they'd typed.
 *
 * `useActionState` fixes it the same way `AppraiseForm` already fixed the
 * loot paste: the action returns state instead of navigating, so this
 * component never unmounts and the input the operator typed into is still
 * exactly what it was — nothing ever replaced the DOM it sits in. `value`
 * only ever falls back to `state.value` (the rejected input) while `state` is
 * a rejection; the moment a submit succeeds, `state.ok` is `true`, this reads
 * `serverValue` instead, and a full-page revalidation has already made
 * `serverValue` equal to what was just saved. That is what stops a rejected
 * value from ever being confused with a committed one on a money screen: the
 * only way this shows the just-typed text is while an error is also on
 * screen naming what was wrong with it.
 *
 * Refocuses (and selects) the input on every rejection, not just the first —
 * a second, differently-wrong number is exactly the case a retyped value
 * under time pressure produces, and each attempt deserves the same landing
 * spot. Unlike `ConfirmNotice`, this does not pass `live={false}` to the
 * `Notice`: focus lands on the INPUT here, a different DOM node from the
 * `Notice` paragraph, so there is no same-node double-announce to guard
 * against (see that component's own docblock for the case that does apply).
 * The live region names what was wrong; the focus move puts the operator
 * back in the field to fix it.
 *
 * `type` is forced to `"text"` while rejected, whatever `inputProps` asked
 * for otherwise. `type="number"` (unit price, shares) and `type="date"`
 * (operation date) are both platform inputs that refuse to hold a string
 * their own type can't parse — setting `.value` to `"abc"` or a
 * comma-grouped `"1,234.00"` on a number input is not merely re-formatted,
 * it is silently discarded back to `""` by the browser itself, no matter
 * whether the assignment comes from React's `defaultValue` or a raw DOM
 * write. A genuinely malformed reject (reachable via a scripted client or a
 * paste, not by typing — see `bypassClientGuard` in `e2e/payouts.spec.ts`)
 * would otherwise vanish from the field the instant this component
 * re-renders with the rejected value, defeating the whole point of this fix
 * for exactly the input worth showing back the most. A plain text box has no
 * such native validation and can hold anything the server saw.
 */
export function InlineEditField({
  action,
  name,
  serverValue,
  inputProps,
  submitLabel = "save",
  submitAriaLabel,
  submitClassName = "btn btn--micro",
  formClassName = "inline-form",
}: {
  action: (
    prevState: StringFieldEditState,
    formData: FormData,
  ) => Promise<StringFieldEditState>;
  name: string;
  /** The value this field holds right now, per the last server render —
   *  shown whenever there is no in-flight rejection to override it. */
  serverValue: string;
  inputProps?: Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "name" | "defaultValue" | "ref" | "aria-invalid"
  >;
  submitLabel?: ReactNode;
  submitAriaLabel?: string;
  submitClassName?: string;
  formClassName?: string;
}) {
  const [state, formAction] = useActionState<StringFieldEditState, FormData>(
    action,
    null,
  );
  const rejected = state !== null && !state.ok;
  const value = rejected ? state.value : serverValue;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (rejected) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    // `state` (not just `rejected`) is the dependency: a second rejection
    // with the same `rejected === true` still has to re-fire the focus move,
    // and object identity changes on every action call — see the docblock.
  }, [state]);

  return (
    <>
      <form action={formAction} className={formClassName}>
        <input
          {...inputProps}
          type={rejected ? "text" : inputProps?.type}
          ref={inputRef}
          name={name}
          defaultValue={value}
          aria-invalid={rejected || undefined}
        />
        <Submit className={submitClassName} aria-label={submitAriaLabel}>
          {submitLabel}
        </Submit>
      </form>
      {/* Mounted unconditionally, never `{err && <Notice>}` — see ui.tsx's
          Notice docblock for why the `&&` form defeats the live region it
          just asked for. */}
      <Notice tone="bad">
        {rejected ? lookupErrorMessage(OPERATION_ERRORS, state.code) : ""}
      </Notice>
    </>
  );
}

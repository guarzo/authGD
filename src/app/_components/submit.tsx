"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * `useFormStatus` only works inside a `<form>`, and only from a client
 * component: the pages that render these buttons are otherwise plain server
 * components, so the pending state has to live in a small client leaf rather
 * than the page itself. Without it a slow enqueue looks identical to a dead
 * click until the page re-renders.
 *
 * `pendingLabel` swaps the text while in flight. Worth it on the broad
 * side-effecting controls: `disabled` plus `aria-busy` are correct but easy to
 * miss, and a changed word is the part a user actually notices.
 *
 * `className` defaults to `"btn"` rather than staying free-form or moving to
 * a closed `grade` union: real call sites stack a colour grade, a size
 * modifier and an occasional layout utility together in one string
 * (`"btn btn--quiet btn--micro"`, `"btn btn--micro nowrap"`), which a single
 * enum value can't express without either losing a combination this codebase
 * already relies on or growing into an array-valued prop — more surgery than
 * this pass calls for. Defaulting the string closes the actual bug this
 * primitive had (omit `className` entirely and you got a raw, unstyled UA
 * button): every call site still spells out its own combination, but leaving
 * it off no longer produces one the system never sanctioned.
 */
export function Submit({
  className = "btn",
  children,
  disabled,
  pendingLabel,
  "aria-pressed": ariaPressed,
  // Opt-in only: a button whose visible text already names the thing it acts on
  // should not carry one. Every control on an admin accounts row needs it,
  // drawer or not, because "blue", "freeze" and "sync now" all say nothing
  // about whose account is about to change.
  "aria-label": ariaLabel,
}: {
  className?: string;
  children: ReactNode;
  disabled?: boolean;
  pendingLabel?: ReactNode;
  "aria-pressed"?: boolean;
  "aria-label"?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={disabled || pending}
      aria-busy={pending}
      aria-pressed={ariaPressed}
      aria-label={ariaLabel}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

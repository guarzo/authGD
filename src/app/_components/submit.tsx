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
 */
export function Submit({
  className,
  children,
  disabled,
  pendingLabel,
  "aria-pressed": ariaPressed,
  // Opt-in only: a button whose visible text already names the thing it acts on
  // should not carry one. The admin row drawer needs it because "blue" and
  // "freeze" say nothing about whose tier is about to change.
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

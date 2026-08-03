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
}: {
  className?: string;
  children: ReactNode;
  disabled?: boolean;
  pendingLabel?: ReactNode;
  "aria-pressed"?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={disabled || pending}
      aria-busy={pending}
      aria-pressed={ariaPressed}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * `useFormStatus` only works inside a `<form>`, and only from a client
 * component: the pages that render these buttons are otherwise plain server
 * components, so the pending state has to live in a small client leaf rather
 * than the page itself. Without it a slow enqueue looks identical to a dead
 * click until the page re-renders.
 */
export function Submit({
  className,
  children,
  disabled,
  "aria-pressed": ariaPressed,
}: {
  className?: string;
  children: ReactNode;
  disabled?: boolean;
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
      {children}
    </button>
  );
}

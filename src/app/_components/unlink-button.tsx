"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

/** How long an armed confirm holds before it quietly reverts. Long enough to
 *  read the label change, short enough that a control armed and abandoned
 *  doesn't stay a trap for the next click days later. */
const REVERT_MS = 4000;

/**
 * A no-undo action gets a second click instead of a modal (DESIGN.md rules out
 * modal-as-first-thought). At rest this is `type="submit"` with the accessible
 * name `unlink`, identical to a plain `Submit` — the first click always calls
 * `preventDefault` and arms the control instead of submitting, so nothing ships
 * to the server until a second, deliberate click lands on the same button.
 * Arming reverts on blur or after `REVERT_MS`, so leaving the page or moving on
 * to another row never leaves a live confirm behind.
 *
 * Styling stays the row's ordinary quiet/danger-quiet classes at rest — the
 * e2e spec pins the rest colour and right edge across both rows — and escalates
 * to `.btn--danger` only once armed. Never a filled ground: DESIGN.md reserves
 * that for the primary action, and a destructive control merely takes the red
 * border and text.
 */
export function UnlinkButton() {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { pending } = useFormStatus();

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function arm() {
    setArmed(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setArmed(false), REVERT_MS);
  }

  function disarm() {
    setArmed(false);
    if (timer.current) clearTimeout(timer.current);
  }

  return (
    <button
      type="submit"
      className={
        armed
          ? "btn btn--micro btn--danger"
          : "btn btn--quiet btn--micro btn--danger-quiet"
      }
      disabled={pending}
      aria-busy={pending}
      onClick={(e) => {
        if (!armed) {
          e.preventDefault();
          arm();
        }
      }}
      onBlur={disarm}
    >
      {pending ? "unlinking…" : armed ? "confirm?" : "unlink"}
    </button>
  );
}

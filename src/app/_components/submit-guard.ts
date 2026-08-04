"use client";

import { useEffect, useRef, type MouseEvent } from "react";

/**
 * Re-entry guard for a submit button that stays focusable while its form is in
 * flight.
 *
 * `disabled` used to do this job, and it did it by destroying focus: disabling
 * the element the member just pressed moves focus to `<body>`, and because
 * every one of these actions ends in a server-action `redirect()` — a client
 * navigation with no document load — there is nothing afterwards that puts it
 * back. `error.tsx:213-222` already refuses `disabled` for exactly this reason.
 * So the button keeps `aria-busy`, keeps focus, and stops a second submit here
 * instead.
 *
 * A ref rather than `useFormStatus().pending`: `pending` only becomes true on
 * the render that follows the first submit, and a double-click lands both
 * clicks inside that window. The ref is set synchronously in the first click's
 * own handler, which is the only thing fast enough. This matters most on
 * `/payouts/new`, where creating an operation is not idempotent and there is no
 * delete path — two clicks there must not be able to make two operations.
 *
 * The latch is taken only once the form is known to be submittable, because a
 * click that the browser blocks on constraint validation produces no submit and
 * therefore no `pending` transition to clear it again — latching there would
 * leave the button permanently dead. For the same reason the release effect has
 * no dependency array: it runs after every render, so any render that finds the
 * form idle releases the latch, not only the one where `pending` flips back.
 */
export function useSubmitGuard(pending: boolean) {
  const inFlight = useRef(false);

  useEffect(() => {
    if (!pending) inFlight.current = false;
  });

  return function guard(e: MouseEvent<HTMLButtonElement>): boolean {
    if (inFlight.current || pending) {
      e.preventDefault();
      return false;
    }
    const form = e.currentTarget.form;
    if (form && !form.checkValidity()) return false;
    inFlight.current = true;
    return true;
  };
}

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
 * back. `error.tsx:185-189` already refuses `disabled` for exactly this reason.
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
 * leave the button permanently dead.
 *
 * Release waits for `pending` to have been observed true and then false again,
 * rather than for any render that happens to find it false. A bare
 * `if (!pending) release()` in an effect with no dependencies looks equivalent
 * and is not: it also fires on a re-render that arrives in the window between
 * the click and React committing the action's pending state, which would reopen
 * the double-submit window this exists to close. `/payouts/new` has no other
 * client state that could produce such a render, but this is a shared primitive
 * and `ConfirmSubmit` sits in tables that do.
 */
export function useSubmitGuard(pending: boolean) {
  const inFlight = useRef(false);
  const started = useRef(false);

  useEffect(() => {
    if (pending) {
      started.current = true;
    } else if (started.current) {
      started.current = false;
      inFlight.current = false;
    }
  });

  return function guard(e: MouseEvent<HTMLButtonElement>): boolean {
    if (inFlight.current || pending) {
      e.preventDefault();
      return false;
    }
    const form = e.currentTarget.form;
    // Latch only where a submit is actually about to happen. A click the
    // browser blocks on constraint validation produces no submit and therefore
    // no `pending` transition to release the latch again, which would leave the
    // button permanently dead — and the same is true of a button with no form
    // at all. `noValidate` is checked because it is what decides whether the
    // browser blocks: on such a form `checkValidity()` still reports the fields
    // invalid but the submit goes through anyway, and skipping the latch there
    // would quietly turn the guard off.
    if (!form) return false;
    if (!form.noValidate && !form.checkValidity()) return false;
    inFlight.current = true;
    return true;
  };
}

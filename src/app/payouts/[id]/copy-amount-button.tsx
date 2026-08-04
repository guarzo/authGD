"use client";

import { useState } from "react";

/**
 * The only client affordance PR 1's pay flow needs. No `esi-ui.open_window.v1`
 * scope, no window — the design defers that decision to a later PR. What
 * actually goes wrong today is transcribing a twelve-digit ISK figure by hand;
 * this removes exactly that step and nothing else.
 *
 * The visible label never changes. It used to swap to "copied"/"copy failed",
 * which conveyed the result visually only, and swapping the accessible name
 * away from "copy amount" while this row's siblings all name themselves
 * ("save {name} shares", "open info for {name}") would have meant *this*
 * button couldn't carry the participant's name too without breaking WCAG
 * 2.5.3 — the accessible name has to start with the visible text, and it
 * can't do that if the visible text keeps changing out from under it. So the
 * name goes on the accessible name via `aria-label` (same shape as
 * `PaymentHistory`'s `summary`/`ariaLabel` pair) and the result goes to a
 * polite live region instead — `role="status"`, never `role="alert"`, since
 * Next's own route announcer already uses `alert` on every soft navigation
 * this page does.
 */
export function CopyAmountButton({
  amount,
  participantName,
}: {
  amount: string;
  participantName: string;
}) {
  const [announcement, setAnnouncement] = useState("");
  // onClick must return void, not a Promise (no-misused-promises) — the
  // clipboard write is fired and handled here rather than awaited by React.
  function showFailed(): void {
    setAnnouncement(`Could not copy ${participantName}'s amount.`);
  }
  function handleClick(): void {
    // `navigator.clipboard` is undefined outside a secure context, not merely
    // a rejecting promise — reading `.writeText` off it throws synchronously,
    // so the `.catch` below never gets attached and the button silently does
    // nothing. The failure path has to be entered by hand for that case.
    if (!navigator.clipboard?.writeText) {
      showFailed();
      return;
    }
    void navigator.clipboard
      .writeText(amount)
      .then(() => {
        setAnnouncement(`Copied ${participantName}'s amount.`);
      })
      .catch(() => {
        // A denied permission rejects rather than throwing — same visible
        // feedback, so an operator never clicks a button that appears dead.
        showFailed();
      });
  }
  return (
    <>
      <button
        type="button"
        className="btn btn--quiet btn--micro"
        aria-label={`copy amount for ${participantName}`}
        onClick={handleClick}
      >
        copy amount
      </button>
      <span role="status" aria-live="polite" className="visually-hidden">
        {announcement}
      </span>
    </>
  );
}

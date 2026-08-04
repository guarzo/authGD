"use client";

import { useState } from "react";

/**
 * The only client affordance PR 1's pay flow needs. No `esi-ui.open_window.v1`
 * scope, no window — the design defers that decision to a later PR. What
 * actually goes wrong today is transcribing a twelve-digit ISK figure by hand;
 * this removes exactly that step and nothing else.
 *
 * The visible label never changes. It used to swap to "copied"/"copy failed",
 * and swapping the accessible name away from "copy amount" while this row's
 * siblings all name themselves ("save {name} shares", "open info for {name}")
 * would have meant *this* button couldn't carry the participant's name too
 * without breaking WCAG 2.5.3, which requires the accessible name to contain
 * the visible label text — it can't, if the visible text keeps changing out
 * from under it. So the name goes on the accessible name via `aria-label`
 * (same shape as `PaymentHistory`'s `summary`/`ariaLabel` pair) and the result
 * moves to the status line beside the button.
 *
 * That status line is deliberately visible rather than `.visually-hidden`.
 * Announcing only to a screen reader would have bought this button's
 * accessible name at the price of the feedback everyone else was already
 * getting: a failed clipboard write is exactly the case where a sighted
 * operator must not be left looking at a button that appears dead. It is a
 * live region as well, so both audiences learn the same thing — `role="status"`,
 * never `role="alert"`, since Next's own route announcer claims `alert` for
 * itself (`app-router-announcer.js` sets `role = "alert"`). It stays quiet on
 * this page's soft navigations, which all land back on the same title, but a
 * second assertive region is not a thing to add on that technicality.
 */
export function CopyAmountButton({
  amount,
  participantName,
}: {
  amount: string;
  participantName: string;
}) {
  const [result, setResult] = useState("");
  // onClick must return void, not a Promise (no-misused-promises) — the
  // clipboard write is fired and handled here rather than awaited by React.
  function showFailed(): void {
    setResult("copy failed");
    setTimeout(() => setResult(""), 2000);
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
        // Clearing first, then setting, so copying the same row twice running
        // is two announcements rather than one: a live region whose text does
        // not change is not re-read.
        setResult("");
        setTimeout(() => setResult("copied"), 0);
        setTimeout(() => setResult(""), 2000);
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
      <span role="status" aria-live="polite" className="dim copy-result">
        {result}
      </span>
    </>
  );
}

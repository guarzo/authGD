"use client";

import { useState } from "react";

/**
 * The only client affordance PR 1's pay flow needs. No `esi-ui.open_window.v1`
 * scope, no window — the design defers that decision to a later PR. What
 * actually goes wrong today is transcribing a twelve-digit ISK figure by hand;
 * this removes exactly that step and nothing else.
 */
export function CopyAmountButton({ amount }: { amount: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  // onClick must return void, not a Promise (no-misused-promises) — the
  // clipboard write is fired and handled here rather than awaited by React.
  function showFailed(): void {
    setCopied(false);
    setFailed(true);
    setTimeout(() => setFailed(false), 2000);
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
        setFailed(false);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // A denied permission rejects rather than throwing — same visible
        // feedback, so an operator never clicks a button that appears dead.
        showFailed();
      });
  }
  return (
    <button type="button" className="btn btn--quiet btn--micro" onClick={handleClick}>
      {failed ? "copy failed" : copied ? "copied" : "copy amount"}
    </button>
  );
}

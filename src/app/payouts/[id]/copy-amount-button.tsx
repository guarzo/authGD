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
  function handleClick(): void {
    void navigator.clipboard
      .writeText(amount)
      .then(() => {
        setFailed(false);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Permission denied or a non-secure context both reject silently —
        // an unhandled rejection here would leave the operator clicking a
        // button that appears to do nothing, so it gets the same visible
        // feedback treatment as success.
        setFailed(true);
        setTimeout(() => setFailed(false), 2000);
      });
  }
  return (
    <button type="button" className="btn btn--quiet btn--micro" onClick={handleClick}>
      {failed ? "copy failed" : copied ? "copied" : "copy amount"}
    </button>
  );
}

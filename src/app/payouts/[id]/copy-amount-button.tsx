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
  // onClick must return void, not a Promise (no-misused-promises) — the
  // clipboard write is fired and handled here rather than awaited by React.
  function handleClick(): void {
    void navigator.clipboard.writeText(amount).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button type="button" className="btn btn--quiet btn--micro" onClick={handleClick}>
      {copied ? "copied" : "copy amount"}
    </button>
  );
}

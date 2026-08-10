"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useSubmitGuard } from "./submit-guard";

/**
 * `useFormStatus` only works inside a `<form>`, and only from a client
 * component: the pages that render these buttons are otherwise plain server
 * components, so the pending state has to live in a small client leaf rather
 * than the page itself. Without it a slow enqueue looks identical to a dead
 * click until the page re-renders.
 *
 * `pendingLabel` swaps the text while in flight. Worth it on the broad
 * side-effecting controls: `aria-busy` is correct but easy to miss, and a
 * changed word is the part a user actually notices. The button is deliberately
 * *not* disabled while pending — see `submit-guard.ts` — so `pendingLabel` and
 * `aria-busy` are the whole of the in-flight signal, and the second click is
 * stopped by the guard rather than by an unfocusable button. The `disabled`
 * prop is still honoured for the other meaning of the word: a control the call
 * site knows is unavailable before anyone presses it.
 *
 * Not for a `<form method="get">`, and the mismatch runs both ways. Nothing it
 * offers can arrive: a native GET submit is a document navigation, not a
 * server action, so `useFormStatus()` reports `pending` false for the whole
 * life of the document and the button's `aria-busy` is a promise fixed at
 * "false". And the guard's latch, taken synchronously on the first click, is
 * released only by watching `pending` go true and then false again — a
 * transition that never happens here. In the ordinary path the document is
 * replaced before that matters, but a document that outlives its own
 * navigation (a stop press, a back into the bfcache) comes back with the latch
 * still set and the button permanently refusing every press, with no visible
 * trace. The three GET filter forms — `/admin/audit`, `/payouts`,
 * `/admin/accounts` — use a plain `<button type="submit">` instead. They lose
 * nothing: re-running a filter is idempotent, which is the whole reason the
 * guard has no work to do there.
 *
 * `className` defaults to `"btn"` rather than staying free-form or moving to
 * a closed `grade` union: real call sites stack a colour grade, a size
 * modifier and an occasional layout utility together in one string
 * (`"btn btn--quiet btn--micro"`, `"btn btn--micro nowrap"`), which a single
 * enum value can't express without either losing a combination this codebase
 * already relies on or growing into an array-valued prop — more surgery than
 * this pass calls for. Defaulting the string closes the actual bug this
 * primitive had (omit `className` entirely and you got a raw, unstyled UA
 * button): every call site still spells out its own combination, but leaving
 * it off no longer produces one the system never sanctioned.
 */
export function Submit({
  className = "btn",
  children,
  disabled,
  pendingLabel,
  "aria-pressed": ariaPressed,
  // Opt-in only: a button whose visible text already names the thing it acts on
  // should not carry one. Every control on an admin accounts row needs it,
  // drawer or not, because "associate", "freeze" and "sync now" all say nothing
  // about whose account is about to change.
  "aria-label": ariaLabel,
  // Opt-in only, same reasoning as `aria-label`: most Submits have nothing
  // below them worth pointing at. Wires a button to a consequence sentence
  // rendered elsewhere on the page (below a Scroller, say) when one exists for
  // this row — see `/account`'s "make main" note and `contactRemedyId` for the
  // pattern this follows.
  "aria-describedby": ariaDescribedBy,
  // Opt-in only. Called when the guard refuses a press because this form is
  // already in flight — the case that is otherwise entirely silent. The call
  // site owns the wording, since what to say depends on what is at stake; see
  // `submit-guard.ts` for why it fires from the re-entry branch only.
  onRefused,
  // Opt-in only: plain HTML button attributes for the one case where several
  // buttons share a single `<form>` and the submitted value is how the
  // action tells them apart — `/admin/access-lists`'s "Stop watching" row
  // buttons are the first caller (see that page's `page.tsx` for why the
  // form is shared rather than per-row). Passed straight through to the
  // `<button>` rather than growing a closed prop union: this is exactly what
  // `name`/`value` already mean on a submit button, nothing this component
  // needs to interpret. Both default to `undefined`, so no existing call
  // site's rendered button changes.
  name,
  value,
}: {
  className?: string;
  children: ReactNode;
  disabled?: boolean;
  pendingLabel?: ReactNode;
  "aria-pressed"?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
  onRefused?: () => void;
  name?: string;
  value?: string | number;
}) {
  const { pending } = useFormStatus();
  const guard = useSubmitGuard(pending, onRefused);
  return (
    <button
      type="submit"
      className={className}
      disabled={disabled}
      aria-busy={pending}
      aria-pressed={ariaPressed}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      onClick={guard}
      name={name}
      value={value}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

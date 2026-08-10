"use client";

import { useEffect, useRef } from "react";
import { Notice } from "@/app/_components/ui";

/**
 * The confirmation slot for a server action that redirects back into the page
 * it started from, carrying its one-line outcome and an enqueue-adjacent
 * instant as query params (`/account`'s `setMainAction`, `unlinkAction`,
 * `wakeSelfAction`, `unlinkDiscordAction`; `/admin/sync`'s `syncAllAction`,
 * `recheckInvalidAction`). `syncJobAction` used to be a third `/admin/sync`
 * call site and no longer is — see this docblock's own caveat below.
 *
 * Originally an `/account`-only component, generalized here to a shared
 * primitive and reused by `/admin/sync` rather than duplicated: both pages
 * solve the identical problem — a server action's redirect target re-renders
 * without a document load, and nothing in the framework moves focus for us
 * (see `focus-heading.tsx`) — and `/admin/sync`'s own `queuedNotice`/
 * `?queued=&at=` pattern was the original precedent both this and `/account`'s
 * `accountConfirmation`/`?done=&at=` drew from. Left alone, focus falls to
 * `<body>` and a keyboard or screen-reader member has to re-traverse the
 * document from the top to find out whether the press even landed — worse on
 * `/admin/sync`, where the enqueue buttons sit below seven job rows and
 * however many open drawers, so a sighted admin who doesn't scroll back up
 * sees nothing happen either and is liable to press again.
 *
 * This deliberately does NOT reuse `FocusHeading`. That component is scoped to
 * the three boundaries reached without a document load, where the `h1` itself
 * names a brand-new page and focusing it is the announcement. Neither page's
 * `h1` changes across these actions — re-focusing it would say exactly what it
 * said before the press and nothing about what just happened, which answers
 * neither of the two costs this exists to fix.
 *
 * Instead this focuses the confirmation text itself: the one landmark shared
 * by every action that redirects here, sitting where a member or admin's eye
 * already goes after a press.
 *
 * `live={false}` is required here, not optional. A `role="status"` node that
 * both receives focus and is mutated in the same commit gets announced twice
 * by some ATs — once for the focus move, once for the live-region mutation —
 * which is exactly the collision `ui.tsx`'s `Notice` docblock and `error.tsx`'s
 * own `live={false}` call both exist to avoid. Focus carries the announcement
 * here (a focused element's accessible name is read the same way a live
 * region's text is); the live region would only repeat it a beat later.
 *
 * Re-focuses on every `at` change, not just first mount. A soft navigation
 * back to the same page reconciles this component in place rather than
 * remounting it, so an effect gated on `[]` would fire once, ever, and every
 * later press would leave focus wherever the (now-gone) pressed control left
 * it. `at` is the same per-press instant that makes a repeat press
 * distinguishable in the notice text itself; here it also re-triggers the
 * focus move.
 *
 * That "reconciles in place" assumption holds only for a redirect target with
 * no client-side state of its own sitting between this component and the
 * pressed control. It was observed FALSE for two controls that live inside a
 * `Disclosure` (`_components/disclosure.tsx`), which holds its own open/closed
 * state in a plain `useState`: `/admin/accounts`'s per-row drawer and
 * `/admin/sync`'s per-job drawer each had a control that used to redirect
 * through this component, and each one closed its own drawer on the very
 * first press because of it. Neither uses `ConfirmNotice` for that control
 * anymore — both use `_components/confirm-group.tsx`'s `ConfirmingForm`/
 * `ConfirmGroup` instead, which threads the confirmation back through
 * `useActionState` with no navigation at all.
 *
 * Read that as two measured cases, NOT as "a redirect resets every `useState`
 * below it" — that broader claim is false, and this file's own caller list is
 * the counter-example. `/account`'s `setMainAction` and `unlinkAction` sit
 * inside the crew manifest's per-row actions drawer (`account/character-row.tsx`),
 * and the drawer measurably survives their redirect: it stays open, and on
 * `setMainAction` it follows the character to its new position as main. That
 * table's rows are keyed, so React moves the existing row instance rather than
 * remounting it, and the `useId` its open-state is matched on is stable for an
 * instance's lifetime.
 *
 * The practical rule is therefore empirical, not deductive in either
 * direction: a control with a client-state boundary between here and the
 * redirect target has to be MEASURED before being wired to this component.
 * Structural similarity to either the admin drawers or the manifest is
 * evidence, not proof. A control with no such boundary is the plain case this
 * component still covers correctly — see `/admin/sync`'s `syncAllAction`/
 * `recheckInvalidAction`, both below the strip entirely.
 */
export function ConfirmNotice({
  text,
  at,
}: {
  text: string;
  /** The enqueue-adjacent instant carried in `?at=`, present whenever `text`
   *  is. Read only to change on every press — never rendered here. */
  at: string | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Guarded on `text`: an ordinary page load with no confirmation to show
    // must not steal focus from wherever the browser would otherwise put it.
    if (text) ref.current?.focus();
  }, [at, text]);

  return (
    // No focus ring: same reasoning as `FocusHeading` — the global ring is
    // `:focus-visible`, which a programmatic focus on a non-input element
    // does not match.
    <div ref={ref} tabIndex={-1}>
      <Notice live={false}>{text}</Notice>
    </div>
  );
}

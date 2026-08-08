"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ConfirmCost, ConfirmSubmit } from "@/app/_components/confirm-submit";

const AnnounceContext = createContext<((message: string) => void) | null>(null);

/**
 * Holds the live region for whatever the lifecycle controls inside it just
 * did. Mount it somewhere that outlives those controls: `payouts/[id]/page.tsx`
 * puts it outside the `showLifecycle` gate, because a finalize by a
 * non-creator operator turns that gate false and would otherwise take the
 * announcer down with the button.
 *
 * That separation is the whole point. Finalize and Unlock each delete their
 * own button on success: `canFinalize`/`canRelease` flip on the server, and
 * the re-render that arrives with the action's own response drops the control
 * that fired. A `role="status"` span rendered by that button goes with it, and
 * so does any effect that would have filled it — an effect inside the button
 * does commit on mount like any other, but the post-success one never runs,
 * because the `setState` that would schedule it lands after the response has
 * already unmounted the component. The first version of this file announced
 * and moved focus from exactly such an effect, and the e2e assertion that
 * focus reaches the heading failed on `inactive`. So the region lives out
 * here, on a wrapper the response cannot unmount, and the button reaches it
 * through context.
 *
 * Focus is handled the same way and for the same reason, but in the action's
 * own continuation rather than here (see `LifecycleSubmit`).
 */
export function LifecycleAnnouncer({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = useCallback((next: string) => {
    setMessage(next);
    if (timer.current) clearTimeout(timer.current);
    // Same 2s clear `InlineEdit` uses: long enough to be heard, short enough
    // that it stops claiming a write just happened.
    timer.current = setTimeout(() => setMessage(""), 2000);
  }, []);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      {/* Mounted unconditionally, empty at rest: a region born holding its own
          text is the shape AT most often misses. */}
      <span role="status" className="visually-hidden">
        {message}
      </span>
    </AnnounceContext.Provider>
  );
}

/**
 * Finalize or Unlock: `ConfirmSubmit`'s arm-then-fire pair, plus the three
 * things that used to be missing once it fired (or, for the cost, before it
 * ever could) — a word about what happened, somewhere for focus to go, and a
 * readable answer to "what does this cost".
 *
 * Focus has to move because the button that took the press is the one element
 * guaranteed to be gone: leaving it alone drops a keyboard operator back to
 * `<body>`, at the top of the document, with nothing said. It goes to
 * `#operation-name`, the page's H1, given a stable id and `tabIndex={-1}` in
 * `page.tsx` for exactly this — the one element that survives every
 * combination of `canFinalize`/`canRelease`/`locked`. `InlineEdit` solves the
 * equivalent problem by handing focus back to its own trigger, which is only
 * available to it because closing its editor just swaps back to view mode.
 *
 * Both happen in the action's continuation rather than in an effect. An effect
 * belongs to a mounted component, and this one is unmounted by the very
 * response it is reacting to; the continuation is a promise callback that runs
 * regardless. React reconciles the H1 across that response rather than
 * replacing it (same element, same position, only its children differ by
 * `canEdit`), so focus set here survives the commit.
 *
 * The armed-state region `ConfirmSubmit` renders is a separate announcement —
 * arming, not outcome — and is untouched by this.
 *
 * `ConfirmCost` renders with `visibility="visible"` (see that component),
 * not the default `"reveal"`. Owner walkthrough 2026-08-07, finding 1.2: this
 * used to be `alwaysHidden`, which meant the sentence — good, accurate copy
 * about what Finalize or Unlock actually does — was `.visually-hidden`
 * *permanently*, so no sighted operator ever read it, at any point. That is
 * R4's failure, not the ordering one it was first reported as: the fix is not
 * "reveal it sooner", it is "stop hiding it from sighted users at all".
 * `"reveal"` is still wrong here for the reason the previous version of this
 * comment gave — a sentence appearing under Finalize the moment it arms reads
 * as an error message rather than as a cost — so `"visible"` is what lands: no
 * reveal step, rendered plainly every time, still the same `aria-describedby`
 * target a keyboard operator tabbing straight to the button hears ahead of the
 * press. `className="form-stack"` on the form below is what gives the button
 * and its now-permanently-visible cost their own stacked layout (button, then
 * caption on the line under it) rather than letting them run together as
 * inline siblings — the same idiom the roster-replace form already uses
 * (`page.tsx`'s `setRosterAction` form: `className="form-stack"`, holding both
 * its `ConfirmSubmit` and its `ConfirmCost`). Delete operation looks like a
 * second precedent and is not one — its `ConfirmCost` sits outside the form
 * and outside the `.btn-row` wrapping it, so that form never needed a stacking
 * rule, and its bare `<form>` is not evidence about this one.
 */
export function LifecycleSubmit({
  action,
  label,
  confirmName,
  costId,
  cost,
  className,
  announcement,
}: {
  /** The server action, already bound to the operation id
   *  (`finalizeAction.bind(null, operation.id)`). */
  action: (formData: FormData) => Promise<void>;
  label: string;
  confirmName: string;
  costId: string;
  cost: ReactNode;
  className: string;
  /** What the live region says once the action lands, e.g. "Operation
   *  finalized." */
  announcement: string;
}) {
  const announce = useContext(AnnounceContext);
  if (!announce) {
    throw new Error("LifecycleSubmit must be rendered inside a LifecycleAnnouncer");
  }

  return (
    <form
      className="form-stack"
      action={async (formData: FormData) => {
        await action(formData);
        announce(announcement);
        document.getElementById("operation-name")?.focus();
      }}
    >
      <ConfirmSubmit
        className={className}
        label={label}
        confirmName={confirmName}
        describedBy={costId}
      />
      <ConfirmCost id={costId} visibility="visible">
        {cost}
      </ConfirmCost>
    </form>
  );
}

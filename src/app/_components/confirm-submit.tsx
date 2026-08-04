"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from "react";
import { useFormStatus } from "react-dom";

/** How long an armed control holds before it quietly reverts. Long enough to
 *  read the label change, short enough that a control armed and abandoned
 *  isn't still live as a one-click destructive action minutes later. */
const REVERT_MS = 4000;

/**
 * Shared arm state for every `ConfirmSubmit` inside one scope: at most one
 * control can be armed at a time. Without this, arming REVOKE on one row and
 * then FREEZE in another row's drawer would leave both mid-confirm, and
 * whichever the pointer lands on next would fire on a single click the
 * member never meant as a second one.
 */
const ArmContext = createContext<{
  armedId: string | null;
  arm: (id: string) => void;
  disarm: () => void;
} | null>(null);

/** Wraps one table (or list) of `ConfirmSubmit` controls that should share
 *  the "only one armed at a time" rule. Renders no DOM element of its own, so
 *  it can wrap a `<tbody>` without breaking table structure.
 *
 *  The revert timer lives here rather than in the button because the arm state
 *  does: a timer per button would keep running after the scope handed the arm
 *  to a different row, and disarm whatever was armed by then. */
export function ConfirmArmScope({ children }: { children: ReactNode }) {
  const [armedId, setArmedId] = useState<string | null>(null);

  useEffect(() => {
    if (armedId === null) return;
    const timer = setTimeout(() => setArmedId(null), REVERT_MS);
    return () => clearTimeout(timer);
  }, [armedId]);

  return (
    <ArmContext.Provider
      value={{ armedId, arm: setArmedId, disarm: () => setArmedId(null) }}
    >
      {children}
    </ArmContext.Provider>
  );
}

/**
 * A destructive row action that arms on the first click and only submits the
 * form on the second, rather than firing immediately — too easy to hit by
 * accident scanning a dense table — or interrupting with `window.confirm()`,
 * a banned first reflex here: the whole point of an inline confirm is that it
 * never rips the member out of the page.
 *
 * The armed state has to reach assistive tech, not just sighted users. The
 * visible label swaps to `confirmLabel` ("confirm"), which already changes
 * the control's accessible name the same way `Submit`'s `pendingLabel`
 * already changes it for "saving…" — no separate live region needed, that
 * convention is established elsewhere in this codebase. `confirmName` layers
 * `aria-label` on top purely for a member who tabs away mid-arm and back:
 * the bare word "confirm" announces a verb with no object, so the armed
 * state's accessible name spells out what it will do. It still starts with
 * the visible word ("confirm …"), which is what keeps it a WCAG 2.5.3
 * label-in-name match rather than a mismatched name.
 *
 * `restName` does the same job for the rest state, and for the same reason the
 * plain `Submit` controls in the accounts drawer carry one: on a row-per-account
 * table the bare word "freeze" names the verb but not the account, and a
 * speech-input or screen-reader admin reaching it out of visual context is
 * exactly who derole-don't-boot is protecting. Omitted where the visible label
 * already carries its object.
 *
 * `armedClassName` lets a caller upgrade the visual grade only once armed
 * (e.g. FREEZE and UNLINK go to full `.btn--danger` red only on confirm,
 * never at rest) while REVOKE, which is already `.btn--danger` at rest, can
 * omit it and keep the same class in both states — its rest colour and grade
 * are not supposed to change at all.
 *
 * Width is reserved up front for the wider of the two labels, in `ch` since
 * this is the monospace face throughout: the swap must not change the
 * button's own width and reflow the row it sits in.
 */
export function ConfirmSubmit({
  className,
  armedClassName,
  label,
  confirmLabel = "confirm",
  restName,
  confirmName,
  pendingLabel,
}: {
  className: string;
  /** Classes to use only while armed; defaults to `className` when the rest
   *  and armed states share the same grade (REVOKE). */
  armedClassName?: string;
  label: string;
  confirmLabel?: string;
  /** The rest state's accessible name, e.g. "freeze Zed". Must start with the
   *  visible label (WCAG 2.5.3). Omit to leave the visible label as the name. */
  restName?: string;
  /** The armed state's accessible name, e.g. "confirm revoke admin for Zed". */
  confirmName: string;
  pendingLabel?: ReactNode;
}) {
  const ctx = useContext(ArmContext);
  if (!ctx) {
    throw new Error("ConfirmSubmit must be rendered inside a ConfirmArmScope");
  }
  const id = useId();
  const armed = ctx.armedId === id;
  const { pending } = useFormStatus();
  // +4 for the letter-spacing the monospace label carries across every
  // character, which `ch` alone (sized off the "0" glyph) undercounts; a
  // smaller buffer measured short by several px in practice.
  const widthCh = Math.max(label.length, confirmLabel.length) + 4;

  return (
    <button
      type="submit"
      className={armed ? (armedClassName ?? className) : className}
      style={{ minWidth: `${widthCh}ch` }}
      disabled={pending}
      aria-busy={pending}
      aria-label={armed ? confirmName : restName}
      onClick={(e) => {
        if (!armed) {
          // The first click arms rather than fires: never let it reach the
          // server.
          e.preventDefault();
          ctx.arm(id);
        } else {
          // Let the click proceed as an ordinary submit. Disarming here is
          // just tidy-up for the (rare) case the action doesn't navigate or
          // revalidate this control away.
          ctx.disarm();
        }
      }}
      onBlur={() => {
        // Tabbing or clicking away is as clear a "not that one" as Escape, and
        // it means an armed control never outlives the member's attention on
        // it. Guarded on `armed` so a blur from a different row's button can't
        // disarm whatever the scope handed the arm to next.
        if (armed) ctx.disarm();
      }}
      onKeyDown={(e) => {
        // A member who armed the wrong row must not have to reload to get out
        // of it.
        if (armed && e.key === "Escape") {
          e.preventDefault();
          ctx.disarm();
        }
      }}
    >
      {pending && pendingLabel ? pendingLabel : armed ? confirmLabel : label}
    </button>
  );
}

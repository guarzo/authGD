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
import { Submit } from "@/app/_components/submit";
import { ConfirmSubmit } from "@/app/_components/confirm-submit";
import { copyAmountId } from "./pay-flow-ids";

/** One owed participant, as the roster currently stands on the server. Excluded
 *  participants are never in this list, so they cannot become a focus target. */
export type PayRow = {
  id: string;
  displayName: string;
  /** Pre-formatted on the server (`fmtIsk`), so this file never re-implements
   *  money formatting. Spoken aloud, never rendered. */
  amountLabel: string;
  state: "paid" | "unpaid";
};

type Pending = { id: string; kind: "pay" | "revert" };

const PayFlowContext = createContext<{
  dispatch: (id: string, kind: "pay" | "revert") => void;
} | null>(null);

function usePayFlow(): { dispatch: (id: string, kind: "pay" | "revert") => void } {
  const ctx = useContext(PayFlowContext);
  if (!ctx) throw new Error("MarkPaidForm/RevertForm must be inside a PayFlow");
  return ctx;
}

/**
 * Keeps the operator's place while they pay a roster one transfer at a time.
 *
 * Hosted ABOVE the table rather than in a row, and that placement is the whole
 * design. `mark paid` renders only while a row is unpaid and `revert` only
 * while it is paid (`page.tsx:871`, `page.tsx:884`), so *both* controls unmount
 * themselves on success — which is exactly why focus falls to `<body>` today.
 * A focus effect hosted in either button would race its own unmount.
 * `InlineEdit` can use `useActionState` for this precisely because it never
 * unmounts across its own call (`inline-edit.tsx:14-16`); that pattern does not
 * transfer here.
 *
 * So the effect lives here, where it survives every payment, and it is driven
 * by `rows` — SERVER-RENDERED state — rather than by the action promise. That
 * is also the safety property: the live region can only say "Paid Alice Pilot"
 * on a render where the server says Alice is paid. A failed action throws to
 * error.tsx and this component unmounts with `pending` still set, announcing
 * nothing. There is no path where the region claims a payment that did not
 * land, which is why `useOptimistic` was rejected for a money ledger.
 *
 * The live region is a sibling AFTER `children`, always mounted and never
 * conditionally rendered: a region that appears already holding its text is the
 * shape assistive tech most often misses.
 *
 * It carries an `id` because it is not the only `role="status"` on this page —
 * every copy button renders one (`copy-amount-button.tsx:88`) and so does every
 * `ConfirmSubmit` (`confirm-submit.tsx:261`), so on a twelve-row roster there
 * are two dozen. The id is what lets a test address this one specifically; it
 * is not read by anything at runtime.
 */
export function PayFlow({
  rows,
  headingId,
  children,
}: {
  rows: PayRow[];
  /** Id of the "Split / Roster" heading, focused when the last owed
   *  participant is paid and there is no next row to move to. */
  headingId: string;
  children: ReactNode;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear-then-set, so two announcements with identical text are both read: a
  // live region whose content does not change is not re-announced. Same reason
  // and same shape as `copy-amount-button.tsx`.
  const announce = useCallback((text: string) => {
    setMessage("");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(text), 0);
  }, []);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const dispatch = useCallback(
    (id: string, kind: "pay" | "revert") => {
      const row = rows.find((r) => r.id === id);
      // Only arm the watch if this render already shows the row in the
      // pre-state. That rules out the case where the operator can SEE the row
      // is paid and clicks anyway (a double-press, a back-button render):
      // without it the effect is satisfied on the very next render and
      // announces a payment this click did not cause.
      //
      // It does NOT rule out a genuinely stale tab. If these props say
      // "unpaid" because another operator paid the row after this render,
      // `recordPayment` returns early (`payouts.ts:818`), `markPaidAction`
      // revalidates regardless (`actions.ts:609`), and the effect sees "paid"
      // and says "Paid X" for a transfer this operator never made. The *state*
      // is true — X is paid, the ledger and audit log are correct — but the
      // attribution is not. Closing that would take a return value from the
      // action saying whether this call was the one that wrote, which is a
      // service-layer change this pass deliberately does not make.
      if (!row || row.state !== (kind === "pay" ? "unpaid" : "paid")) return;
      setPending({ id, kind });
    },
    [rows],
  );

  useEffect(() => {
    if (!pending) return;
    const row = rows.find((r) => r.id === pending.id);
    // Gone from the roster entirely (removed in another tab): nothing to say.
    if (!row) {
      setPending(null);
      return;
    }
    const settled = row.state === (pending.kind === "pay" ? "paid" : "unpaid");
    if (!settled) return;
    setPending(null);

    const paid = rows.filter((r) => r.state === "paid").length;
    if (pending.kind === "revert") {
      announce(`Reverted ${row.displayName}. ${paid} of ${rows.length} paid.`);
      document.getElementById(copyAmountId(row.id))?.focus();
      return;
    }
    const next = rows.find((r) => r.state === "unpaid");
    if (next) {
      announce(
        `Paid ${row.displayName}. ${paid} of ${rows.length} paid. ` +
          `Next: ${next.displayName}, ${next.amountLabel}.`,
      );
      document.getElementById(copyAmountId(next.id))?.focus();
    } else {
      announce(`Paid ${row.displayName}. All ${rows.length} paid.`);
      document.getElementById(headingId)?.focus();
    }
  }, [rows, pending, headingId, announce]);

  return (
    <PayFlowContext.Provider value={{ dispatch }}>
      {children}
      <span id="pay-flow-status" role="status" className="visually-hidden">
        {message}
      </span>
    </PayFlowContext.Provider>
  );
}

/**
 * The per-row `mark paid` control, unchanged in label, grade and accessible
 * name — this wrapper exists only to tell `PayFlow` a payment was requested.
 *
 * The dispatch hangs off the form's `onSubmit`, NEVER the button's `onClick`.
 * `ConfirmSubmit`'s first click arms and calls `preventDefault()` so it never
 * reaches the server (`confirm-submit.tsx:220-226`), and the operator can still
 * back out by blurring, pressing Escape, or moving the pointer away
 * (`confirm-submit.tsx:234-257`). Dispatching on click would arm the watch for
 * a payment that was never requested. `onSubmit` fires only on the press that
 * actually submits, which is correct for both the armed and plain grades.
 */
export function MarkPaidForm({
  action,
  participantId,
  displayName,
  arm,
  describedBy,
}: {
  action: () => Promise<void>;
  participantId: string;
  displayName: string;
  /** True only for the FIRST payment on the operation, which is the one that
   *  freezes it permanently. Mirrors `firstPayment` in `page.tsx:201`. */
  arm: boolean;
  describedBy?: string;
}) {
  const { dispatch } = usePayFlow();
  return (
    <form action={action} onSubmit={() => dispatch(participantId, "pay")}>
      {arm ? (
        <ConfirmSubmit
          className="btn btn--micro"
          label="mark paid"
          restName={`mark paid ${displayName}`}
          confirmName={`confirm mark paid ${displayName}`}
          describedBy={describedBy}
        />
      ) : (
        <Submit className="btn btn--micro" aria-label={`mark paid ${displayName}`}>
          mark paid
        </Submit>
      )}
    </form>
  );
}

/** The per-row `revert` control. Same wrapper, same reasoning: revert unmounts
 *  itself too, because it renders only while the row is paid. */
export function RevertForm({
  action,
  participantId,
  displayName,
}: {
  action: () => Promise<void>;
  participantId: string;
  displayName: string;
}) {
  const { dispatch } = usePayFlow();
  return (
    <form action={action} onSubmit={() => dispatch(participantId, "revert")}>
      <ConfirmSubmit
        className="btn btn--quiet btn--micro btn--danger-quiet"
        armedClassName="btn btn--micro btn--danger"
        label="revert"
        restName={`revert payment for ${displayName}`}
        confirmName={`confirm revert payment for ${displayName}`}
      />
    </form>
  );
}

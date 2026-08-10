"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ConfirmSubmit } from "@/app/_components/confirm-submit";
import { copyAmountId, removeParticipantFormId } from "./pay-flow-ids";

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

/** Every participant currently on the roster, in table order — unlike
 *  `PayRow`/`rows`, this is NOT filtered to owed participants: `remove` is
 *  reachable on an excluded row too, so an excluded participant must still be
 *  a valid next-focus target. Used only by the `remove` half of this file;
 *  `pay`/`revert` keep using `rows`, which is the correct, narrower list for
 *  them. */
export type RosterRow = { id: string; displayName: string };

type Pending =
  | { id: string; kind: "pay" | "revert" }
  | { id: string; kind: "remove"; nextId: string | null; removedName: string };

const PayFlowContext = createContext<{
  dispatch: (id: string, kind: "pay" | "revert" | "remove") => void;
} | null>(null);

function usePayFlow(): {
  dispatch: (id: string, kind: "pay" | "revert" | "remove") => void;
} {
  const ctx = useContext(PayFlowContext);
  if (!ctx) {
    throw new Error(
      "MarkPaidForm/RevertForm/RemoveParticipantForm must be inside a PayFlow",
    );
  }
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
 * `ConfirmSubmit` (`confirm-submit.tsx:364`), so on a twelve-row roster there
 * are two dozen. The id is what lets a test address this one specifically; it
 * is not read by anything at runtime.
 */
export function PayFlow({
  rows,
  allParticipants,
  headingId,
  children,
}: {
  rows: PayRow[];
  /** The FULL roster in table order, for `remove` only — see `RosterRow`'s
   *  own comment for why this has to be a second list rather than reusing
   *  `rows`. */
  allParticipants: RosterRow[];
  /** Id of the "Split / Roster" heading, focused when the last owed
   *  participant is paid, or the last participant removed, and there is no
   *  next row to move to. */
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
    (id: string, kind: "pay" | "revert" | "remove") => {
      if (kind === "remove") {
        const idx = allParticipants.findIndex((p) => p.id === id);
        // Not on this render's roster: a stale click, or another tab already
        // removed it. Nothing to watch for.
        if (idx === -1) return;
        // The next row over — below first, above only once there is no row
        // below — computed NOW, from the pre-removal order, because by the
        // time the effect below sees the removal `allParticipants` has
        // already dropped this entry and lost where it used to sit.
        const next = allParticipants[idx + 1] ?? allParticipants[idx - 1] ?? null;
        setPending({
          id,
          kind,
          nextId: next?.id ?? null,
          removedName: allParticipants[idx].displayName,
        });
        return;
      }
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
    [rows, allParticipants],
  );

  // Split from the `remove` effect below rather than one effect branching on
  // `pending.kind`: this one watches `rows` (owed participants only) and the
  // other watches `allParticipants` (everyone) — folding both into one effect
  // would have to depend on both lists regardless of which kind is pending,
  // rerunning on every roster-shape change for no reason.
  useEffect(() => {
    if (!pending || pending.kind === "remove") return;
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
    // Resume from where the operator just was, not from the top of the roster.
    // `rows.find` alone returns the *first* unpaid row in the operation, which
    // is only the right answer while the operator works strictly top to bottom.
    // The moment one pilot is skipped — offline, disputed, paid out of band —
    // every subsequent payment drags focus and the scroll region back up to
    // that same skipped row, once per remaining row.
    //
    // Wrapping to the top only once nothing is left below: the skipped rows are
    // still owed and the operator still has to reach them, so falling off the
    // end has to come back rather than jump to the heading. `rows.slice(0, from)`
    // stops short of the settled row itself, so a wrap can never land on the
    // row just paid. `from` cannot be -1 — the `!row` guard above already
    // returned if the settled row left the roster.
    const from = rows.findIndex((r) => r.id === pending.id);
    const ahead = rows.slice(from + 1).find((r) => r.state === "unpaid");
    const behind = ahead
      ? undefined
      : rows.slice(0, from).find((r) => r.state === "unpaid");
    const next = ahead ?? behind;
    if (next) {
      announce(
        `Paid ${row.displayName}. ${paid} of ${rows.length} paid. ` +
          // A jump *upward* is the same disorientation this fix is about, so
          // the one case that still moves backwards says so out loud.
          `${behind ? "Back to the first unpaid. " : ""}` +
          `Next: ${next.displayName}, ${next.amountLabel}.`,
      );
      document.getElementById(copyAmountId(next.id))?.focus();
    } else {
      announce(`Paid ${row.displayName}. All ${rows.length} paid.`);
      document.getElementById(headingId)?.focus();
    }
  }, [rows, pending, headingId, announce]);

  // The `remove` half of the same idea: a removed participant's `<tr>`
  // unmounts, same as a paid row's controls do, and nothing else on this
  // route restores focus for it — `ConfirmGroup`'s own unmount-cleanup effect
  // only reaches its two callers, `/admin/accounts` and `/admin/sync` (see
  // `confirm-group.tsx`), and `RemoveParticipantForm` is a bare `<form>` +
  // `ConfirmSubmit`, not a `ConfirmGroup`.
  useEffect(() => {
    if (!pending || pending.kind !== "remove") return;
    const stillThere = allParticipants.some((p) => p.id === pending.id);
    // Not gone yet — a stale click already handled elsewhere, or the effect
    // running ahead of the revalidated render. Wait for the render where the
    // row is actually gone before saying anything, the same safety property
    // the pay/revert effect above holds for a payment.
    if (stillThere) return;
    setPending(null);
    const remaining = allParticipants.length;
    announce(
      `Removed ${pending.removedName}. ${remaining} participant${remaining === 1 ? "" : "s"} remain.`,
    );
    if (pending.nextId && allParticipants.some((p) => p.id === pending.nextId)) {
      document
        .querySelector<HTMLButtonElement>(
          `#${CSS.escape(removeParticipantFormId(pending.nextId))} button`,
        )
        ?.focus();
    } else {
      // Either the removed row had no neighbour to begin with (a one-row
      // roster), or its one neighbour was removed by another tab in the
      // meantime — either way there is nowhere on the table left to land.
      document.getElementById(headingId)?.focus();
    }
  }, [allParticipants, pending, headingId, announce]);

  // `children` arrives as a prop, so React bails out of re-rendering the table
  // when only `message` or `pending` moved — but a fresh context value defeats
  // that bailout for consumers specifically, and every row's control is one.
  // Memoized on `dispatch`, which itself changes only when `rows` does, which
  // is exactly when the rows should re-render anyway.
  const value = useMemo(() => ({ dispatch }), [dispatch]);

  return (
    <PayFlowContext.Provider value={value}>
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
 * An armed `ConfirmSubmit`'s first click arms and calls `preventDefault()` so
 * it never reaches the server (`confirm-submit.tsx:324-330`), and the operator
 * can still back out by blurring, pressing Escape, or moving the pointer away
 * (`confirm-submit.tsx:337-360`). Dispatching on click would arm the watch for
 * a payment that was never requested. `onSubmit` fires only on the press that
 * actually submits, which is correct for both the armed and plain grades.
 *
 * `ConfirmSubmit` renders unconditionally here, with `confirm={arm}` choosing
 * the grade — it used to be a ternary between `ConfirmSubmit` and the plain
 * `Submit` component in this same slot, which is one component type standing
 * in for another at a fixed JSX position. React reconciles by type-at-position,
 * so the render where `arm` flips from true to false (the moment the
 * operation's first payment lands and every other still-unpaid row loses its
 * arm step) unmounted every one of those `ConfirmSubmit`s and mounted a fresh
 * `Submit` in the same spot — replacing the `<button>` DOM node rather than
 * updating it. A press that began on the old node during that swap reached
 * neither button and produced no click at all (#146). One component type in
 * the slot makes the transition an ordinary re-render instead.
 *
 * `describedBy` is passed only while arming: once `arm` is false there is no
 * cost sentence left to point at (`page.tsx:954` stops rendering
 * `#mark-paid-cost` in the same render this flips), and a stale
 * `aria-describedby` would point at nothing.
 *
 * `armedClassName` goes to `.btn--danger` only while `arm` is true, and only
 * once armed — never at rest, and never for a later, already-frozen payment.
 * At rest this stays the same plain grade every other payment ever gets:
 * PRODUCT.md's "nothing reads as punishment" argues against making an
 * ordinary, expected step in running a payout look alarming before the
 * operator has done anything. But the two-click arm-then-confirm shape here
 * is otherwise identical to `delete pool`'s and `remove`'s (below) — plain
 * label swap, no colour — for an act neither of those is: this is the one
 * press on the whole route that cannot be undone by any control on it, not
 * even Unlock. DESIGN.md reserves `--signal-bad` for exactly that, and
 * reserves it *narrowly*, so the danger grade is spent only on the single
 * click that actually commits — the confirm, not the arm.
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
   *  freezes it permanently. Mirrors `firstPayment` in `page.tsx:206`. */
  arm: boolean;
  describedBy?: string;
}) {
  const { dispatch } = usePayFlow();
  return (
    <form action={action} onSubmit={() => dispatch(participantId, "pay")}>
      <ConfirmSubmit
        className="btn btn--micro"
        armedClassName={arm ? "btn btn--micro btn--danger" : undefined}
        label="mark paid"
        restName={`mark paid ${displayName}`}
        confirmName={`confirm mark paid ${displayName}`}
        describedBy={arm ? describedBy : undefined}
        confirm={arm}
        // The in-flight state, said on the control rather than nowhere. These
        // actions end in `revalidateOperation` and do not redirect, so a press
        // moves nothing on screen until the server answers — and
        // `useSubmitGuard` silently refuses every press in that window. With no
        // `ConfirmGroup` on this route there is no channel for the refusal
        // (`useConfirmReport()` is null here), so the label is the whole of the
        // feedback: it changes on the press that worked, which is what stops
        // the operator making the press that gets swallowed.
        pendingLabel="paying…"
      />
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
        pendingLabel="reverting…"
      />
    </form>
  );
}

/**
 * The per-row `remove` control, unchanged in label, grade and accessible
 * name — this wrapper's only job is telling `PayFlow` a removal was
 * requested, the same division of labour `MarkPaidForm`/`RevertForm` already
 * use. `remove` renders only in draft (`canEdit`, `page.tsx:902`), never
 * alongside `mark paid`/`revert` (finalized-only, `page.tsx:850`), but it
 * lives inside the same `<PayFlow>` regardless: that component wraps the
 * whole roster table, not just its finalized-only controls, and `remove`
 * needs the identical "focus didn't fall to the top of the document" fix.
 *
 * Carries a stable `id` on the `<form>` itself (`removeParticipantFormId`),
 * queried by `PayFlow`'s effect to reach the next row's button. `ConfirmSubmit`
 * does not accept an `id` prop — it is a shared component
 * (`src/app/_components/confirm-submit.tsx`) out of this route's scope to
 * extend — so the id lands one element up, on the form this route already
 * owns, and the effect finds the button inside it with a plain selector.
 */
export function RemoveParticipantForm({
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
    <form
      id={removeParticipantFormId(participantId)}
      action={action}
      onSubmit={() => dispatch(participantId, "remove")}
    >
      <ConfirmSubmit
        className="btn btn--quiet btn--micro btn--danger-quiet"
        label="remove"
        restName={`remove ${displayName}`}
        confirmName={`confirm remove ${displayName}`}
        pendingLabel="removing…"
      />
    </form>
  );
}

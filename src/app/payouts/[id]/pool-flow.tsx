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
import { deletePoolFormId } from "./pay-flow-ids";

type Pending = { id: string; nextId: string | null; removedNumber: number };

const PoolFlowContext = createContext<{ dispatch: (id: string) => void } | null>(null);

function usePoolFlow(): { dispatch: (id: string) => void } {
  const ctx = useContext(PoolFlowContext);
  if (!ctx) throw new Error("DeletePoolForm must be inside a PoolFlow");
  return ctx;
}

/**
 * `PayFlow`'s (`pay-flow.tsx`) fix, for the Loot pools table: deleting a pool
 * unmounts its own `<tr>`, and nothing here restores focus for it on its
 * own — `ConfirmGroup`'s unmount-cleanup effect only reaches its two callers,
 * `/admin/accounts` and `/admin/sync` (see `confirm-group.tsx`), and this
 * table is a bare `<form>` + `ConfirmSubmit`, not a `ConfirmGroup`.
 *
 * A separate component rather than folding this into `PayFlow`: pools and
 * participants are different lists with different keys, rendered in a
 * different section of the page, and `PayFlow` does not wrap the pools table
 * at all — the pools table (`page.tsx`'s Loot section) renders and closes
 * well before `<PayFlow>` opens around the roster further down the page.
 * Sharing one provider across both would mean either list re-rendering the
 * other's consumers on every change, for no reason.
 */
export function PoolFlow({
  order,
  headingId,
  children,
}: {
  /** Every pool's id and 1-based position, in table order — the CURRENT
   *  server render, same reasoning as `PayFlow`'s `rows`: this has to be
   *  server-rendered state, not a client mirror, so focus only moves once
   *  the server confirms the row is actually gone. */
  order: { id: string; number: number }[];
  /** The "Loot" heading, focused when the deleted pool was the last one. */
  headingId: string;
  children: ReactNode;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear-then-set, so two announcements with identical text are both read —
  // same reasoning and shape as `PayFlow`'s `announce`.
  const announce = useCallback((text: string) => {
    setMessage("");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(text), 0);
  }, []);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const dispatch = useCallback(
    (id: string) => {
      const idx = order.findIndex((o) => o.id === id);
      // Not on this render's table: a stale click, or another tab already
      // deleted it.
      if (idx === -1) return;
      // The next pool over — below first, above only once there is no pool
      // below — computed NOW, from the pre-delete order: by the time the
      // effect below sees the deletion, `order` has already dropped this
      // entry and lost where it used to sit.
      const next = order[idx + 1] ?? order[idx - 1] ?? null;
      setPending({ id, nextId: next?.id ?? null, removedNumber: order[idx].number });
    },
    [order],
  );

  useEffect(() => {
    if (!pending) return;
    const stillThere = order.some((o) => o.id === pending.id);
    // Not gone yet — wait for the render where the row is actually deleted
    // before saying anything, the same safety property `PayFlow` holds for a
    // payment.
    if (stillThere) return;
    setPending(null);
    const remaining = order.length;
    announce(
      `Removed pool ${pending.removedNumber}. ${remaining} pool${remaining === 1 ? "" : "s"} remain.`,
    );
    if (pending.nextId && order.some((o) => o.id === pending.nextId)) {
      document
        .querySelector<HTMLButtonElement>(
          `#${CSS.escape(deletePoolFormId(pending.nextId))} button`,
        )
        ?.focus();
    } else {
      // Either the deleted pool had no neighbour to begin with (the only
      // pool), or its one neighbour was deleted by another tab in the
      // meantime — either way there is nowhere on the table left to land.
      document.getElementById(headingId)?.focus();
    }
  }, [order, pending, headingId, announce]);

  // Same bailout-defeating reason `PayFlow` memoizes its own context value:
  // `children` is a prop, so a fresh object here would force every consumer
  // to re-render on every keystroke this component never causes.
  const value = useMemo(() => ({ dispatch }), [dispatch]);

  return (
    <PoolFlowContext.Provider value={value}>
      {children}
      <span id="pool-flow-status" role="status" className="visually-hidden">
        {message}
      </span>
    </PoolFlowContext.Provider>
  );
}

/**
 * The per-pool `delete` control. Same division of labour as `MarkPaidForm`/
 * `RevertForm`/`RemoveParticipantForm` (`pay-flow.tsx`): this wrapper's only
 * job is telling `PoolFlow` a deletion was requested, on the form's
 * `onSubmit` rather than the button's `onClick`, for the identical reason —
 * an armed `ConfirmSubmit`'s first click never reaches the server.
 *
 * Carries a stable `id` on the `<form>` itself (`deletePoolFormId`), queried
 * by `PoolFlow`'s effect to reach the next pool's button — `ConfirmSubmit`
 * does not accept an `id` prop and is out of this route's scope to extend.
 */
export function DeletePoolForm({
  action,
  poolId,
  poolNumber,
}: {
  action: () => Promise<void>;
  poolId: string;
  poolNumber: number;
}) {
  const { dispatch } = usePoolFlow();
  return (
    <form id={deletePoolFormId(poolId)} action={action} onSubmit={() => dispatch(poolId)}>
      <ConfirmSubmit
        className="btn btn--quiet btn--micro btn--danger-quiet"
        armedClassName="btn btn--micro btn--danger"
        label="delete"
        restName={`delete pool ${poolNumber}`}
        confirmName={`confirm delete pool ${poolNumber}`}
        pendingLabel="deleting…"
      />
    </form>
  );
}

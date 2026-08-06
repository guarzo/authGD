"use client";

import {
  createContext,
  useActionState,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Notice } from "@/app/_components/ui";

/**
 * The no-redirect twin of `ConfirmNotice` (`_components/confirm-notice.tsx`),
 * for a server action whose control lives INSIDE a `Disclosure` that holds its
 * open/closed state in a plain `useState` (`_components/disclosure.tsx`) —
 * `/admin/accounts`'s per-row drawer (`as="row"`) and `/admin/sync`'s per-job
 * drawer (`as="details"`) both qualify, and both use this rather than a
 * parallel copy.
 *
 * `ConfirmNotice`'s own docblock says a soft navigation "reconciles this
 * component in place rather than remounting it" — true for `/account` and for
 * two of `/admin/sync`'s three enqueue actions (`syncAllAction`,
 * `recheckInvalidAction`, whose controls sit outside any `Disclosure`), false
 * for a control inside one: a `redirect()` — even back to the same route,
 * even carrying nothing but a confirmation in the query string — replaces the
 * whole route tree on navigation and resets every `Disclosure`'s `useState`
 * along with it. Two separate e2e runs proved it on two separate pages:
 * pressing a tier button used to close `/admin/accounts`'s own row drawer on
 * the first press (`setTierAction` originally ended in
 * `redirect(doneUrl(...))`), and pressing a job's "Re-run" button used to
 * collapse `/admin/sync`'s own job drawer (`syncJobAction` originally ended in
 * `redirect(\`/admin/sync?queued=...\`)`) — the identical failure, once per
 * page, because each page's fix started from `ConfirmNotice`'s assumption
 * before either had a `Disclosure` in the way. Originally
 * `admin/accounts/confirm-group.tsx`; moved here once `/admin/sync` needed the
 * identical shape rather than a parallel copy — the accounts-specific
 * reasoning above generalizes to any drawer-scoped action, and the two
 * remaining accounts-only comments describing that page's own nine actions
 * still live in `admin/accounts/actions.ts` and `admin/accounts/view.ts`.
 *
 * `ConfirmingForm` is the per-button half: it wraps one `<form>` in
 * `useActionState` (same shape `note-form.tsx` and `inline-edit-field.tsx`
 * already use for an action that must not navigate) and reports the result up
 * to the nearest `ConfirmGroup` instead of rendering its own notice. A press
 * never redirects, so `revalidatePath` alone refreshes the data and the
 * drawer's own `useState` is simply never touched.
 *
 * `ConfirmGroup` is the shared landing spot: one `Notice` per drawer group,
 * not one per button — `/admin/accounts` groups its mutually-exclusive tier
 * buttons (and the two approve buttons that replace them on a pending row)
 * under one group the same way `/account`'s single `accountConfirmation`
 * sentence covers several distinct actions rather than repeating a notice per
 * control; `/admin/sync` has exactly one button per job drawer, so its group
 * holds one. A per-button `Notice` would also each need its own box to grow
 * for its text, changing that button's size in a context (a `<td>` collapsed
 * to `1%`, on `/admin/accounts`) where every row shares the column's width.
 *
 * Unlike `ConfirmNotice`, there is no `at` to depend on: `useActionState`
 * hands back a brand-new state object on every action call regardless of
 * whether the text it carries repeats, so `[state]` alone (object identity,
 * not content) already re-fires the effect on every press — the same
 * distinction `inline-edit-field.tsx`'s own docblock draws between depending
 * on `state` and depending on a derived boolean.
 */
const ReportContext = createContext<((text: string) => void) | null>(null);

export function ConfirmGroup({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  // A counter, not a boolean: two presses in the group can carry the same
  // sentence (setting a tier back to what a lost race already set it to), and
  // an effect keyed on the sentence alone would not re-fire the second time —
  // same class of bug `saveNoteAction`'s monotonic counter exists to avoid.
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    if (seq > 0) ref.current?.focus();
  }, [seq]);

  return (
    <ReportContext.Provider
      value={(nextText) => {
        setText(nextText);
        setSeq((s) => s + 1);
      }}
    >
      {children}
      {/* No focus ring: same reasoning as `ConfirmNotice` — the global ring is
          `:focus-visible`, which a programmatic focus on a non-input element
          does not match. */}
      <div ref={ref} tabIndex={-1}>
        <Notice live={false}>{text}</Notice>
      </div>
    </ReportContext.Provider>
  );
}

/** The result a drawer-scoped action threads back through `useActionState` —
 *  `null` for "nothing to confirm" (the initial render, and any action that
 *  wants the same "don't confirm a no-op" rule `admin/accounts/actions.ts`'s
 *  `unlinkDiscordAction` follows on its cell-level, redirect-shaped sibling). */
export type ActionOutcome = { text: string } | null;

export function ConfirmingForm({
  action,
  className,
  children,
}: {
  action: (prevState: ActionOutcome, formData: FormData) => Promise<ActionOutcome>;
  className?: string;
  children: ReactNode;
}) {
  const report = useContext(ReportContext);
  const [state, formAction] = useActionState<ActionOutcome, FormData>(action, null);

  useEffect(() => {
    // `null` covers both "never submitted" (initial state) and the
    // no-confirmation outcomes a drawer action can still return — see
    // `ActionOutcome`'s own doc.
    if (state) report?.(state.text);
  }, [state]);

  return (
    <form action={formAction} className={className}>
      {children}
    </form>
  );
}

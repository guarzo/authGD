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
const ReportContext = createContext<((outcome: Confirmation) => void) | null>(null);

/**
 * The nearest `ConfirmGroup`'s landing spot, or `null` when there is no group
 * above — which is the normal case, since most of this app's submit buttons sit
 * in plain redirecting forms. Exported so a control can report something the
 * server action never sees: `ConfirmSubmit` uses it for a press its own
 * re-entry guard refuses, where there is no action, no response, and therefore
 * nothing for `ConfirmingForm` to forward.
 *
 * Anything reporting through this must be certain something else will overwrite
 * it, or that it is the last word. The group holds one sentence until the next
 * press replaces it; a text reported for a transient condition and never
 * superseded would sit there claiming to describe the drawer's current state.
 */
export function useConfirmReport() {
  return useContext(ReportContext);
}

export function ConfirmGroup({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const [tone, setTone] = useState<"warn" | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  // A counter, not a boolean: two presses in the group can carry the same
  // sentence (setting a tier back to what a lost race already set it to), and
  // an effect keyed on the sentence alone would not re-fire the second time —
  // same class of bug `saveNoteAction`'s monotonic counter exists to avoid.
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    if (seq > 0) ref.current?.focus();
  }, [seq]);

  // Approve, set-tier and set-status all move a row out of whatever `tier=`
  // or `status=` filter is currently applied — that is what `revalidatePath`
  // is for — and `Disclosure`'s `as="row"` (disclosure.tsx) renders this
  // group's own toggle row AND drawer row from the same `.map()` entry as the
  // account, so the row this notice landed focus on above can vanish in the
  // very next paint. Left alone, the browser drops focus to `<body>` with no
  // trace of where the admin was, which is the concrete cost item 9 (this
  // pass's brief) describes on a twenty-row roster.
  //
  // This cleanup is the fix. A cleanup function fires synchronously as part
  // of the unmount, before React detaches the DOM, so — unlike a `focusout`
  // listener racing the removal — it can hand focus off before `ref.current`
  // stops existing rather than reacting after `<body>` already has it. It
  // only acts when this group's own notice is what currently holds focus:
  // an admin who has since moved on (tabbed to another row, opened a
  // different drawer) is not this effect's business.
  //
  // The fallback is the enclosing `<table>`, not a specific row: that is the
  // one ancestor guaranteed to survive a single row leaving the list. Of the
  // two callers today it is `/admin/accounts` that has one; `/admin/sync`'s
  // group sits in a drawer strip below the runs table rather than in a row
  // (`admin/sync/page.tsx:802`), where `closest` finds nothing and this
  // cleanup correctly does nothing — that surface's control does not unmount
  // on its own press. It is not "land on row 15" — this
  // component has no way to know which row comes next, only `PayFlow`
  // (`payouts/[id]/pay-flow.tsx`) does, because it is hosted above the whole
  // list and reads server-rendered `rows` to find one. What this buys back is
  // the smaller claim: the admin lands at the top of the table they were
  // already scanning, not at the top of the document.
  useEffect(() => {
    const node = ref.current;
    return () => {
      if (!node || document.activeElement !== node) return;
      const table = node.closest("table");
      if (!table) return;
      if (!table.hasAttribute("tabindex")) table.setAttribute("tabindex", "-1");
      table.focus();
    };
  }, []);

  return (
    <ReportContext.Provider
      value={({ text: nextText, tone: nextTone }) => {
        setText(nextText);
        setTone(nextTone);
        setSeq((s) => s + 1);
      }}
    >
      {children}
      {/* No focus ring: same reasoning as `ConfirmNotice` — the global ring is
          `:focus-visible`, which a programmatic focus on a non-input element
          does not match. */}
      <div ref={ref} tabIndex={-1}>
        {/* `live={false}` for the warn outcome too, not just the successes.
            Conditioning it on tone was tried and is wrong: `live` is what puts
            the `role` on the element at all (`ui.tsx`), so a `live={tone ===
            "warn"}` region gains its role and its text in the same commit —
            "a region born holding text", which that file documents as the one
            shape AT does not reliably announce. Registering the region
            unconditionally instead would announce every success twice, which
            is the thing `live={false}` is here to prevent. Both branches of
            the warn case are already covered without it: the focus move two
            lines up carries the sentence to AT, on the same press, by the
            same mechanism every success uses, and `tone` carries it visually
            (`.notice--warn`, `!` glyph) for everyone else. */}
        <Notice tone={tone} live={false}>
          {text}
        </Notice>
      </div>
    </ReportContext.Provider>
  );
}

/** The result a drawer-scoped action threads back through `useActionState`.
 *  `null` is the initial state only: every action returning this type now
 *  ends in an object. It used to also mean "nothing to confirm" — the
 *  "don't confirm a no-op" rule — but `admin/accounts/actions.ts`'s
 *  `unlinkDiscordAction` was the sole producer of that `null` and now returns
 *  a `warn` instead. `/account`'s separate `unlinkDiscordAction` still keeps
 *  the no-op rule, by a different mechanism and not this type: its control is
 *  not in a drawer, so it stays a `redirect()`-shaped `Promise<void>` and
 *  expresses the no-op by redirecting without a `?done=` code at all.
 *
 *  `tone` is optional and defaults to the untoned success rendering
 *  (`Notice`'s own `tone="info"` default) — every other action omits it.
 *  `unlinkDiscordAction` is the one *action* that sets `tone: "warn"`, for the
 *  lost `not_linked` race: ruling R2's drawer control means the admin is
 *  looking at a row that still claims to be linked, so this is the one
 *  outcome here that corrects an assumption rather than confirming an act.
 *  `ConfirmSubmit` reports a second warn that no action produces, for a press
 *  its re-entry guard refused — see `useConfirmReport` above. */
export type ActionOutcome = { text: string; tone?: "warn" } | null;

/** The non-initial half of `ActionOutcome`: what a press actually reports.
 *  `ReportContext` carries this whole object rather than restating its fields
 *  positionally, so a field added above forces a decision inside
 *  `ConfirmGroup` instead of being silently dropped in transit. */
export type Confirmation = NonNullable<ActionOutcome>;

export function ConfirmingForm({
  action,
  className,
  children,
}: {
  action: (prevState: ActionOutcome, formData: FormData) => Promise<ActionOutcome>;
  className?: string;
  children: ReactNode;
}) {
  const report = useConfirmReport();
  const [state, formAction] = useActionState<ActionOutcome, FormData>(action, null);

  useEffect(() => {
    // `null` is the initial state and nothing else — see `ActionOutcome`'s
    // own doc. Forwarded whole rather than field by field, so this line does
    // not need editing when the outcome grows.
    if (state) report?.(state);
  }, [state]);

  return (
    <form action={formAction} className={className}>
      {children}
    </form>
  );
}

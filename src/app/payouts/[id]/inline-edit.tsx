"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { Submit } from "@/app/_components/submit";
import { OPERATION_ERRORS, lookupErrorMessage } from "../errors";
import type { StringFieldEditState } from "../actions";

/**
 * One value, editable in place, saved with no navigation.
 *
 * Renders the stored value as text with an "edit" trigger. Activating swaps
 * to a field and a save/cancel pair; committing calls the same server action
 * every other control on this page already calls (`setNameAction`,
 * `setItemPriceAction`, `setParticipantSharesAction`, ...).
 *
 * Every such action returns `StringFieldEditState` rather than redirecting.
 * That is a change from this component's first shape, which took a
 * `Promise<void>` action and documented the invariant "every action passed to
 * InlineEdit rejects by redirecting, never by returning state", with the note
 * that if that ever changed the value should be controlled here rather than
 * special-cased. It changed. `operationFailed`'s `?error=` redirect can carry
 * a code but never the value that produced it, so a rejected edit re-rendered
 * from server state and the operator's typed number was gone — on a money
 * screen, at the moment they most needed to see it. The rejection now comes
 * back as state, this component stays mounted, and the field the operator
 * typed into is still the same DOM node holding the same text.
 *
 * `defaultValue` is therefore not a liability here the way it was in
 * `AppraiseForm`: nothing unmounts and nothing remounts, so the browser's own
 * dirty value is what stays on screen. It is still set to the rejected value
 * rather than the stored one, so a remount for any reason lands on what was
 * typed rather than silently reverting to the database.
 *
 * `type` is forced to `"text"` while rejected, whatever the caller asked for.
 * `type="number"` (unit price, shares, corp share) and `type="date"`
 * (operation date) are platform inputs that refuse to hold a string their own
 * type cannot parse: assigning `"12,5"` to a number input is not re-formatted
 * but silently discarded to `""` by the browser, however the assignment
 * arrives. A malformed reject is reachable via a scripted client or a paste
 * (see `bypassClientGuard` in `e2e/payouts.spec.ts`) and is exactly the value
 * worth showing back the most.
 *
 * `useActionState` also carries the success path: it is the one way to know
 * the save landed, which is what lets editing mode close itself, announce
 * "saved" into a live region, and hand focus back to the trigger without a
 * full round trip through the query string.
 *
 * Keyboard: Enter commits (the browser's native single-line submit-on-Enter;
 * textarea fields need the explicit Save button since Enter there means a
 * newline). Escape reverts to the stored value and returns focus to the
 * trigger, discarding whatever was typed.
 */
export function InlineEdit({
  action,
  fieldName,
  value,
  displayValue,
  label,
  type = "text",
  as = "input",
  mono = false,
  fieldClassName = "field",
  required = true,
  min,
  max,
  step,
  rows,
  standalone = true,
  prominentTrigger = false,
}: {
  /** The server action, already bound to whatever ids it needs
   *  (`setItemPriceAction.bind(null, operationId, item.id)`). */
  action: (
    prevState: StringFieldEditState,
    formData: FormData,
  ) => Promise<StringFieldEditState>;
  /** The form field name the action reads with `field(formData, name)`. */
  fieldName: string;
  /** The stored value. Used as the field's content every time editing
   *  (re)opens, so a cancelled edit always reverts to what the server holds,
   *  never to a previous draft. */
  value: string;
  /** What to show in view mode. Defaults to `value`. */
  displayValue?: ReactNode;
  /** Accessible name for the value and its trigger/save/cancel controls,
   *  e.g. "operation name" or "shares for Alice Pilot". Lower case, no
   *  trailing punctuation — it is composed into "edit …", "save …". */
  label: string;
  type?: "text" | "date" | "number" | "url";
  as?: "input" | "textarea";
  mono?: boolean;
  fieldClassName?: string;
  required?: boolean;
  min?: string;
  max?: string;
  step?: string;
  rows?: number;
  /** Defaults to true: DESIGN.md's 36px hit-target floor applies to a
   *  standalone control, and every use of this component in the page head
   *  and the facts/details grids (name, date, corp share, notes, battle
   *  report) is exactly that. Per-item unit price and per-participant shares
   *  set this false — they sit in a dense table row, the one context
   *  DESIGN.md carves out the smaller 28px grade for. `.inline-edit--standalone`
   *  (globals.css) is what raises the trigger/save/cancel buttons from that
   *  28px `.btn--quiet` floor back to 36px without giving up the quiet
   *  colouring. */
  standalone?: boolean;
  /** Raises the *trigger* out of the quiet grade to a plain `.btn`, filled and
   *  bordered. Defaults to false, and only the two page-head uses set it.
   *
   *  This page has 70 pressable things and 62 of them are the identical 28px
   *  quiet chip, with a single gold button. At that ratio nothing directs the
   *  eye: an operator opening a payout scans a field of interchangeable
   *  `edit` marks and has no way to tell which of them changes the record's
   *  identity from which changes one line item's unit price.
   *
   *  Scoped to the operation's name and date because those two *are* the
   *  record's identity — everything else edits a field of it — and because
   *  they are the only two above the fold. Deliberately not extended to all
   *  five `standalone` uses: promoting five of 62 does not create a focal
   *  point, it creates a second uniform tier, which is the same defect one
   *  notch up.
   *
   *  Costs no CSS and no layout. Bare `.btn` already carries
   *  `min-height: 2.25rem` — the identical box `.inline-edit--standalone
   *  .btn--quiet` buys back — so this changes fill, border and nothing else.
   *  It also adds no second gold: `.btn--primary` stays the page's one
   *  emphasis ration, spent on Finalize. */
  prominentTrigger?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // A rejection lives in `useActionState`, which has no reset — so reopening a
  // closed editor would otherwise re-render last time's error against a field
  // that has since reverted to the stored value. This flag is what scopes the
  // error to the editing session that produced it: set when a rejection
  // arrives, cleared whenever the editor opens or the operator types.
  const [showError, setShowError] = useState(false);
  // The trigger button only exists while `editing` is false, so `triggerRef`
  // is null at the moment a save or a cancel decides focus should go back to
  // it: `setEditing(false)` is batched, the DOM node has not been created yet,
  // and `triggerRef.current?.focus()` is a silent no-op that drops focus to
  // `<body>`. Both paths therefore record the intent here and let the effect
  // below act on it once the trigger is actually mounted.
  const [refocusTrigger, setRefocusTrigger] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [state, formAction] = useActionState<StringFieldEditState, FormData>(
    action,
    null,
  );
  const rejected = showError && state !== null && !state.ok;

  useEffect(() => {
    if (state === null) return;
    if (state.ok) {
      setEditing(false);
      setShowError(false);
      setAnnouncement(`${label} saved`);
      setRefocusTrigger(true);
      const t = setTimeout(() => setAnnouncement(""), 2000);
      return () => clearTimeout(t);
    }
    // Refocus and select on EVERY rejection, not just the first — a second,
    // differently-wrong number is exactly what a retyped value under time
    // pressure produces, and each attempt deserves the same landing spot.
    // `state` is the dependency rather than a derived boolean because object
    // identity is what changes across two consecutive rejections.
    setShowError(true);
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, [state, label]);

  // Runs after the render that brought the trigger back, which is the earliest
  // point `triggerRef` holds a node. Guarded on the flag rather than on
  // `editing` alone so opening and closing the editor by any other route does
  // not steal focus from wherever the operator actually is.
  useEffect(() => {
    if (editing || !refocusTrigger) return;
    triggerRef.current?.focus();
    setRefocusTrigger(false);
  }, [editing, refocusTrigger]);

  function cancel() {
    setEditing(false);
    setShowError(false);
    setRefocusTrigger(true);
  }

  if (!editing) {
    return (
      <span
        className={standalone ? "inline-edit inline-edit--standalone" : "inline-edit"}
      >
        <span className={mono ? "mono" : undefined}>{displayValue ?? value}</span>{" "}
        <button
          type="button"
          ref={triggerRef}
          className={prominentTrigger ? "btn" : "btn btn--quiet btn--micro"}
          onClick={() => {
            setShowError(false);
            setEditing(true);
          }}
          aria-label={`edit ${label}`}
        >
          edit
        </button>
        <span role="status" className="visually-hidden">
          {announcement}
        </span>
      </span>
    );
  }

  const fieldValue = rejected ? state.value : value;
  const commonProps = {
    name: fieldName,
    defaultValue: fieldValue,
    required,
    "aria-label": label,
    "aria-invalid": rejected || undefined,
    autoFocus: true,
    onChange: () => setShowError(false),
  } as const;

  return (
    <form
      action={formAction}
      className={
        standalone
          ? "inline-edit inline-edit--editing inline-edit--standalone inline-form"
          : "inline-edit inline-edit--editing inline-form"
      }
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    >
      {as === "textarea" ? (
        <textarea
          {...commonProps}
          ref={fieldRef}
          className={fieldClassName}
          rows={rows}
        />
      ) : (
        <input
          {...commonProps}
          ref={fieldRef}
          className={mono ? `${fieldClassName} mono` : fieldClassName}
          type={rejected ? "text" : type}
          min={min}
          max={max}
          step={step}
        />
      )}
      <Submit
        className="btn btn--micro"
        aria-label={`save ${label}`}
        pendingLabel="saving…"
      >
        save
      </Submit>
      <button
        type="button"
        className="btn btn--quiet btn--micro"
        onClick={cancel}
        aria-label={`cancel editing ${label}`}
      >
        cancel
      </button>
      {/* A `<span>`, not the shared `Notice`: that renders a `<p>`, and this
          form is mounted inside an `<h1>`, a `<dd>` and a `<td>` depending on
          the call site — phrasing content is the only thing valid in all
          three. `role="alert"` is on the wrapper so it is in the DOM before
          the text arrives; focus lands on the input rather than here, so
          there is no same-node double-announce to guard against. */}
      <span role="alert" className="inline-form__err">
        {rejected ? lookupErrorMessage(OPERATION_ERRORS, state.code) : ""}
      </span>
      <span role="status" className="visually-hidden">
        {announcement}
      </span>
    </form>
  );
}

"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { Submit } from "@/app/_components/submit";

type SaveState = { ok: true; at: number } | null;

/**
 * One value, editable in place, saved with no navigation.
 *
 * Renders the stored value as text with an "edit" trigger. Activating swaps
 * to a field and a save/cancel pair; committing calls the same server action
 * every other control on this page already calls (`setNameAction`,
 * `setItemPriceAction`, `setParticipantSharesAction`, ...) and this component
 * never unmounts across that call, because the action only NAVIGATES on
 * rejection — `operationFailed`'s `?error=` redirect, the conversion every
 * input rejection on `/payouts/[id]` goes through (`../actions.ts`). A
 * successful save just `revalidatePath`s and returns, so there is nothing to
 * lose here on the path that matters; a rejected save still redirects to
 * `?error=<code>` exactly as it did before this component existed, which is
 * why this stays a plain `<form action={action}>` rather than reimplementing
 * validation.
 *
 * `useActionState` earns its keep for the success path only: it is the one
 * way to know the save actually landed, which is what lets editing mode close
 * itself, announce "saved" into a live region, and hand focus back to the
 * trigger without a full round trip through the query string.
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
}: {
  /** The server action, already bound to whatever ids it needs
   *  (`setItemPriceAction.bind(null, operationId, item.id)`). */
  action: (formData: FormData) => Promise<void>;
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
}) {
  const [editing, setEditing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [state, formAction] = useActionState<SaveState, FormData>(
    async (_prev, formData) => {
      await action(formData);
      return { ok: true, at: Date.now() };
    },
    null,
  );

  useEffect(() => {
    if (!state?.ok) return;
    setEditing(false);
    setAnnouncement(`${label} saved`);
    triggerRef.current?.focus();
    const t = setTimeout(() => setAnnouncement(""), 2000);
    return () => clearTimeout(t);
  }, [state, label]);

  function cancel() {
    setEditing(false);
    triggerRef.current?.focus();
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
          className="btn btn--quiet btn--micro"
          onClick={() => setEditing(true)}
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
      {/* `defaultValue`, not a controlled value — and that is safe here only
          because of what every action this component wraps does on rejection.
          React 19 resets an uncontrolled field once a `<form action>` submit
          settles, which is exactly how `AppraiseForm` and the composer lost
          their pastes (both are controlled now for that reason). This one gets
          away with it because no action here ever settles into a rendered
          rejection: a success closes the editor (`setEditing(false)`), and a
          failure goes through `operationFailed`'s `redirect()` in
          `../actions.ts`, which is a hard navigation that remounts this
          component from the server anyway.

          So the invariant is: every action passed to InlineEdit rejects by
          redirecting, never by returning state. An editor added later whose
          action returns `{ ok: false }` would render its rejection in place,
          React would blank the field underneath it, and the operator would
          lose what they typed with nothing to show why. If that day comes,
          control the value here rather than adding a special case. */}
      {as === "textarea" ? (
        <textarea
          className={fieldClassName}
          name={fieldName}
          defaultValue={value}
          required={required}
          rows={rows}
          aria-label={label}
          autoFocus
        />
      ) : (
        <input
          className={mono ? `${fieldClassName} mono` : fieldClassName}
          type={type}
          name={fieldName}
          defaultValue={value}
          required={required}
          min={min}
          max={max}
          step={step}
          aria-label={label}
          autoFocus
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
      <span role="status" className="visually-hidden">
        {announcement}
      </span>
    </form>
  );
}

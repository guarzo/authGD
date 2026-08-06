"use client";

import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useSubmitGuard } from "./submit-guard";

/**
 * Shared arm state for every `ConfirmSubmit` inside one scope: at most one
 * control can be armed at a time. Without this, arming REVOKE on one row and
 * then FREEZE in another row's drawer would leave both mid-confirm, and
 * whichever the pointer lands on next would fire on a single click the
 * member never meant as a second one.
 *
 * `armedDescribedBy` carries the armed control's `describedBy` id alongside its
 * internal `useId`, so a `ConfirmCost` can tell whether the thing that armed is
 * the thing it describes. The two ids answer different questions and neither
 * substitutes for the other: `armedId` is unique per control and decides which
 * button renders armed, while `describedBy` is the id of a separate element and
 * is shared by every control pointing at the same sentence.
 */
const ArmContext = createContext<{
  armedId: string | null;
  armedDescribedBy: string | null;
  arm: (id: string, describedBy?: string) => void;
  disarm: () => void;
} | null>(null);

/** Wraps one table (or list) of `ConfirmSubmit` controls that should share
 *  the "only one armed at a time" rule. Renders no DOM element of its own, so
 *  it can wrap a `<tbody>` without breaking table structure — which is also why
 *  the armed-state announcement lives in the button rather than here.
 *
 *  There is deliberately no revert timer. One used to disarm after 4s, which is
 *  a time limit on a user action with no way to turn it off, extend it or ask
 *  for more (WCAG 2.2.1) — and 4s is short enough that a member reading the
 *  label change with a screen magnifier can lose the arm mid-sentence.
 *  Abandonment is already covered by the three events that actually mean it:
 *  blur, Escape, and the pointer leaving the control. */
export function ConfirmArmScope({ children }: { children: ReactNode }) {
  // One state object rather than two, so the id and the description it points
  // at can never be read half-updated: a render that saw the new armedId beside
  // the previous armedDescribedBy would reveal the wrong row's sentence for a
  // frame.
  const [armed, setArmed] = useState<{ id: string; describedBy: string | null } | null>(
    null,
  );

  return (
    <ArmContext.Provider
      value={{
        armedId: armed?.id ?? null,
        armedDescribedBy: armed?.describedBy ?? null,
        arm: (id, describedBy) => setArmed({ id, describedBy: describedBy ?? null }),
        disarm: () => setArmed(null),
      }}
    >
      {children}
    </ArmContext.Provider>
  );
}

/**
 * What a destructive action costs, shown to sighted users only once that
 * action is armed — unless the call site opts out with `alwaysHidden`, which
 * keeps it `.visually-hidden` permanently instead (see that prop).
 *
 * The cost sentence used to render unconditionally beside the control. That put
 * a permanent explanation of an action almost nobody takes on a page whose job
 * is to let a member confirm state and leave — PRODUCT.md's "state before
 * action", where the member should be able to read the page and go without
 * clicking anything. Arming is the moment the sentence becomes load-bearing, so
 * that is when it appears, for the call sites that reveal at all.
 *
 * It is hidden with `.visually-hidden`, never unmounted, for two reasons. The
 * element is the target of the button's `aria-describedby`, and the whole value
 * of that association is reaching a member who tabs straight to the control:
 * the sentence sits AFTER the button in reading order, so a description that
 * only came into existence on the first press would not be there to be spoken
 * ahead of it. `.visually-hidden` is `position: absolute`, so at rest it is also
 * out of flow and adds no gap to the flex row it sits in. That is true whether
 * or not the call site ever reveals it, which is what makes `alwaysHidden` a
 * change in one boolean rather than a different component.
 *
 * Reveals for its own control only, matched on `describedBy` rather than on
 * "something in this scope is armed". The scope-wide reading is correct in a
 * scope holding one control and silently wrong in every other one: a scope
 * wrapping a whole table body would reveal one row's sentence when a different
 * row armed. Matching on the id means a scope may hold as many controls and as
 * many cost sentences as it likes, and controls that share a sentence (the same
 * `describedBy`) reveal it together, which is what sharing one is for.
 *
 * That makes this component safe to put in a table; it does NOT make revealing
 * on arm a good idea there, and #112 established that empirically before
 * reverting the attempt. Revealing inside a `td` widens the cell, the widening
 * moves the armed button out from under a stationary mouse, `pointerLeave`
 * below fires, and the control disarms itself — the reveal undoes the arm. The
 * admin accounts table therefore keeps its own cost sentence hand-rolled and
 * `.visually-hidden` always (#111) rather than using this component at all.
 *
 * The payout page's Finalize and Unlock controls pass `alwaysHidden` for a
 * different reason, and it is worth not confusing the two: not reflow, but
 * that a sentence appearing under Finalize the moment it arms reads as an
 * error message rather than as a cost. Those two controls are mutually
 * exclusive anyway (`canFinalize` wants a draft, `canRelease` wants a
 * finalized operation), so there is no neighbour to shove; the row simply
 * grows rightward from a fixed left edge and the armed button does not move.
 * The reveal here is a copy decision, not a layout one.
 *
 * The account page's Discord row still reveals, because a `dd` in a `.facts`
 * grid is a place a sentence belongs — but only because `.facts__lead >
 * .confirm-cost` gives the revealed cost `flex-basis: 100%`, which puts it on
 * its own line and leaves the button where it was. That was not true when this
 * comment first called the row safe. The row is a flex line with
 * `align-items: center` and `flex-wrap: wrap`, and between roughly 641px and
 * 851px the revealed sentence fit *beside* the button, grew the line box, and
 * re-centred the button vertically — out from under a stationary pointer,
 * firing `pointerLeave` and disarming the control the member had just armed.
 * The `flex-basis: 100%` is what makes this paragraph true; do not remove it on
 * the grounds that the row "already wraps".
 *
 * Before reaching for the default reveal in a new dense layout, check all
 * three: what it reflows, at every width rather than the two you have open,
 * and whether prose appearing mid-press reads as explanation or as alarm.
 */
export function ConfirmCost({
  id,
  children,
  alwaysHidden = false,
}: {
  id: string;
  children: ReactNode;
  /** Skip the reveal and stay `.visually-hidden` permanently. Default false:
   *  most call sites (the account page's Discord row, and the roster-replace
   *  and delete-operation controls in `payouts/[id]/page.tsx`) sit in a layout
   *  the reveal doesn't disturb, and for those the reveal is the point — a
   *  sighted operator reads the cost only once it is load-bearing. Set true
   *  where the sentence would reflow its neighbours, or where it would read as
   *  an error rather than a cost; the lifecycle controls in
   *  `payouts/[id]/lifecycle-submit.tsx` are the second case and currently the
   *  only caller. */
  alwaysHidden?: boolean;
}) {
  const ctx = useContext(ArmContext);
  if (!ctx) {
    throw new Error("ConfirmCost must be rendered inside a ConfirmArmScope");
  }
  const revealed = !alwaysHidden && ctx.armedDescribedBy === id;

  // No `className` passthrough. All four call sites passed exactly `"dim"` and
  // nothing else, which made it a required argument dressed as an optional one:
  // the component owned when the sentence is visible but not what it looked
  // like when it got there, so forgetting the prop rendered the cost as primary
  // copy. `.confirm-cost` carries `.dim`'s two declarations itself now. A caller
  // that genuinely needs different treatment should get a named prop with a
  // reason, not an open class slot.
  return (
    <span id={id} className={revealed ? "confirm-cost" : "confirm-cost visually-hidden"}>
      {children}
    </span>
  );
}

/**
 * A destructive row action that arms on the first click and only submits the
 * form on the second, rather than firing immediately — too easy to hit by
 * accident scanning a dense table — or interrupting with `window.confirm()`,
 * a banned first reflex here: the whole point of an inline confirm is that it
 * never rips the member out of the page.
 *
 * The armed state has to reach assistive tech, not just sighted users, and
 * neither the visible label swap nor the `aria-label` swap does that on its
 * own: both change the control's accessible name, and a name change on a
 * control that is already focused is not reliably re-announced. So the armed
 * state is spoken by a live region — an always-mounted `role="status"` span,
 * empty at rest and written with `confirmName` on arm. Always mounted because a
 * region that appears already holding its text is the shape AT most often
 * misses (`note-form.tsx:62-78` makes the same argument for its own region).
 *
 * The span is a sibling of the button, not a child of it: `button` is
 * children-presentational in ARIA, so roles on its descendants are stripped
 * from the accessibility tree and a region nested inside it would never be
 * exposed. It cannot go in `ConfirmArmScope` either — that renders no DOM of
 * its own precisely so it can wrap a `<tbody>`. Every call site puts this
 * button inside its own `<form>`, which is where the sibling lands, and
 * `.visually-hidden` is `position: absolute`, so it is not a flex or grid item
 * and adds no gap to the button rows it sits in. Only one control per scope can
 * be armed, so only one region is ever non-empty.
 *
 * `confirmName` is also the armed `aria-label`, for a member who tabs away
 * mid-arm and back: the bare word "confirm" announces a verb with no object.
 * It still starts with the visible word ("confirm …"), which is what keeps it a
 * WCAG 2.5.3 label-in-name match rather than a mismatched name.
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
 * Width is reserved for the wider of the two labels so the swap never
 * changes the button's own size and reflows the row it sits in — the same
 * failure #112 found from a different cause (a reveal inside a `td`) and
 * this component exists partly to avoid. An earlier version reserved it by
 * counting characters (`Math.max(label.length, confirmLabel.length)` in
 * `ch`, plus a flat fudge factor for `letter-spacing`) and that measurement
 * doesn't hold: `ch` is the "0" glyph's advance width alone, and
 * `letter-spacing` is extra space the browser inserts *between* every pair of
 * characters, so it scales with the label's length while a flat buffer
 * cannot — it overshoots a six-letter label like "unlink" and undershoots a
 * fifteen-letter one like "Replace roster" from the same constant. Rather
 * than modelling padding, border and per-character spacing in JS to match
 * whatever the stylesheet currently does (and silently drifting the moment
 * either side changes), the wider label is rendered as real CSS generated
 * content — `.confirm-submit__label::before` below — so the browser lays it
 * out with the button's actual font, weight, case transform and
 * letter-spacing and sizes the label span to fit it. `content: attr(...)` is
 * not a DOM node: it cannot appear in `element.textContent`, so it is invisible
 * to Playwright's text-matching engine (`getByText`, `toHaveText`) whether it
 * is painted or not. That is what rules out the obvious alternative — a second
 * real `<span>` holding the wider label and hidden with CSS — rather than
 * anything `visibility: hidden` does: `toHaveText` *does* read hidden real
 * elements (`e2e/admin.spec.ts:569-571` documents that), so a ghost span would
 * concatenate into the exact button text several call sites already assert
 * (`freeze`, "Testers", …). Generated content cannot, at any visibility.
 * `visibility: hidden` (not
 * `.visually-hidden`'s `position: absolute`) keeps the generated box in flow
 * so it still counts toward that sizing, while removing it from paint,
 * hit-testing and — per the ARIA accessible-name spec, which explicitly
 * excludes `visibility: hidden` generated content from the "subtree" text
 * alternative — from what a screen reader would compute as the button's name
 * if `restName` were ever omitted. `aria-label` already overrides that name
 * on every call site that sets it, so this is a second, independent reason
 * the ghost label is never announced, not the only one.
 *
 * Picking *which* label to render as the ghost still leans on `.length`, not
 * on measuring both: given a true monospace face (IBM Plex Mono, `layout.tsx`)
 * every character has the same advance and letter-spacing gap, so the longer
 * string is always the wider one, and comparing lengths to choose it is a
 * safe shortcut — unlike using the length to *compute* a width, which is what
 * broke before. `pendingLabel` is a `ReactNode`, not a string, so it can't
 * feed `attr()` and isn't part of this reservation; none of the twelve call
 * sites in `src/app/` pass it today, so nothing regresses, but a future
 * caller that does would want its own fix here.
 */
export function ConfirmSubmit({
  className,
  armedClassName,
  label,
  confirmLabel = "confirm",
  restName,
  confirmName,
  pendingLabel,
  describedBy,
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
  /** Id of an element stating what the action costs, when that consequence is
   *  not obvious from the label. A description, not a name: it stays out of
   *  `restName`/`confirmName`, which have to remain short enough to be spoken
   *  ahead of every press and have to keep matching the visible label. */
  describedBy?: string;
}) {
  const ctx = useContext(ArmContext);
  if (!ctx) {
    throw new Error("ConfirmSubmit must be rendered inside a ConfirmArmScope");
  }
  const id = useId();
  const armed = ctx.armedId === id;
  const { pending } = useFormStatus();
  const guard = useSubmitGuard(pending);
  // See the block comment above: the longer string, in a true monospace
  // face, is always the wider one, so `.length` is a safe way to choose
  // which label the ghost renders — it is not used to compute a width.
  const ghostLabel = label.length >= confirmLabel.length ? label : confirmLabel;

  return (
    <>
      <button
        type="submit"
        className={armed ? (armedClassName ?? className) : className}
        aria-busy={pending}
        aria-label={armed ? confirmName : restName}
        aria-describedby={describedBy}
        onClick={(e) => {
          if (!armed) {
            // The first click arms rather than fires: never let it reach the
            // server.
            e.preventDefault();
            ctx.arm(id, describedBy);
            return;
          }
          // The second click proceeds as an ordinary submit, unless one is
          // already in flight. Disarming is just tidy-up for the (rare) case
          // the action doesn't navigate or revalidate this control away.
          if (!guard(e)) return;
          ctx.disarm();
        }}
        onBlur={() => {
          // Tabbing or clicking away is as clear a "not that one" as Escape, and
          // it means an armed control never outlives the member's attention on
          // it. Guarded on `armed` so a blur from a different row's button can't
          // disarm whatever the scope handed the arm to next.
          if (armed) ctx.disarm();
        }}
        onPointerLeave={(e) => {
          // The case blur misses: arming with the mouse leaves focus on the
          // button, so moving the pointer to another row disarms nothing and the
          // arm outlives the intent. Mouse only — on touch the pointer is
          // destroyed on lift, so `pointerleave` fires immediately after the tap
          // that armed it and no control would ever stay armed long enough to
          // confirm.
          if (armed && e.pointerType === "mouse") ctx.disarm();
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
        <span className="confirm-submit__label" data-ghost-label={ghostLabel}>
          <span className="confirm-submit__text">
            {pending && pendingLabel ? pendingLabel : armed ? confirmLabel : label}
          </span>
        </span>
      </button>
      <span className="visually-hidden" role="status">
        {armed ? confirmName : ""}
      </span>
    </>
  );
}

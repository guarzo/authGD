"use client";

import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useConfirmReport } from "./confirm-group";
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
 * What a destructive action costs, shown to sighted users depending on
 * `visibility` — the default `"reveal"` shows it only once the control is
 * armed; `"hidden"` and `"visible"` are the two ways a call site opts out of
 * that dance (see the prop).
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
 * out of flow and adds no gap to the flex row it sits in. That is true for
 * every `visibility`, which is what makes it a change in one prop rather than a
 * different component.
 *
 * Reveals (`"reveal"` mode) for its own control only, matched on `describedBy`
 * rather than on "something in this scope is armed". The scope-wide reading is
 * correct in a scope holding one control and silently wrong in every other one:
 * a scope wrapping a whole table body would reveal one row's sentence when a
 * different row armed. Matching on the id means a scope may hold as many
 * controls and as many cost sentences as it likes, and controls that share a
 * sentence (the same `describedBy`) reveal it together, which is what sharing
 * one is for.
 *
 * That makes this component safe to put in a table; it does NOT make revealing
 * on arm a good idea there by default, and #112 established that empirically
 * before reverting the attempt. Revealing inside a `td` widens the cell, the
 * widening moves the armed button out from under a stationary mouse,
 * `pointerLeave` below fires, and the control disarms itself — the reveal
 * undoes the arm. The admin accounts table therefore keeps its own cost
 * sentence hand-rolled and `.visually-hidden` always (#111) rather than using
 * this component at all — that reflow is `"hidden"`'s case if this component
 * were used there instead.
 *
 * The account page's character `unlink` is the one in-table `"reveal"`, and it
 * is worth being precise about why it escapes #112 rather than treating it as
 * a counter-example: what disarms the control there is HORIZONTAL growth of
 * the cell. `.manifest-panel__controls .confirm-cost` gives that sentence
 * `flex-basis: 100%` inside an `align-items: flex-start` row, so the reveal
 * claims a fresh line and the panel grows downward from a fixed top edge,
 * leaving the button's box untouched. That is a measured claim, not a
 * structural guarantee — e2e/account.spec.ts's "arming unlink inside the
 * actions drawer does not move the button" is what keeps it true.
 *
 * `"visible"` is the third mode, added for a different reason again, and it is
 * worth not confusing the three. The payout page's Finalize and Unlock
 * controls (`payouts/[id]/lifecycle-submit.tsx`) used to pass what was then
 * called `alwaysHidden` — kept permanently `.visually-hidden` — because a
 * sentence appearing under Finalize the moment it arms reads as an error
 * message rather than as a cost (still true; `"reveal"` is still wrong here).
 * But `.visually-hidden` *always* meant no sighted user ever read it at all,
 * which is R4's failure mode (`DESIGN.md`'s "Disclosure and parity"), not a
 * layout one — the sentence is good copy that told nobody. `"visible"` is what
 * that call site actually wants: rendered plainly, at rest, every time, no
 * reveal step and no `.visually-hidden` toggle. It still needs to be this
 * component and not hand-rolled prose at the call site, because it is still
 * the `aria-describedby` target the button points at, and still has to keep
 * working if a future edit puts Finalize and Unlock back in the same row.
 * Finalize and Unlock are mutually exclusive anyway (`canFinalize` wants a
 * draft, `canRelease` wants a finalized operation), so there is no neighbour
 * for a permanently-visible sentence to shove; the row simply grows downward
 * from a fixed left edge, same as the account page's Discord row (below).
 *
 * The account page's Discord row uses `"reveal"`, because a `.page__meta-item`
 * is a place a sentence belongs — but only because `.page__meta-item >
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
 * Before reaching for `"reveal"` in a new dense layout, check all three: what
 * it reflows, at every width rather than the two you have open, and whether
 * prose appearing mid-press reads as explanation or as alarm. If it would read
 * as either, `"visible"` is very likely the right answer, not `"hidden"` — a
 * cost nobody presses without a warning is exactly the fact R4 says may not
 * live only in the assistive-tech channel.
 */
export function ConfirmCost({
  id,
  children,
  visibility = "reveal",
}: {
  id: string;
  children: ReactNode;
  /** `"reveal"` (default): hidden at rest, shown once this control's own arm
   *  matches `id`. Most call sites (the account page's Discord row and its
   *  character `unlink`, and the roster-replace and delete-operation controls
   *  in `payouts/[id]/page.tsx`) sit in a layout the reveal doesn't disturb,
   *  and for those the reveal is the point — a sighted operator reads the cost
   *  only once it is load-bearing.
   *
   *  `"hidden"`: stays `.visually-hidden` permanently. Reach for this only
   *  where the sentence would genuinely reflow a neighbour a reveal cannot
   *  afford to move — the admin accounts table's own hand-rolled version of
   *  this idea (#111) is the reference case; nothing currently calls this
   *  component with `"hidden"`.
   *
   *  `"visible"`: rendered plainly at rest, every time, never hidden and
   *  never gated on arming. For a cost that would read as an error if it
   *  arrived with the arm (`"reveal"`'s failure mode) or that must not be
   *  AT-only (`"hidden"`'s). The payout page's Finalize and Unlock controls
   *  (`payouts/[id]/lifecycle-submit.tsx`) are the only caller, on the grounds
   *  above. The account page's character `unlink` was briefly a second and is
   *  back on `"reveal"` — see the docblock for why the in-table argument that
   *  put it here does not survive `flex-basis: 100%`. */
  visibility?: "reveal" | "hidden" | "visible";
}) {
  const ctx = useContext(ArmContext);
  if (!ctx) {
    throw new Error("ConfirmCost must be rendered inside a ConfirmArmScope");
  }
  const revealed =
    visibility === "visible" || (visibility === "reveal" && ctx.armedDescribedBy === id);

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
 * form on the second — unless the caller passes `confirm={false}`, which is the
 * same button without the arm step (see the note on that prop at the end of
 * this block) — rather than firing immediately: too easy to hit by accident
 * scanning a dense table. And never `window.confirm()`, a banned first reflex
 * here: the whole point of an inline confirm is that it never rips the member
 * out of the page.
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
 * `armedClassName` lets a caller upgrade the visual grade only once armed:
 * FREEZE, UNLINK and REVOKE all sit at a quiet grade at rest and go to full
 * `.btn--danger` red only on confirm. REVOKE was the one exception until the
 * design pass that followed #193 — it held full `--danger` at rest, which put
 * four saturated buttons in a four-row admin table and spent the alarm colour
 * on a recoverable action. No caller now keeps the same class in both states.
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
 * broke before. `pendingLabel` is a `ReactNode`, so it can only join that
 * comparison when a caller passes a plain string — which the payout page's
 * eight controls now do, and which is why the reservation reads all three
 * candidates rather than the two it started with. A caller passing an element
 * gets the old two-way reservation and is responsible for its own width; that
 * is a narrower gap than the one that existed when nothing passed a pending
 * label at all, and it is the honest limit of a technique that has to feed
 * `attr()` a string.
 *
 * `confirm` defaults to true but can be set false to make this render as a
 * plain one-click submit instead — no arm step, no live region text, ever.
 * That exists for callers like `MarkPaidForm` (#146) that need to pick
 * between an armed and a plain control *at the same JSX position* depending
 * on caller-supplied state (whether this is the operation's first payment).
 * A ternary between `ConfirmSubmit` and the separate `Submit` component looks
 * equivalent but isn't: React reconciles by component type at a position, so
 * the render where the condition flips unmounts one component and mounts the
 * other, replacing the underlying `<button>` DOM node rather than patching
 * it. A press that begins on the old node during that swap produces no click
 * on the new one — the exact bug #146 reported. Keeping one component type in
 * that slot, toggled by a prop, makes the transition an ordinary re-render:
 * React patches the existing node's props instead of tearing it down.
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
  confirm = true,
  ariaPressed,
  disabled = false,
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
  /** False renders this as a plain submit: the first click fires immediately,
   *  never arms, never calls `ctx.arm`, and the live region beside it stays
   *  mounted but permanently empty.
   *
   *  Reach for this ONLY when the grade flips at a fixed JSX position while the
   *  control stays mounted — which today is `MarkPaidForm` and nothing else.
   *  Where the grade is statically known, use `Submit`: it is the same button
   *  without this one's reserved label width or its (empty) live region, and a
   *  reader who sees `ConfirmSubmit` has every right to expect an arm step. */
  confirm?: boolean;
  /** Passed straight through to the button's `aria-pressed`, undefined by
   *  default so the eleven other call sites render exactly as before. Named
   *  and reasoned rather than an open class/attr slot, per this file's own
   *  rule on `ConfirmCost`'s `className`. Exists for a toggle-style control
   *  that needs BOTH the "you are already here" semantics `aria-pressed`
   *  carries and an arm step on the press that would change that — the
   *  admin-accounts tier chips (`/admin/accounts/page.tsx`) are the first and
   *  so far only caller, since `Submit`'s own `aria-pressed` has no way to gate
   *  a press behind a second click. Independent of `armed`/`confirm`: this
   *  is about which tier the row holds right now, not about whether this
   *  press is mid-confirm. */
  ariaPressed?: boolean;
  /** Passed through to the button, and short-circuits `onClick` so a
   *  disabled control can never arm — belt-and-suspenders alongside the
   *  native `disabled` attribute, which already stops the browser from
   *  firing `click` at all, for the one caller (the same tier chips above)
   *  that renders this control disabled rather than swapping it out of the
   *  tree, so an event that somehow still reached this handler (e.g. a
   *  synthetic dispatch in a test) cannot arm a control the row says is
   *  inert. Default `false`, matching the native attribute's default and
   *  every existing call site. */
  disabled?: boolean;
}) {
  // Read unconditionally — hooks can't be conditional — but only *require* the
  // scope when this control can actually arm. A `confirm={false}` control has
  // to work anywhere a plain `Submit` would, including outside any
  // `ConfirmArmScope`.
  const ctx = useContext(ArmContext);
  const id = useId();
  const { pending } = useFormStatus();
  // A refused re-press is silent by design (`submit-guard.ts`): no POST, no
  // response, nothing for `ConfirmingForm` to forward. That silence is the
  // right answer for a control that redirects — the navigation the first press
  // started is visible on its own — and the wrong one inside a drawer, where
  // the page does not move and the admin is left watching a press do nothing
  // while the arm step they just cleared has already reset. The group's notice
  // is where every other outcome in that drawer lands, so it is where this one
  // lands too.
  //
  // Safe to leave standing, per `useConfirmReport`'s rule: the press that was
  // refused was refused *because* an action is in flight, and that action's own
  // outcome overwrites this sentence when it resolves. Outside a `ConfirmGroup`
  // there is no channel, `report` is null, and the guard behaves exactly as it
  // did before.
  const report = useConfirmReport();
  const guard = useSubmitGuard(
    pending,
    report
      ? () => report({ text: "Still working on the last press.", tone: "warn" })
      : undefined,
  );
  // Thrown BELOW the hooks, not above them. `confirm` can change between
  // renders, so a throw placed before `useId` would run a different number of
  // hooks than the previous render did, and React's "rendered fewer hooks than
  // expected" would bury the one message that says what to actually fix.
  if (confirm && !ctx) {
    throw new Error("ConfirmSubmit must be rendered inside a ConfirmArmScope");
  }
  // Every `ctx?.` below is safe rather than defensive: the throw above means
  // `confirm` implies `ctx`, and each call site is gated on either `confirm` or
  // `armed` (which requires it). TypeScript can't carry that narrowing into the
  // handler closures, so it is spelled with `?.` rather than a `!`. If the
  // throw is ever loosened, those stop being unreachable and start being silent
  // no-ops — a control that swallows its first click and never arms, which is
  // #146's symptom made permanent. Loosen the throw and you must restructure
  // these, not just delete it.
  //
  // A control that is armed when `confirm` flips false goes un-armed here
  // without anyone calling `disarm()`, so the scope's `armedId` keeps pointing
  // at it until the next `arm()` overwrites it. Left that way deliberately: the
  // only caller that flips `confirm` is `MarkPaidForm`, and it flips once per
  // operation, permanently (`page.tsx:206`, `locked` never goes back). The
  // residue can only mislead a `ConfirmCost` sharing this control's
  // `describedBy`, and the one id involved (`mark-paid-cost`) belongs to a
  // plain span that unmounts in the same render. A future `confirm={false}`
  // caller that can flip back, or that shares a `ConfirmCost`, needs an
  // explicit disarm here.
  const armed = confirm && ctx?.armedId === id;
  // See the block comment above: the longer string, in a true monospace
  // face, is always the wider one, so `.length` is a safe way to choose
  // which label the ghost renders — it is not used to compute a width.
  // `pendingLabel` joins the comparison only when it is a string, because
  // `attr()` has nothing to do with an element; a caller passing a node is
  // reserving for two labels out of three and owns the consequence.
  const ghostLabel = [
    label,
    confirmLabel,
    typeof pendingLabel === "string" ? pendingLabel : "",
  ].reduce((widest, candidate) =>
    candidate.length > widest.length ? candidate : widest,
  );

  return (
    <>
      <button
        type="submit"
        className={armed ? (armedClassName ?? className) : className}
        aria-busy={pending}
        aria-pressed={ariaPressed}
        aria-label={armed ? confirmName : restName}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={(e) => {
          if (disabled) return;
          if (!confirm) {
            // Plain grade: an ordinary submit, guarded against a double-press
            // exactly the way `Submit` guards its own (`submit.tsx:63`).
            guard(e);
            return;
          }
          if (!armed) {
            // The first click arms rather than fires: never let it reach the
            // server.
            e.preventDefault();
            ctx?.arm(id, describedBy);
            return;
          }
          // The second click proceeds as an ordinary submit, unless one is
          // already in flight. Disarming is just tidy-up for the (rare) case
          // the action doesn't navigate or revalidate this control away.
          if (!guard(e)) return;
          ctx?.disarm();
        }}
        onBlur={() => {
          // Tabbing or clicking away is as clear a "not that one" as Escape, and
          // it means an armed control never outlives the member's attention on
          // it. Guarded on `armed` so a blur from a different row's button can't
          // disarm whatever the scope handed the arm to next.
          if (armed) ctx?.disarm();
        }}
        onPointerLeave={(e) => {
          // The case blur misses: arming with the mouse leaves focus on the
          // button, so moving the pointer to another row disarms nothing and the
          // arm outlives the intent. Mouse only — on touch the pointer is
          // destroyed on lift, so `pointerleave` fires immediately after the tap
          // that armed it and no control would ever stay armed long enough to
          // confirm.
          if (armed && e.pointerType === "mouse") ctx?.disarm();
        }}
        onKeyDown={(e) => {
          // A member who armed the wrong row must not have to reload to get out
          // of it.
          if (armed && e.key === "Escape") {
            e.preventDefault();
            ctx?.disarm();
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

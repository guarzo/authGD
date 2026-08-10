"use client";

import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/**
 * At most one character's actions drawer open at a time, the same shape as
 * `ConfirmArmScope` (`_components/confirm-submit.tsx`) and for a related
 * reason: two open panels read as two unrelated objects on the page, not one
 * table with one thing currently expanded. Renders no DOM of its own — this
 * sits directly inside `<tbody>` (page.tsx), beside `ConfirmArmScope`, and a
 * stray wrapper element between `tbody` and its `<tr>`s breaks table
 * semantics outright (the same constraint `ConfirmArmScope`'s own docblock
 * states).
 *
 * Holds only `openId`, never the drawer contents: `everOpen` stays a
 * per-row `useState` below, not lifted here, because its whole reason for
 * existing — don't ship every panel's contents in server HTML — would be
 * defeated by mounting all of them the moment any one row opens.
 */
const OpenRowContext = createContext<{
  openId: string | null;
  setOpenId: (id: string | null) => void;
} | null>(null);

/** Wraps the manifest's `<tbody>` rows so their actions drawers share the
 *  "one open at a time" rule above. */
export function ManifestOpenScope({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <OpenRowContext.Provider value={{ openId, setOpenId }}>
      {children}
    </OpenRowContext.Provider>
  );
}

/**
 * The crew manifest's per-character row, plus the disclosure that replaced
 * its permanent MAIN/UNLINK column (walkthrough ruling R2). Owns the whole
 * `<tr>`, not just the actions cell, for the same reason `Disclosure`
 * (`_components/disclosure.tsx`, `as="row"`) owns its whole row: the panel
 * is a sibling `<tr>`, and a `<tr>` cannot be built as a child of a `<td>`
 * returned from inside this row and then reparented next to it.
 *
 * Not `<Disclosure as="row">` itself, though the open/everOpen/hidden
 * machinery below mirrors it exactly. That component's row shape puts the
 * toggle in the FIRST cell and takes the rest as `cells` — built for the
 * admin table, whose first column already **is** the row's identity. This
 * table's first column is the portrait, and the toggle belongs in the
 * actions cell at the end, not the front: reusing `as="row"` here would mean
 * either reordering the row (moving the portrait after the toggle) or
 * displacing the identity a screen-reader user scans for first. Hand-rolled
 * instead, with `leadCells` standing in for the columns that stay exactly
 * where they were.
 *
 * The panel it opens is `.manifest-panel`, not the admin table's `.drawer`.
 * An owner walkthrough on a first cut of this row (which rendered MAIN/
 * UNLINK directly in the ACTIONS cell, no disclosure at all) found that
 * approach regressed a real budget — a faulted account's forced-horizontal-
 * scroll region grew from ~257px to 299px at 320px, because a table column's
 * width is shared by every row in it, so main's single-button row paid for
 * an alt row's two-button content. Reusing `.drawer` to fix that would have
 * traded it for a different, already-diagnosed problem: that class carries
 * `position: sticky` and `width: calc(100cqi - 2 * var(--s-3))`, built so
 * the admin table's panel survives an 8-column table that scrolls sideways
 * constantly. This table's forced scroll is a 320px edge case, not a routine
 * state, and the sticky/cqi machinery only parked the toggle ~200px from its
 * row inside a narrow band with a doubled hairline. `.manifest-panel`
 * (globals.css) is the plain, unpinned panel that replaced it.
 *
 * `actions === null` renders no toggle, no panel, and no `<td>` at all, rather
 * than a control that opens on nothing. That is deliberate, not a missed case:
 * a single-character account's row has neither `main` (gated on `!isMain`) nor
 * `unlink` (gated on more than one character), and the account page has to be
 * able to say so.
 *
 * Dropping the cell rather than emptying it is what keeps this row aligned with
 * `showActionsColumn` (page.tsx), which elides the matching `<col>` and `<th>`
 * on the same condition. The two agree without a second prop because the
 * predicate is uniform across a given table — when the crew is larger than one
 * every row has actions, and when it is exactly one there is no other row to
 * disagree with. A future gate that varies row-to-row breaks that and would
 * have to pass the column's own decision down, because nothing throws when body
 * cells outnumber header cells.
 */
export function CharacterRow({
  name,
  colSpan,
  leadCells,
  actions,
}: {
  /** The character's name, folded into the toggle's accessible name — the
   *  same reason `restName`/`confirmName` exist on the buttons inside the
   *  panel: a screen-reader user on a row-per-character table cannot see
   *  which row a bare "actions" belongs to. */
  name: string;
  /** How many columns the panel's `<td>` should span — `manifestColumns()`,
   *  passed through rather than recomputed here so this component stays
   *  agnostic to the table's own column logic. */
  colSpan: number;
  /** The portrait/name/[status] `<td>`s, unchanged from before this row
   *  gained a disclosure — passed through rather than rebuilt here so this
   *  component owns only the toggle and the panel it opens. */
  leadCells: ReactNode;
  /** MAIN and/or UNLINK, already gated by the caller, or `null` for a row
   *  with neither. */
  actions: ReactNode | null;
}) {
  // Thrown above the remaining hooks, matching `ConfirmCost`
  // (confirm-submit.tsx) rather than `ConfirmSubmit`: the condition here is
  // provider presence, which is fixed by this component's JSX position, so
  // every render either throws or doesn't and the hooks below always run in
  // the same order. `ConfirmSubmit` deliberately throws BELOW its hooks
  // because its condition is a prop (`confirm && !ctx`) that can flip between
  // renders — do not read this as licence to hoist that one.
  const scope = useContext(OpenRowContext);
  if (!scope) {
    throw new Error("CharacterRow must be rendered inside a ManifestOpenScope");
  }
  // Latches open on first toggle and never clears, same reasoning as
  // `Disclosure`'s `everOpen`: an armed-but-unmounted `ConfirmSubmit` would
  // lose its arm state on close/reopen, and shipping every row's panel
  // contents eagerly in the server HTML is the cost of two controls nobody
  // opened, times every character on every account. Per-row, unlike `open`
  // below: lifting this too would mount every row's panel contents the
  // moment any one of them opened.
  const [everOpen, setEverOpen] = useState(false);
  const id = useId();
  // Whether THIS row's `id` is the one the scope currently holds open — not
  // its own state, so opening one row closes whichever other row held it.
  const open = scope.openId === id;
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Escape closes the drawer — but only a press no one else has claimed.
  // `ConfirmSubmit`'s own Escape handler (`_components/confirm-submit.tsx`)
  // disarms and calls `preventDefault()` WITHOUT `stopPropagation()`, so that
  // same keypress bubbles to here. Skipping an already-prevented event is what
  // makes the two layers ordered rather than simultaneous: the first Escape
  // disarms an armed unlink, the second closes the drawer. Collapsing both into
  // one press would take the panel away mid-confirmation, which is the state a
  // member pressing Escape is most likely trying to back out of one step at a
  // time. The signal is already on the event, so this needs no coordination
  // with the arm scope.
  //
  // Bound to the toggle as well as the panel, not just the panel: opening moves
  // no focus — nothing here focuses the panel, the same as `Disclosure`, since
  // this is a non-modal inline disclosure and not a dialog — so a keyboard
  // member who has just opened a drawer is still standing on the toggle, and
  // that is where the first Escape actually lands.
  const onEscape = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || !open) return;
    e.preventDefault();
    scope.setOpenId(null);
    // Closing sets `hidden` on the row that contains the focused element, so
    // without this focus is stranded in a hidden subtree — a worse outcome than
    // having no Escape at all. Close-and-refocus-the-trigger is the repo's
    // existing idiom for this (`payouts/[id]/inline-edit.tsx`); `Disclosure`
    // manages no focus only because closing it is always a click on the toggle,
    // which focus never left.
    toggleRef.current?.focus();
  };

  return (
    <>
      <tr>
        {leadCells}
        {actions && (
          <td>
            <button
              type="button"
              ref={toggleRef}
              // `.btn--micro`: this toggle is the in-row control now, not the
              // buttons it opens — DESIGN.md's 28px grade for "rows that each
              // carry a control set and are read many at a time" describes
              // this button, not the panel beneath it (ruling R1). `.disc`'s
              // dim/hover/marker language, not `.row-toggle`'s: that class is
              // deliberately undimmed because it carries the admin table's
              // row IDENTITY, and this button carries no identity — it is a
              // secondary control, same standing as a `<details>` summary.
              //
              // Icon-only (globals.css's `.row-toggle--actions` docblock has
              // the full account): the visible word "actions" used to repeat
              // on every row of a ten-row table, identically, which made it
              // the loudest pattern in the manifest. The +/- marker
              // (`::before`) is the same disclosure affordance `.row-toggle`
              // and `.disc > summary` already use with no caption elsewhere
              // in this app. `aria-label` still names the control for
              // assistive tech — the row's own name, so a screen-reader user
              // never hears a bare "actions" three times with no row to tell
              // them apart.
              className="btn btn--quiet btn--micro row-toggle--actions"
              aria-expanded={open}
              aria-controls={id}
              aria-label={`${name} actions`}
              onClick={() => {
                scope.setOpenId(open ? null : id);
                setEverOpen(true);
              }}
              onKeyDown={onEscape}
            />
          </td>
        )}
      </tr>
      {actions && (
        // `drawer-row`: the same "not a data row" convention class the
        // contacts-remedy sub-row uses (globals.css's `tr:not(.drawer-row)`
        // selectors already know to skip it for sticky-col/zebra purposes).
        // `drawer-row--actions` alongside it: the remedy row and this one are
        // both legitimately `.drawer-row`, but e2e assertions that count
        // "the remedy sub-row" need to tell them apart, since a nominal
        // ten-character seed now mounts one of these — hidden, but still in
        // the DOM — per character.
        <tr
          className="drawer-row drawer-row--actions"
          hidden={!open}
          onKeyDown={onEscape}
        >
          {/* Carries the toggle's `aria-controls` target. On the `<td>` rather
              than the `<tr>`: the row is the thing `hidden` toggles, but the
              cell is what actually holds the controls, and a reference into a
              `<tr>` is announced inconsistently across engines. */}
          <td colSpan={colSpan} id={id}>
            {/* `.manifest-panel`/`.manifest-panel__controls`: a purpose-built
                panel, not `.drawer` — see the docblock above for why. R1's
                reasoning still governs even though the class doesn't: this
                is "one open at a time, spans the full row's width, nothing
                competing with it for space", which is what earns the
                controls inside it the 36px standalone grade rather than
                `.btn--micro`. "One open at a time" used to be aspirational
                here — nothing enforced it, and multiple rows could be open
                together (e2e/account.spec.ts caught it). `ManifestOpenScope`
                above makes it true: `open` is derived from the scope's single
                `openId`, so a second row opening is what closes this one. */}
            <div className="manifest-panel">
              <div className="manifest-panel__controls">{everOpen && actions}</div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * The crew manifest's per-character row, plus the disclosure that replaced
 * its permanent MAIN/UNLINK column (walkthrough ruling R2). Owns the whole
 * `<tr>`, not just the actions cell, for the same reason `Disclosure`
 * (`_components/disclosure.tsx`, `as="row"`) owns its whole row: the drawer
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
 * `actions === null` renders no toggle and no drawer at all — an empty `<td>`
 * — rather than a control that opens on nothing. That is deliberate, not a
 * missed case: a single-character account's row has neither `main` (gated on
 * `!isMain`) nor `unlink` (gated on more than one character), and the account
 * page has to be able to say so.
 */
export function CharacterRow({
  name,
  colSpan,
  leadCells,
  actions,
}: {
  /** The character's name, folded into the toggle's accessible name — the
   *  same reason `restName`/`confirmName` exist on the buttons inside the
   *  drawer: a screen-reader user on a row-per-character table cannot see
   *  which row a bare "actions" belongs to. */
  name: string;
  /** How many columns the drawer's `<td>` should span — `manifestColumns()`,
   *  passed through rather than recomputed here so this component stays
   *  agnostic to the table's own column logic. */
  colSpan: number;
  /** The portrait/name/[status] `<td>`s, unchanged from before this row
   *  gained a disclosure — passed through rather than rebuilt here so this
   *  component owns only the toggle and the drawer it opens. */
  leadCells: ReactNode;
  /** MAIN and/or UNLINK, already gated by the caller, or `null` for a row
   *  with neither. */
  actions: ReactNode | null;
}) {
  const [open, setOpen] = useState(false);
  // Latches open on first toggle and never clears, same reasoning as
  // `Disclosure`'s `everOpen`: an armed-but-unmounted `ConfirmSubmit` would
  // lose its arm state on close/reopen, and shipping every row's drawer
  // contents eagerly in the server HTML is the cost of two controls nobody
  // opened, times every character on every account.
  const [everOpen, setEverOpen] = useState(false);
  const id = useId();

  return (
    <>
      <tr>
        {leadCells}
        <td>
          {actions && (
            <button
              type="button"
              // `.btn--micro`: this toggle is the in-row control now, not the
              // buttons it opens — DESIGN.md's 28px grade for "rows that each
              // carry a control set and are read many at a time" describes
              // this button, not the drawer beneath it (ruling R1). `.disc`'s
              // dim/hover/marker language, not `.row-toggle`'s: that class is
              // deliberately undimmed because it carries the admin table's
              // row IDENTITY, and this button carries no identity — it is a
              // secondary control, same standing as a `<details>` summary.
              className="btn btn--quiet btn--micro row-toggle--actions"
              aria-expanded={open}
              aria-controls={id}
              aria-label={`${name} actions`}
              onClick={() => {
                setOpen((o) => !o);
                setEverOpen(true);
              }}
            >
              actions
            </button>
          )}
        </td>
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
        <tr className="drawer-row drawer-row--actions" hidden={!open}>
          {/* Carries the toggle's `aria-controls` target. On the `<td>` rather
              than the `<tr>`: the row is the thing `hidden` toggles, but the
              cell is what actually holds the controls, and a reference into a
              `<tr>` is announced inconsistently across engines. */}
          <td colSpan={colSpan} id={id}>
            {/* `.drawer`/`.drawer__controls`: the same panel the admin
                accounts table's per-row disclosure uses, and the same reason
                to reuse it rather than hand-roll a second one — R1 already
                settled that a disclosure panel takes the 36px standalone
                grade, and `.scroller:has(.drawer)` (globals.css) already
                gives any `.drawer` the container-query sizing a full-measure
                Scroller needs, with no extra wiring here. */}
            <div className="drawer">
              <div className="drawer__controls">{everOpen && actions}</div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

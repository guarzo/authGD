"use client";

import { useState, type ReactNode } from "react";

/**
 * The per-row expander in the admin accounts table.
 *
 * The drawer holds every control for the account plus a full crew table, and
 * both want the width of the whole table, not just the Name column. A
 * `<details>` can't hold a `<tr>` as a child — the browser hoists it out of
 * the table and the layout breaks — so the toggle and the drawer are now two
 * elements sharing one piece of state: a `<button>` in the collapsed row's
 * Name cell, and a second `<tr>` immediately after it that carries the
 * drawer in a cell spanning every column (`colSpan`).
 *
 * The button still has to carry an accessible name that says what opening it
 * does — its visible text is the account name, which describes the row, not
 * the control — and it still has to expose `aria-expanded`, which can only
 * track the open state if something holds that state. Keeping `open` as this
 * component's own React state, rather than a DOM attribute on a native
 * disclosure, is what makes the drawer's survival across a server-action
 * revalidation a property of this component rather than an accident of how
 * React reconciles the DOM.
 *
 * The accessible name is prefixed with the visible text so it still satisfies
 * WCAG 2.5.3 (label in name) for speech input.
 */
export function RowDisclosure({
  label,
  summary,
  cells,
  colSpan,
  children,
}: {
  label: string;
  summary: ReactNode;
  /** The rest of the collapsed row's `<td>`s, rendered as siblings of the toggle cell. */
  cells: ReactNode;
  /** How many columns the table has, so the drawer row's cell can span all of them. */
  colSpan: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td>
          <button
            type="button"
            className="row-toggle"
            aria-expanded={open}
            aria-label={`${label} — crew and controls`}
            onClick={() => setOpen((o) => !o)}
          >
            {summary}
          </button>
        </td>
        {cells}
      </tr>
      {/* `hidden` rather than an unmount: the note field is an uncontrolled
          input, so unmounting it on close and remounting it on reopen would
          drop an unsaved draft back to `defaultValue`. */}
      <tr className="drawer-row" hidden={!open}>
        <td colSpan={colSpan}>
          <div className="drawer">{children}</div>
        </td>
      </tr>
    </>
  );
}

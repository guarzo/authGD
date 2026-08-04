"use client";

import { type ReactNode, useId, useState } from "react";

/**
 * A disclosure built on `<details>` rather than the ARIA button-and-region
 * accordion, for two reasons: it still opens and closes with no JavaScript at
 * all (most pages that use it are otherwise fully server-rendered), and
 * browsers can find text inside a collapsed section, which matters when an
 * admin is hunting for a job name or an error string.
 *
 * The state mirror exists only to put an explicit `aria-expanded` on the
 * toggle. Native `<summary>` already exposes an expanded state, but not as an
 * attribute anything can assert against, and the implicit mapping has been
 * inconsistent across engines.
 *
 * This one component covers two shapes that used to be two files:
 *
 * - `as="details"` (the default) renders `<details>`/`<summary>`, for a
 *   disclosure that sits inline in the document flow.
 * - `as="row"` renders a toggle `<button>` plus a second `<tr>`, for the
 *   admin accounts table's per-row expander. A `<details>` can't hold a
 *   `<tr>` as a child — the browser hoists it out of the table and the
 *   layout breaks — so this shape needs its own two elements sharing one
 *   piece of React state instead of the DOM's native open/closed state.
 *
 * Both shapes used to diverge on which of `aria-controls`, `className`
 * passthrough, `defaultOpen` and the WCAG 2.5.3 label-in-name `aria-label`
 * they supported. All four now apply to both.
 */
type DisclosureBaseProps = {
  summary: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
};

type DetailsProps = DisclosureBaseProps & {
  as?: "details";
  /** Pre-built accessible name for the summary, for when the visible summary
   *  text alone doesn't say what opening it does. Must start with the
   *  visible text if provided, to stay a WCAG 2.5.3 label-in-name match. */
  ariaLabel?: string;
};

type RowProps = DisclosureBaseProps & {
  as: "row";
  /** The row's visible identity. The accessible name is derived from it
   *  (" — crew and controls" appended) rather than passed pre-built, since
   *  every row-mode caller in this table needs the same suffix — the visible
   *  toggle text is the account name, which describes the row, not what the
   *  control does. */
  label: string;
  /** The rest of the collapsed row's `<td>`s, rendered as siblings of the toggle cell. */
  cells: ReactNode;
  /** How many columns the table has, so the drawer row's cell can span all of them. */
  colSpan: number;
};

export function Disclosure(props: DetailsProps | RowProps) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const id = useId();

  if (props.as === "row") {
    const { summary, cells, colSpan, className, label, children } = props;
    return (
      <>
        <tr>
          <td>
            <button
              type="button"
              className={className ?? "row-toggle"}
              aria-expanded={open}
              aria-controls={id}
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
            <div className="drawer" id={id}>
              {children}
            </div>
          </td>
        </tr>
      </>
    );
  }

  const { summary, className, ariaLabel, children } = props;
  return (
    <details
      className={className}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary aria-expanded={open} aria-controls={id} aria-label={ariaLabel}>
        {summary}
      </summary>
      <div id={id}>{children}</div>
    </details>
  );
}

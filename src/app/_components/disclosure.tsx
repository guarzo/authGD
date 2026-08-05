"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

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
  // Row mode only (see below). Starts equal to `open` so a `defaultOpen` row
  // renders its children on the server exactly as it did before.
  const [everOpen, setEverOpen] = useState(props.defaultOpen ?? false);
  const id = useId();
  const detailsRef = useRef<HTMLDetailsElement | null>(null);

  // `<details>` toggles with no JavaScript at all, which is the reason it was
  // chosen — but it means a toggle can happen *before* hydration, with no
  // listener attached and no React event replay to catch it. The mirror below
  // is rendered from state initialised at mount, so on a slow connection an
  // admin can open a row and leave `aria-expanded="false"` on an open drawer
  // permanently, until they toggle it again. Read the element's real `open`
  // once on mount and adopt it. Unused in row mode, where the `<button>` is
  // the sole source of truth and cannot drift; the hook still has to run
  // unconditionally, so it sits above the branch.
  useEffect(() => {
    const el = detailsRef.current;
    if (el) setOpen(el.open);
  }, []);

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
              onClick={() => {
                setOpen((o) => !o);
                setEverOpen(true);
              }}
            >
              {summary}
            </button>
          </td>
          {cells}
        </tr>
        {/* `hidden` rather than an unmount: the note field is an uncontrolled
            input, so unmounting it on close and remounting it on reopen would
            drop an unsaved draft back to `defaultValue`.

            The children are gated on `everOpen` rather than `open` for the
            same reason, from the other side. Every row of the admin accounts
            table carries a crew table, a nested Scroller (two ResizeObservers),
            a NoteForm, a ConfirmSubmit and about six forms; shipping N of each
            in the server HTML and hydrating them all is the cost of a drawer
            nobody opened. `everOpen` latches on the first toggle and never
            clears, so from that point on this is exactly the old behaviour and
            the draft-preservation argument above still holds — a row that has
            been opened once keeps its subtree for the rest of the page's life,
            open or closed.

            Deliberately NOT applied to the `as="details"` branch below, whose
            children stay eager: find-in-page has to reach text inside a
            collapsed <details>, and that shape is the one that still works with
            no JavaScript at all.

            The row and the div are still rendered unconditionally. The
            `aria-controls` above targets that div by id, and
            `.scroller:has(.drawer)` (globals.css) is what gives the drawer its
            inline-size container — both would break on a subtree that isn't
            there. */}
        <tr className="drawer-row" hidden={!open}>
          <td colSpan={colSpan}>
            <div className="drawer" id={id}>
              {everOpen && children}
            </div>
          </td>
        </tr>
      </>
    );
  }

  const { summary, className, ariaLabel, children } = props;
  return (
    <details
      ref={detailsRef}
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

"use client";

import { useState, type ReactNode } from "react";

/**
 * The per-row expander in the admin accounts table.
 *
 * A bare `<details>`/`<summary>` would be smaller, but the summary has to carry
 * an accessible name that says what opening it does — its visible text is the
 * account name, which describes the row, not the control — and it has to expose
 * `aria-expanded`, which can only track the open state if something holds that
 * state. Controlling `open` from React also makes the drawer's survival across a
 * server-action revalidation a property of this component rather than an
 * accident of how React reconciles an uncontrolled `open` attribute.
 *
 * The accessible name is prefixed with the visible text so it still satisfies
 * WCAG 2.5.3 (label in name) for speech input.
 */
export function RowDisclosure({
  label,
  summary,
  children,
}: {
  label: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary aria-expanded={open} aria-label={`${label} — crew and controls`}>
        {summary}
      </summary>
      <div className="drawer">{children}</div>
    </details>
  );
}

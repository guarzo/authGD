"use client";

import { type ReactNode, useId, useState } from "react";

/**
 * A disclosure built on `<details>` rather than the ARIA button-and-region
 * accordion, for two reasons: it still opens and closes with no JavaScript at
 * all (this page is otherwise fully server-rendered), and browsers can find
 * text inside a collapsed section, which matters when an admin is hunting for
 * a job name or an error string.
 *
 * The state mirror exists only to put an explicit `aria-expanded` on the
 * summary. Native `<summary>` already exposes an expanded state, but not as an
 * attribute anything can assert against, and the implicit mapping has been
 * inconsistent across engines.
 */
export function Disclosure({
  summary,
  defaultOpen = false,
  className,
  children,
}: {
  summary: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <details
      className={className}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary aria-expanded={open} aria-controls={id}>
        {summary}
      </summary>
      <div id={id}>{children}</div>
    </details>
  );
}

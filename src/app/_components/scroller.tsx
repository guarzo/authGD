"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A horizontally scrollable region for wide tables. tabIndex makes the
 * overflow reachable by keyboard, which a plain overflow container is not.
 *
 * The edge fades can't hang off `.scroller` itself: an absolutely-positioned
 * child of an `overflow-x: auto` box is part of that box's own scrollable
 * content and translates with it, so it would ride off with the table
 * instead of staying pinned to the edge. `.scroller-frame` is a second,
 * non-scrolling positioned ancestor the fades hang off instead;
 * `.scroller`'s own `position: relative` stays exactly as it was, for
 * containing `.visually-hidden` (see globals.css). `atStart`/`atEnd` mirror
 * whether the region is scrolled all the way to that edge, so a side fades
 * out once you've reached it rather than lingering once it's told the truth.
 */

export function Scroller({ label, children }: { label: string; children: ReactNode }) {
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback((el: HTMLDivElement) => {
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setAtStart(scrollLeft <= 0);
    setAtEnd(scrollLeft + clientWidth >= scrollWidth - 1);
  }, []);

  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure(el);
    // ResizeObserver rather than a window resize listener. A Scroller mounted
    // inside a collapsed `<details>` (admin/sync's job strips) has no layout
    // box, so it measures 0×0 and reads as "scrolled to both edges" — and
    // opening the disclosure fires no resize event, so the fades would never
    // appear on the one surface that starts out hidden. An observer sees the
    // box gain size instead.
    const observer = new ResizeObserver(() => measure(el));
    observer.observe(el);
    // The scroll box's own border box doesn't change when its contents grow
    // wider, so watch the content too — that's what actually moves
    // scrollWidth, e.g. a button's label going from `unlink` to `unlinking…`.
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div className="scroller-frame">
      <div
        ref={ref}
        className="scroller"
        role="region"
        aria-label={label}
        tabIndex={0}
        onScroll={(e) => measure(e.currentTarget)}
      >
        {children}
      </div>
      <div
        className="scroller-fade scroller-fade--start"
        aria-hidden="true"
        data-visible={!atStart || undefined}
      />
      <div
        className="scroller-fade scroller-fade--end"
        aria-hidden="true"
        data-visible={!atEnd || undefined}
      />
    </div>
  );
}

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
 *
 * `tall` caps the height, which is what gives a sticky header a scroll range to
 * travel over; the two long admin tables set it.
 */

export function Scroller({
  label,
  tall,
  children,
}: {
  label: string;
  tall?: boolean;
  children: ReactNode;
}) {
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  // Whether there is any scroll range at all, on either axis. Separate from
  // atStart/atEnd, which answer "which edge fade should show" and are both
  // true for a region that simply fits — the same reading a `tall` region
  // gives when it overflows vertically and not horizontally.
  //
  // Starts true, and the effect below takes the stop away rather than granting
  // it. The server cannot measure, so the alternative starts every region at
  // `tabIndex={-1}` and leaves the overflow unreachable by keyboard for the
  // whole of the pre-hydration window — a real loss of access traded for a
  // cosmetic one. This way the only cost is a stop that turns out to be
  // redundant, and only until the first measurement.
  const [scrollable, setScrollable] = useState(true);

  const measure = useCallback((el: HTMLDivElement) => {
    const { scrollLeft, scrollWidth, clientWidth, scrollHeight, clientHeight } = el;
    setAtStart(scrollLeft <= 0);
    setAtEnd(scrollLeft + clientWidth >= scrollWidth - 1);
    setScrollable(scrollWidth > clientWidth + 1 || scrollHeight > clientHeight + 1);
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
        className={tall ? "scroller scroller--tall" : "scroller"}
        role="region"
        aria-label={label}
        // A scroll container earns a tab stop only while it has something to
        // scroll. The sync page opens one of these per expanded job row, and
        // at desktop width the runs table usually fits its region — so an
        // unconditional stop put several dead stops between an admin and the
        // Re-run button they came for, each announcing "…runs, region". A
        // Scroller inside a collapsed `<details>` measures 0×0 and loses the
        // stop, so getting it back rests on the ResizeObserver above firing
        // when the drawer opens; `e2e/sync.spec.ts` pins that, because a
        // missed observation now costs keyboard access to the table rather
        // than just the edge fades. `role="region"` and the label stay either
        // way: it is still worth having in the landmark list.
        tabIndex={scrollable ? 0 : -1}
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

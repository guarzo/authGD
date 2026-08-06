import type { Page } from "@playwright/test";

/**
 * Rect-vs-rect measurement of a table cell against its scroll region, taken
 * after driving the region to an extreme.
 *
 * Why not `toBeInViewport`: it is a geometric intersection with the *viewport*
 * rectangle, and an element painted over completely by an opaque sticky cell
 * still intersects it — so an assertion built on it passes with the pinning CSS
 * deleted outright. Every assertion here compares rectangles instead.
 *
 * `maxScrollLeft` / `maxScrollTop` come back with the measurement so a caller
 * can prove there was something to scroll past before claiming the pin held.
 *
 * `gutterWidth` is `offsetWidth - clientWidth` on the scroll region itself,
 * measured in the same call. A region with `scrollbar-gutter: stable`
 * (globals.css, `.scroller--tall`) reserves that much width unconditionally —
 * `clientWidth` shrinks by it, `scrollWidth` does not — so the true rightmost
 * `scrollLeft` a caller can drive the region to sits up to `gutterWidth` short
 * of the naive `scrollWidth - clientWidth` figure. Measuring it here rather
 * than hardcoding a number keeps the comparison correct on any platform,
 * whatever that platform's own scrollbar happens to cost.
 */
export async function pinGeometry(
  page: Page,
  scroller: string,
  cell: string,
  scroll: "right" | "down",
) {
  return page.evaluate(
    ({ scroller, cell, scroll }) => {
      const sc = document.querySelector(scroller) as HTMLElement;
      if (scroll === "right") sc.scrollLeft = sc.scrollWidth;
      else sc.scrollTop = sc.scrollHeight;
      const el = sc.querySelector(cell) as HTMLElement;
      const c = el.getBoundingClientRect();
      const s = sc.getBoundingClientRect();
      return {
        text: el.textContent ?? "",
        position: getComputedStyle(el).position,
        cellWidth: c.width,
        cellHeight: c.height,
        regionWidth: sc.clientWidth,
        overlapX: Math.min(c.right, s.right) - Math.max(c.left, s.left),
        overlapY: Math.min(c.bottom, s.bottom) - Math.max(c.top, s.top),
        scrolledLeft: sc.scrollLeft,
        scrolledTop: sc.scrollTop,
        maxScrollLeft: sc.scrollWidth - sc.clientWidth,
        maxScrollTop: sc.scrollHeight - sc.clientHeight,
        gutterWidth: sc.offsetWidth - sc.clientWidth,
      };
    },
    { scroller, cell, scroll },
  );
}

/**
 * What a pinned first column does to a control that is *not* in a pinned row —
 * a control in the accounts drawer — at a given horizontal scroll offset.
 *
 * `clearOfPin` below compares x-extents, which is the right question for a
 * control sharing a row with the pin. It is the wrong one in the drawer row: a
 * drawer control scrolled off the region's left edge has the same
 * x-relationship to the pin as one buried under it, so an x-only measure calls
 * both "occluded". The pinned cells sit in other rows' vertical bands, so only
 * a 2-D intersection tells the two apart.
 *
 * `xOverlap` and `inRegion` come back beside `covered` so a caller can prove
 * the offset it chose was one where the pin *could* have painted over the
 * control — same x-band, control on screen — rather than one where `covered: 0`
 * was true for want of anything to measure.
 *
 * Only the region's own table counts as a pin. `.log--sticky-col` is a
 * descendant selector, so a table nested inside a drawer row picks the rule up
 * too and its first column is sticky as well — sticky within its own scroller,
 * which is harmless, but not the pin under measurement. Counting it would let
 * `covered: 0` come out true for a reason that has nothing to do with the
 * column this measures.
 */
export async function coveredByPin(
  page: Page,
  scroller: string,
  control: string,
  scrollLeft: number,
) {
  return page.evaluate(
    ({ scroller, control, scrollLeft }) => {
      const sc = document.querySelector(scroller) as HTMLElement;
      sc.scrollLeft = scrollLeft;
      const r = (sc.querySelector(control) as HTMLElement).getBoundingClientRect();
      const s = sc.getBoundingClientRect();
      const area = r.width * r.height;
      const xOver = (a: DOMRect) =>
        Math.max(0, Math.min(r.right, a.right) - Math.max(r.left, a.left));
      const yOver = (a: DOMRect) =>
        Math.max(0, Math.min(r.bottom, a.bottom) - Math.max(r.top, a.top));
      // Every pinned cell of this table, not only the row above: which row a
      // drawer control ends up adjacent to is a layout outcome, not something
      // to assume. `:scope >` keeps a nested table's own sticky column out.
      const table = sc.querySelector("table") as HTMLElement;
      const pins = Array.from(
        table.querySelectorAll(":scope > tbody > tr > td:first-child"),
      )
        .filter((c) => getComputedStyle(c).position === "sticky")
        .map((c) => c.getBoundingClientRect());
      return {
        covered: pins.reduce((acc, p) => acc + xOver(p) * yOver(p), 0) / area,
        xOverlap: Math.max(0, ...pins.map((p) => xOver(p) / r.width)),
        inRegion: (xOver(s) * yOver(s)) / area,
      };
    },
    { scroller, control, scrollLeft },
  );
}

/**
 * How much of a control is left clear of the pinned first cell in its own row,
 * as a fraction of the control's own width, with the region driven fully right.
 * This is the property the pin has to buy: the name and the control it names
 * both readable at the same time.
 */
export async function clearOfPin(page: Page, scroller: string, control: string) {
  return page.evaluate(
    ({ scroller, control }) => {
      const sc = document.querySelector(scroller) as HTMLElement;
      sc.scrollLeft = sc.scrollWidth;
      const el = sc.querySelector(control) as HTMLElement;
      const f = el.getBoundingClientRect();
      const pin = (
        sc.querySelector("tbody tr:first-child td:first-child") as HTMLElement
      ).getBoundingClientRect();
      return (f.right - Math.max(f.left, pin.right)) / f.width;
    },
    { scroller, control },
  );
}

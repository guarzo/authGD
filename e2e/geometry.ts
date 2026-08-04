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
      };
    },
    { scroller, cell, scroll },
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

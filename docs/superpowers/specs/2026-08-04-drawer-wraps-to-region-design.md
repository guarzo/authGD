# Design — the accounts drawer wraps to the scroll region, not to the table

Date: 2026-08-04
Status: accepted

## Problem

`disclosure.tsx` (`as="row"`) renders the open drawer as its own row: `<tr
class="drawer-row"><td colSpan={COLUMN_COUNT}>`. That cell is as wide as the
accounts table, and the accounts table is wide because it holds eight columns
of tabular data. `.drawer__controls` is `display: flex; flex-wrap: wrap`, but
the flex line box it wraps within is the table's width, not the viewport's, so
wrapping never fires.

Measured at a 320px viewport (`e2e/probe.spec.ts`, since deleted):

| | value |
|---|---|
| scroll region | 286px |
| accounts table | 967.8px |
| max `scrollLeft` | 682px |
| `.drawer__controls` | 943.8px |
| `save note` content-x | 529.3px |

So an admin who opens a row to write a note must scroll the accounts table
332px right (`529.3 + 88.9 − 286`) to reach a field with no tabular reason to
be there. `save note` is the furthest-right control on the page.

The prior session's remembered figures — 988.8px table, 703px `maxScrollLeft`,
note controls "about 380px in" — were all slightly wrong. The numbers above
are from assertions, not memory.

This is pre-existing, introduced by PR #59 when the drawer moved out of the
name cell into its own row. Neither #61 nor #62 made it worse.

## Decision

Give the drawer a definite width equal to the scroll region, using a container
query, and pin it to the region's left edge:

```css
.scroller:has(.drawer) {
  container-type: inline-size;
}

.drawer {
  width: calc(100cqi - 2 * var(--s-3));
  position: sticky;
  left: var(--s-3);
}
```

Three things this rests on, each measured rather than assumed:

1. **The container goes on `.scroller`, not `.scroller-frame`.** `.scroller`
   has a 1px border, so the frame's inline size is 2px wider than the
   scrollport. Measured: a frame-hosted container produced a 288px drawer in a
   286px region.

2. **The width subtracts the cell's own padding.** `.log--dense td` has
   `var(--s-3)` inline padding, so a bare `100cqi` overflows its cell by 24px.
   Measured at 1280px: table 1198 → 1222, `maxScrollLeft` 0 → 24. That is a
   fix inventing horizontal scroll on a viewport that had none. Subtracting the
   padding leaves desktop byte-identical to today.

3. **`left` matches the padding**, so the 12px gutter survives the pinning and
   the panel stays aligned with the table's own cell padding at every offset.

Scoped with `:has(.drawer)` rather than applied to `.scroller` bare: the class
is shared with the audit, sync, and account pages, and none of them need
inline-size containment. `globals.css:497` already uses `:has()` to narrow a
scroller rule this way.

### Correction found during implementation

A third rule is needed, which the measurements above did not predict:

```css
.drawer__crew {
  min-width: 0;
}
```

`.drawer` is `display: grid`, and grid items floor at `min-width: auto` — their
min-content. `.drawer__crew` holds the crew table's own nested `Scroller`,
whose min-content is the crew table itself: 372.5px at a 320px viewport. That
floor sized the drawer's grid column, so the panel was 262px wide with a
372.5px column inside it, `.drawer__controls` stretched to 372.5px, and
`freeze`'s right edge landed 4.3px outside the 286px region.

The prototype missed this because its variant put `container-type` on *every*
`.scroller`, including the crew `Scroller` nested inside the drawer.
Inline-size containment zeroes that scroller's intrinsic contribution, which is
what produced the 262px column the tables above record. The shipped rule is
scoped with `:has(.drawer)`, so the crew scroller is not contained and the
floor returns. Zeroing it explicitly hands the overflow to the `Scroller`,
which is what a `Scroller` is for — and is the state the accepted screenshot
was actually taken in.

Four alternatives were checked and produce identical geometry
(`.drawer__crew > *`, `.drawer > *`, an unscoped `.scroller` container, and
`.drawer .scroller`); this one targets the offending element and leaves
`.drawer__controls`' own min-content intact.

The lesson worth keeping: a prototype whose selectors differ from the shipped
selectors can measure a layout nobody will ship. The numbers in this document
were re-verified against the shipped CSS and reproduce exactly.

## What it costs the pin

PR #61 concluded the pinned first column is worth keeping with a drawer open,
resting partly on the pin covering 0% of every drawer control at every scroll
offset. That conclusion survives, and is now measured under a condition where
it could have failed.

Measured at 320px with the fix, using a 2-D area intersection against every
sticky first cell of the outer table:

| control | `covered` | `xOverlap` | `inRegion` |
|---|---|---|---|
| `Set Zed to blue` | 0 | 0.093–0.097 | 1 |
| `freeze Zed` | 0 | 0.831–0.834 | 1 |
| `Note for Zed` | 0 | 0.333–0.334 | 1 |
| `save note for Zed` | 0 | 0 | 1 |

at `scrollLeft` 0, 341, and 682.

`freeze` is the load-bearing row: 83% of its width sits inside the pin's
x-band, on screen, and still 0% of its area is covered. An x-extent-only
comparison would have reported that control as 83% occluded. The pinned cells
sit in other rows' vertical bands, so only the 2-D measure tells "under the
pin" apart from "scrolled past the pin".

`inRegion: 1` throughout is the other half of the claim: every `covered: 0`
above is true because the pin does not paint over the control, not because the
control was off-screen and there was nothing to measure.

## What it costs in height

At 320px the drawer's usable width becomes 262px, which the tier group and
Cryo cannot share, so the controls stack three deep instead of one.

| viewport | controls height | row → crew list |
|---|---|---|
| 320 | 76.7 → 217.6 | 126.7 → 267.6 |
| 390 | 76.7 → 145.8 | 126.7 → 195.8 |
| 768 | unchanged | unchanged |
| 1280 | unchanged | unchanged |

The crew list moves 141px further from the row that opened it, at 320px only.
That is the accepted trade: vertical distance on a page that scrolls
vertically anyway, in exchange for removing 332px of horizontal scroll inside
a nested scroll region.

The alternative measured — dropping the drawer cell's horizontal padding to
give the panel the full 286px — buys back 69px of that height, but makes the
drawer flush to the scroller's border at *every* width, including desktop,
where nothing was wrong. Rejected: it changes desktop to fix 320px.

`.note-form .field`'s `min-width: 12rem` (192px) was checked rather than
assumed. At 262px it fits, with `save note` beside it on the same line; the
save button wraps its own label to two lines. The tier button group (168.3px)
and the freeze/confirm pair (77px) each fit alone but not together — 168.3 + 32
+ 77 = 277.3px against 262px available — which is what produces the third line.

Also rejected: tightening `.drawer__controls`' group gap from `--s-6` (32px) to
`--s-4` (16px) so tier and Cryo fit together. That lands at 261.3px against
262px available — a 0.7px margin, which one longer tier word would erase.

## Testing

`e2e/admin.spec.ts` gains one test at 320px that asserts, with a drawer open:

- every drawer control is reachable without horizontal scroll — content-x plus
  width within the region;
- `coveredByPin` returns 0 for each of them at `scrollLeft` 0, mid, and max;
- `inRegion` is 1 at those offsets, so the zeros are not vacuous;
- at least one pinned cell exists, so the zeros are not vacuous the *other*
  way. `coveredByPin` sums over the sticky first cells it finds; with none
  found, every `covered` is 0 and `inRegion` is still 1, so the whole loop
  would pass against a table that had lost its pin entirely. `inRegion` alone
  does not close this — it answers "is the control on screen", not "is there a
  pin to be under";
- the accounts table's own width and `maxScrollLeft` are unchanged, proving the
  drawer no longer contributes to the table's width.

`coveredByPin` is the helper PR #61 adds to `e2e/geometry.ts`. This branch was
written against an unmerged #61 and carries a verbatim copy of it. See
"Coordination".

## Coordination

Branched from `main` at bec6ca9, then rebased onto bb08765 after PR #61
`fix/pin-stays-with-drawer-open` merged.

The three overlapping files behaved as predicted, and the prediction is worth
recording because it was the point of the copy strategy:

- `e2e/geometry.ts` — both branches add `coveredByPin`. This branch's copy was
  byte-identical to #61's, comment included, inserted at the same position
  between `pinGeometry` and `clearOfPin`. Git merged it **silently**: no
  conflict, one copy of the function, and `admin.spec.ts` imports it once. Had
  the copy drifted by so much as a comment word, this would have been a
  conflict inside a helper both branches' tests depend on.
- `e2e/admin.spec.ts` — conflicted on the import block only (#61 added
  `BASE_URL`). Resolved by keeping it. Both branches' tests survive; #61's "an
  open drawer does not widen the shared first column" and this branch's
  320px test sit adjacent.
- `src/app/globals.css` — conflicted inside `.drawer`'s leading comment. `main`
  had renamed the component reference (see below) while this branch rewrote the
  comment around it. Resolved by keeping the expanded comment and adopting
  `main`'s reference.

### The component was renamed upstream

`row-disclosure.tsx` is gone; `disclosure.tsx` replaces it with an `as` prop —
`as="details"` (the default, used by `admin/sync/page.tsx`) and `as="row"` (used
by `admin/accounts/page.tsx`). This matters to the `:has(.drawer)` scoping,
which was written when only one component could produce a `.drawer`: the
`details` branch renders a bare `<div id={id}>` with **no** `.drawer` class, so
`.drawer` still has exactly one renderer and the container rule still applies to
exactly one scroller. Checked rather than assumed. If a future change gives the
`details` branch the `.drawer` class, this rule starts containing the sync
page's scroller too, and the scoping needs revisiting.

## Out of scope, noted again

`.log--sticky-col` is a descendant selector, so the crew table nested inside a
drawer row picks the sticky-first-column rule up too — its Name column is
sticky within its own scroller, with the hairline and opaque ground that come
with it. Nothing chose this, and it already cost one round of debugging in
`coveredByPin`. This work does not touch those selectors, so it stays unfixed.

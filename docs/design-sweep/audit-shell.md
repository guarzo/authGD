# audit — the shell and the shared primitives

Register: product. Surface: `layout.tsx`, `admin/layout.tsx`, everything in
`src/app/_components/`, and all 3,331 lines of `src/app/globals.css`.

This surface is in good shape. Most of what I set out to check turned out to be
already correct and already argued, and the verification is recorded below the
findings rather than padded into them. Six findings, worst-first.

## Findings

### 1. The pinned first column hides the focus ring on body-row controls

- **Severity:** serious
- **Where:** `src/app/globals.css:1129-1147` (the `scroll-margin-left` rules,
  scoped to `thead th` only), against `src/app/globals.css:1155-1167` (the pin)
  and `src/app/globals.css:3111-3113` / `3289-3292` (the responsive retunes)
- **Cost:** An admin on `/admin/accounts` who Shift+Tabs back from a row's
  Actions buttons to that row's Discord `unlink` button lands on a control
  parked flush against the left edge of the scrollport, underneath the pinned
  name column, so nothing on screen says which control is focused on the one
  table where the wrong press deroles the wrong person.
- **Principle:** WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum). Also
  PRODUCT.md's "derole, don't boot", which is the reason the pin exists at all.
- **Fix:** The vertical axis is handled for every control
  (`.log--sticky-head :is(a, button, summary, input, .row-toggle)` at
  `globals.css:1125-1127`); the horizontal axis is handled only for header
  links. Widen the two horizontal selectors to cover body cells, keeping the
  per-table figures and the three responsive retunes in step:

  ```css
  .log--audit.log--sticky-col
    :is(thead th, tbody tr:not(.drawer-row) > td):not(:first-child)
    :is(a, button, summary) {
    scroll-margin-left: 12.25rem;
  }

  .log--dense.log--sticky-col
    :is(thead th, tbody tr:not(.drawer-row) > td):not(:first-child)
    :is(a, button, summary) {
    scroll-margin-left: 10rem;
  }
  ```

  Note what the existing evidence does and does not cover. `admin.spec.ts:937`
  proves the vertical case with rect-vs-rect assertions. `admin.spec.ts:1146`
  ("no pinned cell paints over the drawer") proves that *drawer-row* controls
  are clear of the pin's x-band at every scroll offset, which is true and stays
  true, because the drawer row is excluded from pinning. Neither covers a
  control in a pinned row's own cells being scrolled leftward into the pin by
  sequential focus navigation. The reachable path is concrete: the accounts row
  has tab stops in column 1 (`.row-toggle`, itself pinned and safe), column 5
  (`ConfirmSubmit` "unlink", `accounts/page.tsx:534-543`) and column 10 (the
  Actions `btn-row`, `accounts/page.tsx:614+`), and reaching Actions requires
  scrolling right far enough that column 5 is off-screen left.

### 2. The header bar renders a third hit-target size, and its two neighbours disagree by 5px

- **Severity:** moderate
- **Where:** `src/app/globals.css:413-423` (`.shell__nav a`),
  `src/app/globals.css:392-403` (`.shell__signout`, whose comment claims
  parity), `src/app/globals.css:1622-1632` and `1771-1777`
  (`.btn--quiet` / `.btn--micro`), markup at
  `src/app/_components/ui.tsx:114-171`
- **Cost:** On every route in the app except `/login`, hovering along the header
  paints a 33px fill under each nav link and a 28px fill with a border under the
  sign-out beside it, so the one row of controls every page shows reads as two
  unrelated kinds of thing rather than one bar.
- **Principle:** DESIGN.md, "There are **two** sizes and no others", and
  PRODUCT.md principle 1 (play it straight). The measured heights are a third
  size, on the most-seen surface in the product.
- **Fix:** Measured, not assumed. `.shell__nav a` declares no `min-height`; it
  is a blockified flex item of the `inline-flex` `.shell__navitem`, its
  font-size is `--t-label` (11px) from the label register at
  `globals.css:268-284`, `line-height` is the body's 1.55, and its padding is
  `var(--s-2) var(--s-3)`, so 17.05 + 16 = **33.05px**. The sign-out is
  `btn btn--quiet btn--micro`: `min-height: 1.75rem` wins over a 25.45px content
  box, so **28px**. Horizontal padding is 12px against 8px on top of that.

  The `.shell__signout` comment is right about the type (both are 11px mono
  uppercase at the quiet colour) and wrong about the box, and the box is what
  the hover fill draws. Bring the link to the in-row grade without disturbing
  the `[aria-current]::after` underline, which is inset to the current 12px:

  ```css
  .shell__nav a {
    display: inline-flex;
    align-items: center;
    min-height: 1.75rem;
    padding: var(--s-1) var(--s-3);
  }
  ```

  If the bar should instead be a 36px standalone grade, apply that to both and
  say so in DESIGN.md; the one outcome to avoid is the current third value that
  neither document names.

### 3. `/admin/sync` moves under the reader every 30 seconds below 40rem

- **Severity:** moderate
- **Where:** `src/app/_components/relative-time.tsx:20-52`,
  `src/app/admin/sync/page.tsx:585-598` and `429-440`,
  `src/app/globals.css:919-940` (`.log--runs { width: 100%; max-width:
  max-content }`), `src/app/globals.css:3195-3222` (the 40rem block releases
  `min-width` but not `max-width`)
- **Cost:** An admin on a phone reading an expanded failed run's error string
  has the runs table's column widths change under them when the ticker turns
  "9m ago" into "10m ago", which is the exact motion `/admin/sync`'s
  no-polling rule was written to prevent.
- **Principle:** none directly. It contradicts the settled decision that
  `/admin/sync` does not poll, on its own terms rather than by re-opening it.
- **Fix:** Reserve the column, using the device the account page already uses.
  `globals.css:2944-2961` gives `.push > .ago` a `min-width: 7rem` for exactly
  this reason and documents it. Add the equivalent inside the 40rem query:

  ```css
  .log--runs td:first-child .ago {
    display: inline-block;
    min-width: 6rem;
  }
  ```

  Two things this is *not*. It is not a hydration mismatch: `initial` is the
  server's string and `tick()` only runs inside `useEffect`, so the first paint
  matches the HTML, and every call site passes `formatAgo(iso, now)` computed
  server-side (`account/page.tsx:86`, `sync/page.tsx:336`, `433`, `592`). And
  the swap being unannounced is right, not a defect: the sync page mounts up to
  42 of these and a live region would read all of them. The strip is safe too,
  because `.strip__head` gives every track after the name a fixed width
  (`globals.css:2456-2470`). The runs table is the one place the tick reflows.

### 4. DESIGN.md describes a `.st` defect that no longer exists

- **Severity:** minor
- **Where:** `DESIGN.md:142` and `docs/design-sweep/PREAMBLE.md:103-106`, against
  `src/app/globals.css:1352-1362`
- **Cost:** Eleven reviewers in this sweep were told a live defect exists where
  the stylesheet is already correct, and the next person who trusts DESIGN.md's
  table over the stylesheet on some other row will be wrong in a direction
  nobody checks.
- **Principle:** none.
- **Fix:** `.st` declares `font-weight: 600` at `globals.css:1358`, and the
  label-register comment at `globals.css:236-240` records the fix. Delete the
  parenthetical at `DESIGN.md:142` and the "known open defect" paragraph in the
  preamble. I opened every `font-weight` declaration in the file rather than
  grepping: the register block at `268-284` carries 12 selectors, and `.btn`,
  `.tier` and `.st` each declare 600 for themselves, deliberately outside it.

### 5. Table sort links are a 17px pointer target inside a 41px cell

- **Severity:** minor
- **Where:** `src/app/globals.css:759-773` (`.log th`, `.log th a`), used by
  `/admin/accounts` (four of ten headers) and `/admin/audit`
- **Cost:** An admin re-sorting the accounts table has to hit a 17px-tall line
  box floating in a 41px-tall header cell, and a miss lands on the `th` and does
  nothing, which reads as a dead click on the control the `.log__sortable` glyph
  was added to advertise.
- **Principle:** WCAG 2.2 SC 2.5.8 is *met*, but only through the spacing
  exception (the nearest other target is 24px away vertically and a full cell
  padding away horizontally). The stronger objection is DESIGN.md's own floor:
  28px is the smallest target this system says it has.
- **Fix:** Grow the anchor's box without growing the row, so the header height
  and the `scroll-margin-top: 3rem` figure both stay valid:

  ```css
  .log th a {
    display: inline-block;
    padding-block: 0.22rem;
    margin-block: -0.22rem;
  }
  ```

  That is 24.09px of target at zero net layout cost. Making the anchor fill the
  cell would be better still but is unsafe under `.log--audit`'s
  `table-layout: fixed` with `nowrap` cells.

### 6. The reduced-motion comment states a mechanism the stylesheet does not implement

- **Severity:** minor
- **Where:** `src/app/globals.css:2073-2077`, against `206-215` and `1585-1596`
- **Cost:** Nothing today. It is a trap for the next author: the comment says
  the collapse "freezes it on the first frame", so anyone adding
  `animation-fill-mode: both` to `btn-pulse`, or adding `animation-fill-mode` to
  the global collapse block, will believe they are preserving behaviour while
  leaving the in-flight dot at opacity 0.3 and scale 0.85 for reduced-motion
  users.
- **Principle:** none.
- **Fix:** The collapse sets `animation-duration: 0.01ms` and
  `animation-iteration-count: 1` and nothing else; with `animation-fill-mode`
  at its initial `none`, the element reverts to its *unanimated* computed style,
  not to the 0% keyframe. That is why both `btn-pulse` (which starts at 0.3) and
  `link-pending-pulse` (which starts at 1) are safe. Correct the comment to say
  so, and note that the 1 -> 0.35 -> 1 ordering is a good idea for the animated
  case but is not what saves the reduced-motion case.

## What is good and must survive

**The contrast record is accurate, and I checked it by computing rather than by
reading the table.** OKLCH to OKLab to linear sRGB to relative luminance to the
WCAG ratio, in Node. Pairs verified against their claims:

| Claim | Site | Claimed | Computed |
| --- | --- | --- | --- |
| `--signal-warn` on void / hull / hull-hi / hovered row | `globals.css:45-46` | 9.43 / 8.54 / 7.44 / 8.41 | exact |
| `--rule-strong` on void / hull / hull-hi | `globals.css:15-17` | 4.11 / 3.72 / 3.24 | exact |
| `--rule` on void / hull / hull-hi | `globals.css:653` | 1.76 / 1.59 / 1.39 | exact |
| `--ink-faint` on `--hull-hi` (disabled) | `globals.css:1547` | 4.85 | exact |
| `--signal-bad` on `--hull-hi` | `globals.css:1470` | 4.81 | exact |
| `--gold` vs `--ink-dim` (active vs inactive tab) | `globals.css:438` | 1.18 | exact |
| `--ink` vs `--ink-dim` | `globals.css:442` | 1.68 | exact |
| nav rest / hover / active on `--hull` | `globals.css:437` | 8.67 / 10.21 / 12.67 | exact |
| `--rule-strong` vs `--ink-dim` (chip borders) | `globals.css:1697` | 2.33 | exact |
| scroller fade vs ground | `globals.css:701-704` | 2.55 | 2.81 |
| `.tier--pending` `--ink-dim` on a hovered row | tier block | 5.67 | 6.48 |
| `--ink-faint` tier variant on `--void` | tier block | 4.56 | 5.16 |

The three that differ all differ in the safe direction: the code understates its
own margin. The last two are the same arithmetic slip, using full `--hull-hi`
where the hover is `color-mix(..., 55%, transparent)`. Not worth a finding; worth
not "correcting" the numbers downward later.

**`themeColor` matches the real ground exactly.** `layout.tsx:52` declares
`#080f1f`; `oklch(0.17 0.035 264)` computes to `#080f1f`. Ratio 1.002, which is
rounding. The two are in sync and should be changed together if either moves.

**The global focus ring survives on every ground it lands on, including the two
named in the brief.** `--gold` measures 11.27 on `--void`, 10.21 on `--hull`
(which is what `.log th` paints, so the sticky header row), 8.89 on `--hull-hi`
(the hover fill and the `.btn` ground), and 10.05 on the flattened hovered-row
mix at `globals.css:1189`. All far past 3:1. The `outline-offset: 2px` also keeps
it legible on the two gold-filled controls (`.btn--primary`, `.skip:focus`),
because the offset gap paints the page ground, not the button.

**`prefers-reduced-motion` coverage is genuinely complete.** One block at
`globals.css:206-215`, `*, *::before, *::after`. There are exactly three
`animation:` declarations (1585, 2088, 2227) and nine `transition:`
declarations in the file, no `animation-delay` or `transition-delay` anywhere,
no `!important` outside that block, and no `scrollIntoView`, `behavior:
"smooth"` or Web Animations call in `src/`. Nothing escapes it. The one
correction is finding 6, which is about a comment, not about coverage.

**`.visually-hidden` is safe where this app nests it.** `globals.css:3013-3020`
is `position: absolute` with `width/height: 1px`, `overflow: hidden`,
`clip-path: inset(50%)` and `white-space: nowrap`, and with `top`/`left` left
`auto` it takes its static position rather than flying to a positioned
ancestor's origin. That is what makes the nesting cases benign: `.scroller` is
`position: relative` specifically to contain it (`globals.css:626-635`), the
sticky table cells are positioned and contain it, and the shell badge's copy at
`ui.tsx:145` has no positioned ancestor but sits at an in-viewport static
position, so it cannot stretch the document. Keep the auto offsets. Adding
`top: 0; left: 0` to "tidy" it is what would move these into their containing
blocks' origins.

**The skip link reaches `#main` on every route that has one.** Nine `<main
id="main" tabIndex={-1}>` sites, and every `SiteHeader` render site is one of
them: `account`, `payouts`, `payouts/new`, `payouts/[id]`,
`payouts/[id]/not-found`, `not-found`, `error`, plus the three admin pages that
get their header from `AdminNav` via `admin/layout.tsx`. `/login` is the only
`<main>` without the id, and it renders no header, so there is no dangling link.

**Measured hit targets, from the CSS.** `.btn` 36px, `.btn--micro` 28px,
`.btn--quiet` 28px, `.row-toggle` 28px, `.json > summary` 28px, `.field` 36px,
`.strip__disc > summary` about 39.4px. Every one clears SC 2.5.8's 24px. The two
exceptions to the two-size rule are findings 2 and 5.

**`Notice`'s reserved empty slot.** `ui.tsx:249-260` renders `notice-slot` when
empty so the live region exists before the message does. This is the difference
between an announced error and a silent one, and the `&&` shape that defeats it
is the obvious "simplification" a later pass would reach for.

**`FocusHeading` is correct and its docblock is right about the tradeoff.** It
is scoped to the three boundaries (`error.tsx`, both `not-found.tsx`), which is
where focus actually falls to `<body>` on a soft navigation. It is not on
ordinary pages, and it should not be moved there.

## Could not evaluate

- **Whether a `Notice` that arrives with a full document load is announced.**
  The reserved-slot argument holds for `useActionState` returns, where the
  region pre-exists the text. For any call site whose message arrives via a
  redirect or a fresh render, the region is born holding its text and most AT
  will not announce it. I did not trace all of the call sites, since they belong
  to other reviewers' surfaces. Settling it means listing which `Notice`s come
  back through a navigation rather than through an action result.
- **WebKit's application of `scroll-margin` during sequential focus
  navigation.** `globals.css:1122-1124` already flags this as untested, and it
  bears equally on finding 1. Settling it needs a real Safari or a WebKit
  Playwright run, which the sweep excludes.
- **Rendered glyph metrics.** Every hit-target figure above is computed from
  declared `font-size`, `line-height`, padding and `min-height`. Archivo and IBM
  Plex Mono are self-hosted by `next/font`, so the fallback-swap case does not
  arise, but I did not measure a rendered box.

## Contested

Nothing. Every settled item I touched held up under measurement: the explicit
`--ink-faint` on disabled controls is worth 4.85 where the old 65% opacity was
worth 2.88 on a hovered row, `.btn--quiet` at 28px genuinely removes a third
size rather than inventing one, and `--rule-strong`'s lightness is doing exactly
the 3:1-on-three-grounds job its comment claims. Finding 2 is not a challenge to
the two-sizes rule; it is a report that the header does not yet obey it.

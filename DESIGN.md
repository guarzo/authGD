# Design

> **Running a fork?** This is the design record of the *reference deployment* —
> its theme, palette, and artwork. The colour and accessibility work (contrast
> ratios, colour-blind separation, focus rings, reduced motion) is worth keeping
> whatever you rename things to; the theme itself is one corp's taste. See the
> README's "Making it yours" for what is configurable and what needs a file
> replaced.

## Visual Theme

**Flight operations at night.** A 1960s mission-documentation system — ruled forms,
typed telemetry, a printed seal — rendered for a dark room.

The scene that fixes the theme: *an EVE player alt-tabbed at 1am, the monitor the only
light in the room, checking whether an alt's token still works before a fleet forms.*
That forces dark. It does not force black: the ground is the mission patch's own navy,
so the surface belongs to the brand rather than defaulting to a void.

The deliberate distance from the obvious: this is **not** a sci-fi HUD. No cyan, no
glow, no clipped corners, no scanlines. It is paper, ink, and rules — the flight log,
not the cockpit display. Structure comes from hairlines and typographic hierarchy, not
from boxes and shadows.

## Color

**Strategy: Committed.** Navy carries the surface. Gold is the single emphasis colour
and stays scarce. Everything is OKLCH, and every neutral is tinted toward the navy or
gold hue — nothing is pure grey, nothing is `#000` or `#fff`.

### Ground and structure

| Token | Value | Use |
|---|---|---|
| `--void` | `oklch(0.17 0.035 264)` | Page ground. Patch navy, taken deep. |
| `--hull` | `oklch(0.22 0.04 264)` | Panels, table headers, inset regions. |
| `--hull-hi` | `oklch(0.27 0.042 264)` | Row hover, raised controls, pressed states. |
| `--rule` | `oklch(0.36 0.035 264)` | Hairlines. The primary structural device. |
| `--rule-strong` | `oklch(0.56 0.05 264)` | Section boundaries, control borders. Lightness is set by WCAG 1.4.11: it clears 3:1 against `--void`, `--hull`, and `--hull-hi`, so a control's edge is identifiable on every ground it can sit on. |

### Ink

| Token | Value | Use |
|---|---|---|
| `--ink` | `oklch(0.94 0.012 85)` | Primary text. Warm cream, tinted to gold. |
| `--ink-dim` | `oklch(0.78 0.015 85)` | Secondary text, data cells. |
| `--ink-faint` | `oklch(0.66 0.02 264)` | Labels, metadata, timestamps. |

### Signal

Gold is identity and emphasis. The three signals are semantic and never decorative.

| Token | Value | Use |
|---|---|---|
| `--gold` | `oklch(0.83 0.155 88)` | Brand mark, active nav, primary action, Member tier. |
| `--gold-dim` | `oklch(0.72 0.14 84)` | Gold borders, hover on gold surfaces. |
| `--signal-ok` | `oklch(0.76 0.13 158)` | Healthy token, present on map, linked. |
| `--signal-warn` | `oklch(0.80 0.15 50)` | Needs re-auth, scope shortfall, cryo (admin table only — an admin scans for it; the member's own account page reads cryo in `--ink-dim` instead, since it's a pause the member asked for, not a fault). Hue 50 rather than the 70 this started at: at 70 the warn signal sat 18° from `--gold`/`--tier-member` at near-identical chroma and lightness — 0.057 apart in OKLab, not enough to tell a gold Member badge from an amber CRYO token two columns away in the same mono uppercase. 50 nearly doubles that to 0.104 while holding 0.146 from `--signal-bad`. Warn remains nearer to gold than to bad, deliberately: equalising the two means rotating to about hue 37, buying separation from identity by spending it on failure, and mistaking a warning for an error is the worse confusion. The bar is legibility against gold, not equidistance. |
| `--signal-bad` | `oklch(0.68 0.19 25)` | Dead token, failed sync, destructive action. |

### Tier colours

Distinguishable by lightness as well as hue, so they survive deuteranopia and
protanopia. Always paired with the tier's name in text — the configured label, not
the enum value, so the pairing holds however a deployment renames its tiers.

| Tier | Token | Value |
|---|---|---|
| Member | `--tier-member` | `oklch(0.83 0.155 88)` (gold) |
| Associate | `--tier-associate` | `oklch(0.72 0.13 245)` |
| Alumni | `--tier-alumni` | `oklch(0.76 0.13 158)` |

Pending has no hue of its own. It renders achromatic in `--ink-dim`: the three
colours above are tuned as a set, and "not yet approved" reads better as an
absence of colour than as a fourth one. The same treatment covers a tier value
the UI does not recognise, which should read as unknown data rather than borrow
a real tier's colour.

### Rules

- Colour is never the only carrier of meaning.
- Saturated colour occupies well under 10% of any screen. The gold in particular is
  rationed: one primary action per view, plus the mark.
- No gradients on text, ever. No decorative gradients at all.

## Typography

Two families, loaded through `next/font/google` (self-hosted at build, no runtime
request, no npm dependency).

- **Archivo** — display and UI. A grotesque with real weight range and a genuinely
  narrow variant. Headings run at weight 700 with tight tracking; the mission-patch
  furniture uses uppercase with wide tracking.
- **IBM Plex Mono** — all data. Character IDs, timestamps, tier names, token status,
  counts, JSON details, and every small uppercase label. Chosen for its technical
  documentation register rather than its code register.

The split is the system's main typographic idea: **prose is proportional, state is
monospaced.** A user learns within one screen that monospace means "this is a value
the system computed."

### Scale

A hard jump at display sizes, and a deliberately tight ramp below `--t-h2`.

The tight half is worth stating plainly, because "ratio 1.25 minimum between
adjacent steps" is what this section used to claim and it has never been true of
the shipped scale: `--t-body`/`--t-data` is 1.07:1, and every step from
`--t-body` down to `--t-label` sits between 1.07 and 1.09. The step out of
`--t-h2` into `--t-body` is the exception at 1.47:1 — only the top of the scale
ramps at 1.25 or better. That is not drift to be corrected — a dense operational
screen wants many closely-spaced sizes so a table, its caption and its label can
each have their own without any of them shouting — but it does mean size alone
carries very little signal down here. What separates these steps is face
(proportional prose vs. monospaced state), weight, case and colour; the size
difference is a nudge on top of those, not the distinction itself. A new step
justified only by "it should be a bit smaller than the one above" is drift. One
justified by "this is a different *kind* of thing" is a step.

| Step | Size | Weight | Tracking |
|---|---|---|---|
| `--t-display` | `clamp(2.5rem, 6vw, 4rem)` | 700 | `-0.03em` |
| `--t-h1` | `clamp(1.75rem, 3vw, 2.25rem)` | 700 | `-0.02em` |
| `--t-h2` | `1.375rem` | 700 | `-0.01em` |
| `--t-body` | `0.9375rem` | 400 | `0` |
| `--t-data` | `0.875rem` | 400 | `0` (mono) |
| `--t-caption` | `0.8125rem` | 400 | `0` |
| `--t-detail` | `0.75rem` | 400 | `0` (mono or prose) |
| `--t-label` | `0.6875rem` | 600 | see below, uppercase (mono) |

`--t-caption` and `--t-detail` were named after the fact, not designed in: a
type-scale audit found both sizes already reused across three-or-more
unrelated components under raw `font-size` declarations (`.dim`, `.table-note`
and `.footnote` at `0.8125rem`; `.json`, `.detail`, `.filter-form__hint`,
`.strip__cadence` and `.strip__window` at `0.75rem`) before either had a name.
Repeated, undesigned use across the codebase is what makes a size a step
rather than drift — see "The label register" below for the same argument
applied to weight instead of size. A handful of sizes below `--t-label`
(`0.625rem` on the login page's configurable `BRAND_FOOTER` line, `0.5625rem`
on the header's subtitle) are true one-offs: each is used exactly once, for a
stated optical reason, and is commented in place in `globals.css` rather than
promoted here.

- Body prose caps at **68ch**.
- All numeric and tabular data uses `font-variant-numeric: tabular-nums`, so columns
  align and a changing value doesn't reflow its neighbours.

### The label register

Small mono uppercase is the most reused type in the system, and it is **one** style,
declared once in `globals.css` under `--- Label register ---` and applied by adding a
selector to that list. Weight is `600` for every one of them; a label that inherits
`400` because its rule simply never said is a bug, not a variant. The register and the
component are separate concerns: a component in the list keeps its own colour, spacing
and tracking, and nothing else about its type.

Tracking is the one property that legitimately varies, so it is tokenised by the job
the label is doing rather than left as a number at the call site:

| Token | Value | Use |
|---|---|---|
| `--track-value` | `0.08em` | In-row values and micro controls. |
| `--track-control` | `0.1em` | Button and badge labels. |
| `--track-label` | `0.12em` | Form and table labels. The register's default. |
| `--track-furniture` | `0.14em` | Section labels, the wordmark, mission furniture. |

`.btn`, `.tier` and `.st` carry the register's family, size and case but are
deliberately **not** in the shared list: they are components with their own states, and
their type belongs next to their behaviour. They take a tracking token and nothing
else. (`.st` used to leave weight to inherit, rendering at 400 while `.btn` and `.tier`
declared 600 — a real inconsistency, not a variant. It now declares its own explicit
`600` alongside the other two.)

The register is for **labels** — a fixed word naming a field. Small mono text that is
itself a value, or a value with a prose word attached ("next 14:32", "checked 20:25:25
UTC"), is not a label and does not join: uppercasing it changes copy, and the 600 would
set it apart from the sentence-case metadata it sits beside. Case is not the test — a
stamp may already be uppercase and still not be a label, exactly as `.btn` and `.tier`
are. The tell is `--track-value`: a component asking for the value tracking is telling
you what it holds.

## Layout

- **Spacing scale** (`--s-1` … `--s-9`): 4, 8, 12, 16, 24, 32, 48, 64, 96px. Rhythm
  comes from varying the step, not from repeating one padding value.
- **App shell.** A ruled header bar carrying the seal, the corp name, and nav. Content
  below in a single measured column; admin tables are allowed to run wider.
- **Nav membership is keyed to the viewer, not the section.** The bar offers every
  destination this viewer is *provably authorized* to reach — `Your account` always,
  `Operations` when they can read payouts, `Members`/`Audit log`/`Sync` when they are an
  admin — in one fixed order, broadest access first. Membership does not change as you
  walk between sections, so no destination is ever two hops away from a viewer who is
  entitled to it in one. Note that `isAdmin` and `tier` are independent, so an admin is
  not automatically a payouts reader and `Operations` is never unconditional in the admin
  bar. Where the session cannot be read — `error.tsx` is a client component, and a
  not-found boundary would change render mode if it called `cookies()` — the same rule
  runs on weaker evidence: the strongest membership the *path* alone proves, because
  offering a link that bounces the viewer straight back out is worse than not offering
  it. One item table, one order, one derivation: `src/app/_components/nav-items.ts`.
  The `admin` prop is a separate axis and stays keyed to the section (it drives the
  mark's destination, the `ADMIN` marker, and the nav's accessible name).
- **One column origin.** The page box is `--measure-page` on *every* route, so the H1's
  left edge, every section rule's origin, and the header's seal land on one vertical
  everywhere. Surfaces that want a narrower reading width cap their **contents**
  (`.page--narrow > :where(*)`), never the column — capping the column moved the whole
  page 144px sideways on a nav click.
- **No cards.** Structure is expressed with hairline rules and section headers. Two
  exceptions, both genuine objects on an empty field rather than containers for
  their own sake: the login panel, and `/payouts/new`'s form panel. Each is a short
  form with nothing else on the page to sit on, which without a ground reads as a
  settings row rather than the start of a mission. A third would mean this rule has
  stopped being true.
- **Section header** is the signature component: a mono uppercase label, then a
  hairline rule running to the container edge. It reads as a field on a printed form
  and costs one element.
- **Radii** are near-zero: `2px` on controls, `0` on rules and table edges. This is
  documentation, not software chrome.
- **Registration ticks.** Small L-shaped corner marks, like print register marks, on
  the login panel only. Used once, deliberately, not as a repeating motif.

## Components

- **Table** — the core primitive. Hairline row rules, `--hull` header with mono
  uppercase labels, no zebra striping, `--hull-hi` on row hover. Wide tables scroll
  inside a focusable, labelled region so keyboard users can reach the overflow.
- **Status token** — mono, uppercase, small, with a leading geometric glyph.
  Colour only when the state is actionable; neutral states stay in `--ink-dim`.
- **Tier badge** — the tier name in mono uppercase, on a low-chroma tint of its own
  hue, with a `1px` border in the full-chroma hue. A lock glyph when the tier is
  admin-pinned.
- **Button** — three grades. `primary` (gold ground, navy text, one per view),
  `default` (`--hull-hi` ground, `--rule-strong` border), `quiet` (text only, rule
  appears on hover). Destructive actions take `--signal-bad` on the border and text,
  never a filled red ground.
- **Quiet destructive** (`.btn--danger-quiet`) — a fourth thing, and the one
  exception to the rule above. A destructive action that is nonetheless an
  *ordinary* choice — unlinking one of your own characters, removing a
  participant from a payout — should not be the most saturated element on its
  page permanently, because that reads as a warning against making the choice at
  all (PRODUCT.md principle 4). So it rests at `.btn--quiet`'s `--ink-faint` and
  takes `--signal-bad` only on row hover, its own hover, or keyboard focus.
  Nothing is gated on hover: the label is fully legible at rest without the
  colour, so touch and keyboard users get the same reachable, visible control —
  the red is emphasis arriving with intent, not information withheld until a
  pointer shows up. Use it where a member or operator does this routinely; use
  full `.btn--danger` where the action is rare and irreversible.
- **Field** — `--void` ground inset into `--hull`, `--rule-strong` border, gold border
  on focus plus the global focus ring.

## Motion

- Transitions are 140ms on colour and border, 220ms on transforms, both on
  `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quint). No bounce, no elastic, no spring.
- Layout properties are never animated. Transform and opacity only.
- The only entrance animation in the system is the login seal, and it is a single
  opacity-and-scale settle.
- `prefers-reduced-motion: reduce` collapses every duration to `0.01ms` globally.

## Assets

Artwork by **Faoble**, not covered by the repository's MIT licence: usable and
redistributable in a fork as long as Faoble is credited (see `LICENSE`). A fork
that wants its own identity replaces all four — the two `BRAND_*_URL` ones by
configuration, the other two by overwriting the file.

- `public/brand/emblem.webp` — the corporation seal (navy, gold, cream). The identity
  mark, used large on login. Configurable: `BRAND_SEAL_URL`.
- `public/brand/mark.webp` — the same seal at header size, so the mark in the site
  header is not a 400px image scaled down to 34px. Configurable: `BRAND_MARK_URL`.
- `public/brand/hero.webp` — line art held at very low opacity as the login field's
  ground. Referenced by path from `globals.css`; not configurable.
- `public/brand/hero-account.webp` — the account page illustration, cut for the size
  it is drawn at. Referenced by path from the account page; not configurable.

## Focus and states

- Global focus ring: `2px` solid `--gold` at `2px` offset, on every interactive
  element, never removed. Against both `--void` and `--hull` it clears 3:1.
- The skip link is invisible until focused, then takes the `--gold` ground and
  `--void` text of a primary action. It is a focus surface rather than a fifth
  standing use of gold: nothing sees it unless it is the focused control.
- Disabled controls keep `opacity: 1` and take an explicit `--ink-faint`, rather than
  fading. An opacity fade moves with whatever ground it lands on: at 65% the disabled
  text measured 3.24:1 on `--void` but 2.88:1 on a hovered admin table row, under the
  3:1 floor exactly when the pointer is on the row. The explicit colour is 4.85:1 on
  `--hull-hi` and does not move. **Do not "simplify" this back to an opacity.**
- Hit targets: `36px` for standalone controls (`.btn`), `28px` for the in-row controls
  of the admin tables (`.btn--micro`, `.btn--quiet`, `.row-toggle`). Both clear the
  `24px` WCAG 2.5.8 (AA) minimum. The tables carry a control set on every row and
  cannot reach the `44px` AAA target without growing past a screenful, so density wins
  there and nowhere else. There are **two** sizes and no others: `quiet` is a colour
  grade, like `primary` and `default`, and does not carry a size of its own.

  The `28px` grade is scoped by the *reason* for it, not by the tag it lands in:
  it applies to rows that each carry a control set and are read many at a time.
  A disclosure drawer is **not** in-row for this purpose even though
  `Disclosure as="row"` renders a literal second `<tr>`. One drawer is open at
  a time, it spans the full table width, and nothing is competing with it for
  vertical space, so the density argument that buys the `28px` grade does not
  apply and its controls take `36px`. This is not a new rule so much as the one
  already in force: `e2e/sync.spec.ts`'s "a drawer's Re-run control sits at the
  standalone grade, not the in-row one" pins the `/admin/sync` drawer's Re-run
  control to the standalone grade and has been passing all along, and
  `payouts/[id]/notes-form.tsx`'s "Full 36px" comment above its `Submit` reasons
  the same way for a field in an
  operation's own panel. `/admin/accounts` is the surface that diverged.
  (Owner walkthrough 2026-08-07, ruling R1. Supersedes the flat two-grade
  reading recorded in `docs/settled-design-decisions.md`.)

  `.shell__nav a` used to be a third, undocumented size at ~33.05px — `padding:
  var(--s-2) var(--s-3)` plus the label register's line box, with no floor
  and no ceiling. It could not simply shrink to 28px or grow to 36px by
  changing that padding: the active tab's underline (`[aria-current]::after`)
  is inset `bottom: var(--s-1)` against the padding box, a fixed offset from
  the link's own bottom edge, and reducing `padding-block` (or setting an
  explicit `height`) pulls that edge — and the underline with it — up toward
  the label without moving the label itself. It now takes the same idiom
  `.btn` already uses for its own 36px floor: `display: inline-flex;
  align-items: center; min-height: 2.25rem`. That makes the link a flex
  container centred on its own text rather than a padding-sized box, so
  reaching 36px moves the *label* toward the middle of a taller box instead of
  moving the box's edge toward a fixed label — the gap between the label and
  the underline grew (measured: ~5.05px before, ~6.5px after) rather than
  closing. Standalone, because it is one destination per click, not a row's
  worth of controls competing for space — the same case that puts `.btn` at
  36px rather than 28px. `e2e/shell.spec.ts` pins both the 36px box and a
  minimum label-to-underline gap.

## Disclosure and parity

From the owner walkthrough of 2026-08-07. Both rules exist because a reviewer
reading the code cannot see the failure; only someone using the app can.

- **Rare destructive controls do not hold permanent width in a scanning table.**
  PRODUCT.md principle 3 makes scanning the primary act, and a control that is
  pressed once a month should not cost a column on every row for the other
  thirty days. Move it behind per-row disclosure. Two constraints on how: the
  cost hint stays hidden-always rather than reveal-on-arm (`confirm-submit.tsx:94-101`
  records why — the widening disarms the control it revealed for), and the
  drawer that receives the control takes the `36px` grade above, not `28px`.
  (Ruling R2.)

  `ConfirmCost` (`confirm-submit.tsx`) has a third `visibility` case beyond
  reveal-on-arm and hidden-always: `"visible"`, rendered plainly at rest,
  never hidden, no reveal step. This is NOT a relaxation of the `<td>`
  constraint above — the `<td>`-reflow case still needs hidden-always, for the
  reason already recorded — it is a different shape of control entirely. The
  payout page's Finalize and Unlock (`payouts/[id]/lifecycle-submit.tsx`) sit
  alone outside a table, so there is no neighbouring `<td>` for a revealed
  cost to widen, and the sentence they carry is accurate, wanted copy rather
  than an error — hiding it until arming (`"reveal"`) reads as a fault
  appearing, and hiding it always (`"hidden"`) was a straight R4 violation: no
  sighted operator ever read it. `"visible"` is for exactly this shape —
  a standing, self-contained lifecycle control with its own permanent caption
  — and stays distinct from the `<td>` case rather than replacing it.

- **Information may not live only in the assistive-tech channel.** Parity runs
  in both directions. The usual failure is a control with no accessible name;
  this codebase's failure is the inverse — a `role="status"` confirmation
  marked `.visually-hidden`, or an affordance named in `aria-label` and absent
  from the visible summary, so the sighted user is the one left guessing.
  `.visually-hidden` is for text that is *redundant* on screen (a heading level,
  a table caption already implied by layout), never for the only copy of a fact.
  If assistive tech is told something, the screen says it too. (Ruling R4.)

# Design

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
| `--gold` | `oklch(0.83 0.155 88)` | Brand mark, active nav, primary action, FlyGD tier. |
| `--gold-dim` | `oklch(0.72 0.14 84)` | Gold borders, hover on gold surfaces. |
| `--signal-ok` | `oklch(0.76 0.13 158)` | Healthy token, present on map, linked. |
| `--signal-warn` | `oklch(0.80 0.15 70)` | Needs re-auth, scope shortfall, cryo (admin table only — an admin scans for it; the member's own account page reads cryo in `--ink-dim` instead, since it's a pause the member asked for, not a fault). |
| `--signal-bad` | `oklch(0.68 0.19 25)` | Dead token, failed sync, destructive action. |

### Tier colours

Distinguishable by lightness as well as hue, so they survive deuteranopia and
protanopia. Always paired with the tier's name in text.

| Tier | Token | Value |
|---|---|---|
| FlyGD | `--tier-flygd` | `oklch(0.83 0.155 88)` (gold) |
| Blue | `--tier-blue` | `oklch(0.72 0.13 245)` |
| Green | `--tier-green` | `oklch(0.76 0.13 158)` |

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

Ratio 1.25 minimum between adjacent steps, with a hard jump at display sizes.

| Step | Size | Weight | Tracking |
|---|---|---|---|
| `--t-display` | `clamp(2.5rem, 6vw, 4rem)` | 700 | `-0.03em` |
| `--t-h1` | `clamp(1.75rem, 3vw, 2.25rem)` | 700 | `-0.02em` |
| `--t-h2` | `1.375rem` | 700 | `-0.01em` |
| `--t-body` | `0.9375rem` | 400 | `0` |
| `--t-data` | `0.875rem` | 400 | `0` (mono) |
| `--t-label` | `0.6875rem` | 600 | `0.12em`, uppercase (mono) |

- Body prose caps at **68ch**.
- All numeric and tabular data uses `font-variant-numeric: tabular-nums`, so columns
  align and a changing value doesn't reflow its neighbours.

## Layout

- **Spacing scale** (`--s-1` … `--s-9`): 4, 8, 12, 16, 24, 32, 48, 64, 96px. Rhythm
  comes from varying the step, not from repeating one padding value.
- **App shell.** A ruled header bar carrying the seal, the corp name, and nav. Content
  below in a single measured column; admin tables are allowed to run wider.
- **No cards.** Structure is expressed with hairline rules and section headers. The
  one exception is the login panel, which is a genuine object on an empty field.
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

Artwork by **Faoble**, used with permission and not covered by the repository's MIT
licence.

- `public/brand/seal.webp` — the Zoo Landers / Flygd seal (navy, gold, cream). The
  identity mark, used large on login.
- `public/brand/seal-sm.webp` — the same seal at header size, so the mark in the
  site header is not a 400px image scaled down to 34px.
- `public/brand/lander.webp` — line-art rendering of the lander. Used once, very low
  opacity, as the login field's ground.

## Focus and states

- Global focus ring: `2px` solid `--gold` at `2px` offset, on every interactive
  element, never removed. Against both `--void` and `--hull` it clears 3:1.
- The skip link is invisible until focused, then takes the `--gold` ground and
  `--void` text of a primary action. It is a focus surface rather than a fifth
  standing use of gold: nothing sees it unless it is the focused control.
- Disabled controls drop to 65% opacity and keep their text legible at 3:1.
- Hit targets: `36px` for standalone controls (`.btn`), `28px` for the in-row
  controls of the admin tables (`.btn--micro`). Both clear the `24px` WCAG 2.5.8
  (AA) minimum. The tables carry a control set on every row and cannot reach the
  `44px` AAA target without growing past a screenful, so density wins there and
  nowhere else.

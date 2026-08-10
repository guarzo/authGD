# `/login` — technical audit

`$impeccable audit` · register: **brand** · surface block 1

Screenshots read before source: `docs/design-sweep-2/shots/01-login.wide.png`,
`01-login.narrow.png`. Measurements below were taken in a headless Chromium
against a static harness that loaded the real `globals.css` and the real
markup of `src/app/login/page.tsx` at 1440×900, 390×844 and 320×800, including
the error state, which has no screenshot in the set. The harness and its copied
stylesheet were deleted; `git status` is clean of them.

## What the screenshots show, before any explanation

A 480px panel centred in 1440px of near-black, with two thin gold corner ticks
biting the top-left and bottom-right of its border. A 180px navy-and-gold seal,
the corp name at 64px in a heavy grotesque, a mono uppercase motto, then the
EVE SSO button — the only bright object on the page, and the only thing you can
press. A hairline rule, then a paragraph and six scope identifiers with a
sentence each, running 700px down and off the fold. A mono footer line. Behind
all of it, hangers and a lander in line art at about 7% opacity, mostly outside
the panel. Narrow is the same page with the panel widened to the gutters and
the seal cut to 132px; nothing reflows, nothing is lost.

It reads as authored. The seal is real artwork, the ticks are a print-shop
reference nobody generates by accident, and the scope copy is written by
someone who opened `src/jobs/contacts.ts` to check what `write_contacts`
actually does. The failure mode here is not slop. It is that the top third is
composed and the bottom two thirds are a document.

## Audit health score

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3 | Every text token clears AA with margin; the six-item permission list has no accessible name |
| 2 | Performance | 2 | 128.5 KB of images on the only unauthenticated page, and the 79.8 KB LCP seal is out-prioritised by a 2.2 KB vendor mark below it |
| 3 | Responsive Design | 3 | 320px reflows cleanly; the surface has no rule that uses any width above 640px |
| 4 | Theming | 3 | Tokens throughout, but one label-register member never took its tracking or colour, and `themeColor` is still the retired navy |
| 5 | Anti-Patterns | 4 | No tells. The one card is a sanctioned exception and the artwork is not decoration |
| **Total** | | **15/20** | **Good — address performance, then the error-state spacing** |

## Anti-patterns verdict — pass

No gradient text, no `backdrop-filter` anywhere on this surface, no hero metric,
no card grid, no side-stripe accents, no bounce easing. The single motion is a
620ms opacity-and-scale settle on the seal, on an exponential ease, collapsed
correctly by the global `prefers-reduced-motion` block (`globals.css:295`) —
`seal-settle` fills `both`, runs to its 100% frame at 0.01ms and holds
`opacity: 1`, so the mark is visible either way.

The one card is `.launch__panel`, one of the two exceptions the brief names. The
transparency on it is inert rather than glassy — see the last Minor.

The category-reflex check passes at both altitudes. "EVE corp auth" does not
predict a warm near-neutral ground at `#0a0a0a` with a single gold, and
"spacecraft tool that is not neon HUD" does not predict mission-documentation
print furniture. The seal is doing the work a generated page would try to get
from a gradient.

---

## Findings

### 1. The LCP element is oversized and explicitly out-prioritised by a 2.2 KB image below it

- **Severity** — Serious.
- **Where** — `src/app/login/page.tsx:108-114` (seal, no `fetchPriority`),
  `src/app/login/page.tsx:173` (`fetchPriority="high"` on the SSO button),
  `src/app/globals.css:3515-3522` (`.launch::before`, the hero background).
- **Cost** — Every visitor to the product's only unauthenticated page waits on
  128.5 KB of images before the page settles, and the browser has been told the
  wrong one matters: a member on mobile data sees the vendor button resolve
  first and the brand mark, which is the thing the page is *for*, arrive after
  it.
- This re-opens nothing. The known-open entry names "oversized images with no
  `sizes`/priority" and "the 82 KB seal is the LCP element". Three things it
  does not name, all measured here:
  - `emblem.webp` is 512×512 and 79.8 KB, drawn at 180px wide (2.84×) and at
    132px below 640px (3.88×). Not "no priority": **negative** priority,
    relative to its own page. The 2,248-byte `eve-sso-login-white-large.png`
    below it carries `fetchPriority="high"`, so the one explicit hint on the
    page ranks the vendor mark above the LCP candidate.
  - `hero.webp` is a third image nobody has counted: 1000×573, 46.5 KB, painted
    at `opacity: 0.07`. It is a CSS background, so the preload scanner cannot
    see it — it starts downloading only after `globals.css` parses, which is
    exactly when the seal is competing for bandwidth. At 390px it is drawn at
    585px wide and the full 1000px file is still fetched.
  - Page total: 79.8 + 46.5 + 2.2 = **128.5 KB**, all of it before a member can
    decide anything.
- **Fix** — Three independent, none of which touches the encode quality
  principle 5 protects: (a) ship `emblem.webp` at 360×360 for the 180px box, or
  add a 1×/2× `srcset` — a 3.88× source for a 132px phone box is not "the
  retina cut"; (b) move `fetchPriority="high"` from the SSO button to the seal,
  or add it to the seal and drop it from the button, which is 2 KB and will
  arrive regardless; (c) give `hero.webp` a smaller cut, or accept it and
  `<link rel="preload" as="image">` it so it is not discovered last. The
  cheapest single win is (b): one attribute moved.
- **Principle** — LCP; and the audit dimension "missing optimization: images
  without lazy loading, unoptimized assets".
- **Suggested command** — `$impeccable optimize`.

### 2. The error notice has no space above it and 56px below it

- **Severity** — Moderate.
- **Where** — `src/app/globals.css:3429` (`.notice` sets `margin-bottom` and no
  `margin-top`), rendered from `src/app/login/page.tsx:138`.
- **Cost** — A member whose sign-in just failed lands on a page where the motto
  is jammed against the top border of a red box, close enough to read as being
  *inside* it, while the button floats 56px below — so the first impression
  after a failure is a page that looks broken, which is the worst possible
  moment for that impression.
- Measured, not eyeballed. At 1440×900 with the `oauth_failed` message:
  `.launch__motto` bottom 383, `.notice` top 383 — **0px** — and `.notice`
  bottom 453 to `.launch__action` top 509 — **56px**. Confirmed at 390×844.
  `.notice` works everywhere else because its siblings there supply the space
  above it; on `/login` it is the immediate next sibling of `.launch__motto`,
  which sets `margin-top` only (`globals.css:3589-3597`).
- **Fix** — One rule scoped to this surface, not a change to `.notice`, which is
  load-bearing on six other pages: `.launch__panel > .notice { margin-top:
  var(--s-5); }`. Reduce `.launch__action`'s `--s-6` top margin to `--s-5` in
  the same breath if you want the notice to sit evenly between the two.
- **Principle** — Proximity: spacing should encode what belongs to what, and 0px
  above / 56px below says the notice belongs to the motto.
- **Suggested command** — `$impeccable layout`.

### 3. The six-item permission list has no accessible name

- **Severity** — Moderate.
- **Where** — `src/app/login/page.tsx:191` (the `<p>`) and `:198` (the `<dl>`).
- **Cost** — A screen-reader user deciding whether to grant six ESI scopes hits
  "definition list, 12 items" with nothing saying it is the scope list, and
  because "Scopes requested" is a `<p>`, heading navigation on this page offers
  exactly one destination — the corp name — so there is no way to jump to the
  thing the page exists to disclose.
- This does not re-open the closed `<dl>` inversion item. The inversion is right
  and the reasons in `globals.css:3629-3640` hold; the `<dt>`→`<p>` move was
  also right. What was never added is the association between the two.
- **Fix** — `id="scopes-head"` on the `<p>`, `aria-labelledby="scopes-head"` on
  the `<dl>`. Two attributes, no visual change, no restructuring. If heading
  navigation is also wanted, `<h2 className="launch__scopes-head">` gets both
  and keeps the register's type — the register styles by class, not by element,
  and `.rule-head__label` and `.facts dt` already prove members can be different
  elements.
- **Principle** — WCAG 2.2 AA, 1.3.1 Info and Relationships.
- **Suggested command** — `$impeccable harden`.

### 4. Nothing on this surface uses any width above 640px

- **Severity** — Moderate.
- **Where** — whole surface. The only width rule that touches it is
  `src/app/globals.css:5089` (`@media (max-width: 40rem)`), whose login block at
  `:5142-5149` shrinks the seal and the panel padding. There is no `min-width`
  query anywhere in `globals.css` that names a `.launch*` selector.
- **Cost** — On a 1440px monitor the page renders as a 480px column and runs
  1399px tall, so a member reading the permissions scrolls a second screen while
  960px of ground sits empty either side; and from 641px to 3840px the rendered
  layout is byte-identical, so a large display buys nothing.
- **This is the brief's pattern 1, and it is real here** — but it is the
  *disclosure* that is unshaped, not the panel. The composed part (seal, name,
  motto, notice slot, button) is 560px tall and correct at 480px wide; a
  centred sign-in should be a narrow column. Everything below the hairline rule
  at `.launch__disclosure` is a reference document wearing the sign-in
  composition's width.
- **Fix** — Scoped to the disclosure only, and only above the fold-free widths:
  at `min-width: 60rem`, let `.launch__scopes` run two columns
  (`columns: 2; column-gap: var(--s-6)`), or widen `.launch__panel` for that
  block alone. Do not widen the panel globally — the seal/title/button
  composition is right at 480px and would go slack. Whatever is chosen, the
  panel must keep growing rather than being pinned, because `.launch` carries
  `overflow: hidden` (see Minor 8).
- **Principle** — Responsive design: a layout with no rule above its smallest
  breakpoint is not responsive, it is narrow.
- **Suggested command** — `$impeccable adapt`.

### 5. `themeColor` is still the retired navy

- **Severity** — Minor.
- **Where** — `src/app/layout.tsx:52` — `themeColor: "#080f1f"`.
- **Cost** — A member opening the sign-in page on an Android phone gets a navy
  browser bar above a neutral near-black page: `#080f1f` against `--void`'s
  `#0a0a0a` is a 1.04:1 luminance match but a clear hue mismatch, blue at ~3.9×
  red against a token that is exactly neutral. It reads as a seam between the
  browser and the app, on the first screen anyone sees.
- The token comment at `globals.css:9-38` is explicit that the palette moved off
  "the blue-slate axis this used to sit on". This value did not move with it.
- **Fix** — `themeColor: "#0a0a0a"`. This is not a colour-token change — the
  constraint the brief closes — it is a hard-coded literal that should have been
  `--void` and is now a stale copy of a colour the system deleted.
- **Principle** — Theming: hard-coded colours drift when tokens move.
- **Suggested command** — `$impeccable polish`.

### 6. `.launch__scopes-head` joined the label register and took none of its per-component properties

- **Severity** — Minor.
- **Where** — `src/app/globals.css:383` (register membership) and `:3625-3627`
  (its own rule, which sets `margin-top` and nothing else).
- **Cost** — Three mono uppercase lines stack on this one page, and the middle
  one is set differently from its neighbours for no reason anyone chose: measured
  letter-spacing is 1.54px on `TEST MOTTO LINE`, **0 (`normal`)** on
  `SCOPES REQUESTED`, 1.2px on `TEST FOOTER LINE`. It reads as a tighter,
  brighter kind of label, and the page has exactly one kind.
- The register comment at `globals.css:317-320` states the contract: the shared
  block carries family, size, weight and case, and "each component below keeps
  only what is actually its own: its colour, its spacing, and its tracking
  token." This member declares one of the three. Checked against siblings:
  `.rule-head__label` (`:901`), `.strip__head` (`:4147`) and `.facts dt` (`:966`)
  each carry both a tracking token and `color: var(--ink-faint)`.
- **Fix** — Add `letter-spacing: var(--track-furniture)` — it is a section label,
  which is what that token is named for, and it matches `.launch__motto` 40px
  above it. The colour is a separate call: inheriting `--ink` makes this the
  brightest label in the system, which may be intentional emphasis for a section
  head; if it is, say so in the rule, because right now it is indistinguishable
  from the same omission.
- **Principle** — Consistency; the project's own written label register.
- **Suggested command** — `$impeccable typeset`.

### 7. A CSS comment documents behaviour the code deliberately does not have, and "fixing" the code to match it would reintroduce a hazard

- **Severity** — Minor (as shipped) — but the reason it is filed is that the
  *next* edit is the dangerous one.
- **Where** — `src/app/globals.css:3653-3658` versus
  `src/app/login/page.tsx:16-25`.
- The CSS says: "A scope the description map does not recognise (a fork's own
  `EVE_SSO_SCOPES` addition) **renders no `dd` at all** rather than a
  placeholder — the identifier is still shown, honestly, as the one thing known
  about it."
- The code does the opposite, on purpose. `describeScope`'s `default` returns a
  real sentence (`page.tsx:56`) and the JSX renders a `<dd>` unconditionally
  (`:202`). The docblock above it argues at length why: "a `<dt>` with no `<dd>`
  is invalid there, and worse than invalid on a consent screen, since AT groups
  a term with the next definition it finds and would read an undescribed scope
  as meaning whatever the scope BELOW it means."
- **Cost** — Nobody is harmed today. The harm is latent and specific: a
  maintainer reading the stylesheet finds a documented behaviour, sees the code
  disagree, and "corrects" the code — putting an unknown scope on a consent
  screen under its neighbour's description, which is the exact failure the TSX
  comment spent nine lines preventing.
- **Fix** — Delete the two clauses from the CSS comment and point at
  `describeScope`'s docblock. The rest of that comment (`--ink-dim` parity with
  `.launch__disclosure-note`) is correct and should stay.
- **Principle** — A comment that contradicts its code is worse than no comment.
- **Suggested command** — `$impeccable polish`.

### 8. An unbroken config value in the disclosure clips off-screen with no way to scroll to it

- **Severity** — Minor.
- **Where** — `src/app/login/page.tsx:180` (`<code>{label}</code>`) and `:36`
  (the same `contactLabel` interpolated into the `write_contacts` description),
  against `src/app/globals.css:3512` (`.launch { overflow: hidden }`).
- **Cost** — A fork whose `STANDINGS_LABEL` is one unbroken word longer than
  about 29 characters gets a sign-in page where part of the sentence naming
  what authGD will write to their characters is off the right edge and
  unreachable — not scrollable, clipped.
- Measured at 320×800 with a 47-character unbroken label: the `<code>` box
  extends to x=423 in a 320px viewport, the panel grows to x=440, and
  `document.documentElement.scrollWidth` stays **305** because `.launch`'s
  `overflow: hidden` swallows it. No scrollbar appears. With a hyphenated label
  of the same length it wraps correctly, so this needs a no-separator value.
- The fix pattern is already on this page, one element away:
  `.launch__scopes dt` carries `overflow-wrap: anywhere`
  (`globals.css:3646`) for precisely this reason, on the other config-shaped
  string. The prose sites never got it.
- **Fix** — `overflow-wrap: anywhere` on `.launch__disclosure-note code`, and on
  `.launch__scopes dd` for the interpolated copy of the same value.
- **Principle** — WCAG 2.2 AA, 1.4.10 Reflow (no loss of content or
  functionality at 320px).
- **Suggested command** — `$impeccable harden`.

### 9. The panel's transparency is inert

- **Severity** — Minor.
- **Where** — `src/app/globals.css:3527` —
  `background: color-mix(in oklab, var(--hull) 88%, transparent)`.
- **Cost** — None to a user; the cost is to the next reader, who sees a
  deliberate-looking 88% and assumes the hero shows through the panel. It does
  not, measurably: the hero sits at `opacity: 0.07`, so the panel's 12%
  transparency passes through 0.84% of the artwork's own contrast. Worked
  through on the brightest plausible line-art pixel (`#3a3a3a` over `#0a0a0a`):
  the panel renders 20.1/255 with the art behind it versus 19.7/255 over bare
  void. A difference of 0.4 in 255.
- **Fix** — Either make it `background: var(--hull)` and say the panel is
  opaque, or raise the hero's opacity behind the panel so the transparency
  earns itself. The first is the smaller change and matches what ships today.
- **Principle** — A declaration that has no observable effect is a claim the
  code cannot back.
- **Suggested command** — `$impeccable polish`.

---

## The brief's three patterns, answered directly

**Pattern 1 (unshaped field) — present, in the disclosure only.** Filed as
finding 4. The panel is not the problem; the 700px reference document inside it
is.

**Pattern 2 (total enumeration) — present, and I recommend leaving it.** Every
one of the six `<dt>`s begins `esi-` and ends `.v1`. That is two facts about
the whole set, stated six times each, in the faintest ink, occupying about a
third of each identifier's width — structurally the same shape as
`/admin/sync`'s "Cadence (UTC)" fix. The `visually-hidden` restoration
technique would even preserve the accessible name. I am filing it as an
observation rather than a defect because the visible saving is six characters
per row on a 24-character remainder, and the cost is real: this string exists so
a technical reader can check it against `EVE_SSO_SCOPES` verbatim and so it can
be copied. A consent screen is the one place a truncated identifier is worse
than a long one. Naming it here so the next reviewer does not spend a finding
rediscovering it.

**Pattern 3 (repeated identical controls) — absent.** The page has exactly one
focusable element. Tab once and you are on the sign-in link; there is nothing to
direct the eye away from, and the button is the brightest object on the page by
a wide margin. This is the surface most clearly free of that pattern.

**"An explanatory subtitle under an H1 is a smell" — does not apply.** The
motto is brand, not explanation, and it is omitted entirely when unset
(`page.tsx:120`) rather than rendered empty.

---

## What is genuinely good and should survive

- **Contrast has margin everywhere, and it was clearly measured.** On the
  panel's rendered ground of `#141413`: `--ink` `#ece7de` at 14.97:1, `--ink-dim`
  `#bab3a9` at 8.87:1, `--ink-faint` `#90877e` at 5.23:1 (the scope identifiers,
  the smallest text on the page at 12px), `--gold` `#f1c035` at 10.82:1,
  `--signal-bad` `#f05751` at 5.43:1. `--rule-strong` `#787370` clears 1.4.11 at
  3.94:1 as the panel border. Nothing is close to a floor.
- **The keyboard path is one press.** One focusable element, a never-suppressed
  2px gold focus ring at `globals.css:289`, and the ring outlines the button
  rather than a 414px strip — the `inline-block` fix at `:3673` with its
  reasoning intact. Do not let a fix re-block that element.
- **320px is clean.** No horizontal overflow (`scrollWidth` 305 against a 320
  viewport), the SSO button scales because the global `img { max-width: 100%;
  height: auto }` reset at `:198-212` pairs both axes, the seal drops to 132px,
  the panel keeps 273px of width and the longest scope identifier fits at 239px.
  The comment on that reset names this exact button as the case it was written
  for; it is still working.
- **The scope copy.** Six sentences grounded in the actual call sites, including
  the one that admits `write_contacts` deletes. This is the best writing in the
  app and the reason the page reads as authored.
- **`alt=""` on the seal, `alt="Log in with EVE Online"` on the button.** The
  right call on both, for the reasons given in place.
- **Reduced motion is handled correctly and the reasoning is written down.**
- **The registration ticks.** 14px, one hairline, `--gold-dim` at 0.75 opacity,
  used once in the system. They cost nothing and they are the single clearest
  signal that a person made this page.

## What I could not evaluate

- **Real LCP timing.** I measured bytes, intrinsic dimensions, priority hints
  and discovery mechanism from source and from a static harness. I did not run a
  throttled trace against the real app, so the finding-1 numbers are byte counts
  and hint ordering, not a measured LCP delta. `$impeccable optimize` should
  confirm with a trace before choosing between the three fixes.
- **Actual screen-reader output.** Finding 3 is derived from the markup, not
  from a NVDA/VoiceOver session.
- **The error state as it really renders.** There is no error shot in the set;
  finding 2 is measured against a harness reproducing the same markup and the
  same stylesheet, at both viewports.
- **Long brand names.** With `BRAND_NAME` at the fixture's "Test Corp" the
  title is one line. `--t-display` clamps at a 2.5rem floor, so at 320px it
  stays 40px and stops scaling: "Zoo Landers Flygd" measures two lines and 90px
  there, and a 32-character name measures four lines and 179px. Nothing
  overflows horizontally in any of the three, so this is robustness rather than
  a defect, and I could not tell which names are real deployments.
- **Whether the hero artwork is legible at 7% on a low-quality panel.** It is
  faintly visible on this display; on a dim laptop it may be nothing at all,
  which would make finding 1's 46.5 KB a pure loss rather than a proportionate
  one.

## Contested — one settled-taste item

**`.launch__foot`'s hard-coded `0.12em` should be `--track-label`.** The brief
lists `.launch__foot`'s sixth type size (`0.625rem`) as known-open, and the
comment at `globals.css:3694-3703` defends that size well: it is the quietest
line on the page and deliberately below the register's floor. That argument
covers the *size*. It does not cover the tracking, which is written as a raw
`0.12em` sitting exactly on `--track-label`'s value. If the one-off size is
worth a paragraph of defence, the tracking that is not a one-off is worth a
token. This is a one-word change and I am flagging it once rather than arguing
it: fold it into whatever pass touches the known-open size item.

---

## Recommended actions

1. **[Serious] `$impeccable optimize`** — move `fetchPriority="high"` from the
   2.2 KB SSO button to the 79.8 KB seal, cut `emblem.webp` to a 360px source
   or give it a `srcset`, and decide whether the 46.5 KB `hero.webp` earns its
   place at 7% opacity.
2. **[Moderate] `$impeccable layout`** — give the login notice a top margin;
   0px above and 56px below is the state a failed sign-in lands in.
3. **[Moderate] `$impeccable harden`** — name the scope `<dl>` via
   `aria-labelledby`, and add `overflow-wrap: anywhere` to the two prose sites
   that interpolate the contact label.
4. **[Moderate] `$impeccable adapt`** — let the disclosure use the width above
   60rem; leave the sign-in composition at 480px.
5. **[Minor] `$impeccable typeset`** — give `.launch__scopes-head` its tracking
   token, and decide its colour deliberately.
6. **[Minor] `$impeccable polish`** — `themeColor` to `#0a0a0a`, delete the
   contradicted clauses from the `.launch__scopes dd` comment, and resolve the
   inert panel transparency.

# `/login` — critique

**Register:** brand. **Command:** `$impeccable critique`.
**Shots:** `01-login.wide.png` (1440×900 viewport, 1440×1306 page),
`01-login.narrow.png` (390×844 viewport, 390×1314 page).

## What I see, before explaining it

A 480px column standing in the middle of a 1440px black field. Inside it, top to
bottom: a navy-and-gold mission patch, the corp name set enormous, a tiny tracked
mono line, a light-grey vendor button, a hairline, a paragraph of grey prose, then
six mono identifiers each followed by two or three lines of grey prose, then a
hairline, then a very small mono line. Two faint slabs of line art sit out on the
black to the left and right of the column, at about a tenth of the ink of anything
else, and they do not join up — whatever they are a picture of is behind the panel.
There is a gold tick at the panel's top-left corner and another at its bottom-right.

The page does not fit the screen at either size. Wide, 406px of it is below the
fold; narrow, 470px is. The lower half of both is the scope list.

On the black at the far left there is a small dark circle with an "N" in it. That is
the Next.js dev indicator baked into the capture, not shipping UI. Ignore it.

---

## Findings

### 1. Six scopes at one weight, and the only one that writes is row two of six

**Severity:** Serious
**Where:** `src/app/login/page.tsx:189-207`; `src/app/globals.css:3629-3665`

Every scope renders as an identical unit: mono identifier at `--t-detail` /
`--ink-faint`, then a sentence at `--t-caption` / `--ink-dim`, `--s-2` between
pairs. Six of them, no grouping, no ordering signal, nothing pulled forward.

The distinctions the list flattens are real and are already known to the file that
renders it. `describeScope`'s own comments carry them: `write_contacts` "also
*deletes*" contacts (`page.tsx:32-36`); `read_location` is
`LOCATION_SCOPE_REQUIRED`; `read_structures` and `read_online` are
`LOCATION_SCOPES_OPTIONAL[0]` and `[1]`, and refusing them degrades a line rather
than breaking a feature (`page.tsx:41-54`). Five of the six only read. Exactly one
changes something that persists on the member's character.

They also collapse to three facts, not six: contacts (`read_contacts`,
`write_contacts`), where your characters are (`read_location`, `read_structures`,
`read_online`), and one convenience (`open_window`). The prose paragraph directly
above already states two of those three in the member's terms, so the list restates
them a second time in identifier order.

**Cost:** A member granting a token at 1am reads six rows that look the same, and
cannot tell without parsing English which one lets authGD delete contacts off their
character. The realistic outcomes are granting without reading, or bouncing at the
one screen the product cannot afford to lose people on.

**Fix:** Group the `<dl>` under three sub-heads in the label register — *Contacts*,
*Location*, *In-game window* — and say the shared fact once per group instead of
once per row. Then mark the deviation against the set the way `crewNorms` does:
state "read-only" once for the set, and let `write_contacts` carry the one visible
mark, because it is the only member that departs. Same for optional: `read_online`
and `read_structures` take one shared "optional — refusing degrades the location
line" and lose their individually-repeated hedges. Keep the raw identifiers (a
technical reader checks them against `EVE_SSO_SCOPES`) and keep the dt/dd
inversion. Net effect is six uniform rows becoming three groups with one thing
standing out, and roughly a third less height.

Worth knowing while sizing this: CCP's own consent screen is the next thing the
visitor sees, and it enumerates the same six scopes in EVE's words. This page's job
is the plain-English *why*, not the inventory. Compressing the inventory loses
nothing the following screen does not restate.

**Principle:** Sweep pattern 2 (total enumeration) and pattern 3 (repeated
identical controls at uniform weight). PRODUCT.md principle 3, scanning is the
primary act.

---

### 2. A 480px column in a 1440px field, and the page still runs 1.45 screens

**Severity:** Serious
**Where:** whole surface (`.launch__panel`, `src/app/globals.css:3524-3533`)

`width: min(30rem, 100%)` puts the panel at 480px, so 960px of the 1440px field —
67% — is empty ground, while the content overflows vertically by 406px. The
disclosure block alone (rule at y≈495 through the last `dd` at y≈1190) is 695px,
53% of the page. Over half of the product's only brand surface is OAuth consent
copy running in a single narrow gutter with two thirds of the screen unused beside
it.

This is sweep pattern 1 in its plainest form, and it is more costly here than on a
product surface, because a brand register is judged on composition. Underneath the
artwork, the shape is: centred mark, centred title, centred subtitle, centred
button, centred stack. `reference/brand.md` names that shape specifically — "don't
default to centering everything", "a centred-stack hero ... reads as template". The
page is rescued from reading as generated entirely by one asset. Cover the seal and
nothing in the layout says what this product is or who made it.

**Cost:** A member's first impression of the whole tool is a template with a good
logo on it, and they have to scroll a 1440×900 desktop to finish reading a login
page.

**Fix:** Spend the field. Break the composition asymmetric: hold the identity stack
(seal, name, motto, action) in its 30rem column to one side, and run the disclosure
in the space beside it rather than under it — at ≥66rem the panel can widen and the
`<dl>` can run two columns, which with finding 1's grouping brings the page inside
one screen. That also uncovers the artwork; see finding 3. The panel stays the
sanctioned card, the identity column keeps its cap, and nothing about the narrow
layout has to change.

**Principle:** Sweep pattern 1. `reference/brand.md` — layout, asymmetry over
centred stacks; brand ban on "timid palettes and average layouts."

---

### 3. The lander is occluded at desktop and absent on a phone

**Severity:** Moderate
**Where:** `src/app/globals.css:3515-3522` (`.launch::before`), interacting with
`3524-3533` and the 40rem override at `5147-5149`

`hero.webp` is 1000×573. At 1440 the background sizes to `min(1000px, 150%)` =
1000px, spanning x 220–1220, and the panel covers x 480–960. What is left visible
is two disconnected 260px slabs of the artwork's outer edges — which is what the
shot shows — with the lander itself, the recognisable part, behind the panel. The
panel's `color-mix(... 88%, transparent)` was presumably meant to let it read
through; at `opacity: 0.07` behind 12% transmission that is 0.8% effective, and the
capture confirms nothing is visible inside the panel. The translucency is a no-op.

At 390 it is worse. `150%` = 585px wide, spanning x −97 to 487, and the panel
occupies x 16–374. Sixteen pixels of artwork survive on each edge, and those
sixteen are the image's empty margin. On a phone the login ground is plain
`--void`.

PRODUCT.md principle 5 grants exactly one exception for held-back artwork and names
this surface as it: "the login ground is the deliberate exception, where the lander
is held far enough back to be texture rather than picture." Held back is not the
same as covered up. What ships is closer to the thing the principle's own sentence
forbids two lines earlier — a fragment.

**Cost:** The one atmospheric move on the only page that gets to make one delivers
nothing on the viewport most members arrive from, and delivers two unreadable
offcuts on the other.

**Fix:** Two edits, both small. Wide: once finding 2 moves the identity column off
centre, shift `background-position` so the lander's subject sits in the open field
rather than under the panel — it becomes a whole picture held at 0.07 instead of
two edges. Narrow: `150%` is the wrong sizing rule when the panel covers 92% of the
viewport. Either size the ground so a recognisable portion clears the panel top or
bottom, or drop `.launch::before` below 40rem and let the void be void, which is at
least honest. Do not raise the opacity to compensate; the problem is placement.

**Principle:** PRODUCT.md principle 5, earn the artwork.

---

### 4. The corp's joke is set at 11px in the faintest ink on the page

**Severity:** Moderate
**Where:** `src/app/globals.css:3589-3599` (`.launch__motto`)

`--t-label` (0.6875rem / 11px), `--ink-faint` (#90877e, 5.23:1 on the panel's
#141413), uppercase, `--track-furniture`. It sits directly under a 64px `--t-display`
heading, a 5.8× drop with nothing between.

PRODUCT.md is unambiguous that the brand *is* the joke — "a NASA mission patch
reading *Center for Kids Who Can't Fly Good*" — and that the joke belongs in "the
artwork, the mission-patch furniture, and dry microcopy." `BRAND_MOTTO` is the only
line of microcopy on this page carrying it, and it is styled as metadata: same size
grade as a table column header, quieter ink than any prose on the surface, wedged
into the one gap in the type ramp. The deadpan is right; the volume is wrong.
Deadpan means say it flat, not say it small.

**Cost:** The single line that gives the tool a personality reads as a caption on
the logo, and most visitors will not read it at all.

**Fix:** Give the motto a real step — `--t-caption` or `--t-body` — and lift it to
`--ink-dim`. Keep the mono, the caps and the tracking; the instrument register is
what makes it land straight. It stays quieter than the H1 by a wide margin and
gains a floor. The existing `\n` handling means a two-line motto still works at the
larger size, so a fork's longer string is not a regression risk.

**Principle:** PRODUCT.md brand personality; `reference/brand.md` scale — flat or
skipped steps read as uncommitted.

---

### 5. The emphasis colour is unspent on the one page with a single action

**Severity:** Moderate
**Where:** `src/app/globals.css:3673-3687` (`.launch__action`)

Settled taste rations gold to one primary action per view plus the mark. This view
has exactly one action, and it carries no gold. The control is CCP's 270×45
white-cut asset (#e8e8e8-ish) sitting in a `border: 1px solid transparent` box that
only takes `--gold` on `:hover`. So at rest the page's entire gold budget is two
14px corner ticks and whatever gold is inside the seal artwork, and the brightest
object on a brand surface is a vendor mark in a different type family with a
different corner radius from everything around it.

The vendor asset itself is constrained — CCP publishes the button and re-cutting it
is not on the table, and `page.tsx:153-167` documents why the white cut beat the
black one. That is not what I am asking to change.

**Cost:** The single thing the page wants pressed is the one element that does not
belong to the design system, and until a pointer touches it nothing on the surface
frames it as the product's own control.

**Fix:** Change the resting border colour from `transparent` to `--gold-dim`
(#ce9c20, 7.37:1 on the panel, well clear of the 3:1 UI-boundary floor) and keep
`--gold` on hover. Geometry is untouched, so the "does not resize under the
pointer" reasoning in the existing comment still holds, and the entry control
becomes the one gold-outlined object on the page without altering the vendor mark
by a pixel.

**Principle:** Settled taste — gold rationed to one primary action per view.

---

### 6. The 44-word sentence carrying the core promise

**Severity:** Minor
**Where:** `src/app/login/page.tsx:177-183`

The disclosure note is three sentences, the middle one 44 words with a semicolon and
three trailing participles ("adding, updating and removing them at a set standing").
The third sentence — "Leaving the alliance drops your tier, never your account,
characters, or Discord link" — is *derole, don't boot*, which PRODUCT.md calls the
core promise, and it arrives as the tail of a grey paragraph after the long one has
already spent the reader.

**Cost:** The most reassuring sentence available on a consent screen is the one a
skimmer is least likely to reach.

**Fix:** Split the middle sentence at the semicolon. Then lead the paragraph with
the promise rather than closing on it — what authGD will *not* take is a better
first line on a page asking for a token than what it will do. Content is right, and
the voice is right; this is ordering and sentence length only.

**Principle:** PRODUCT.md voice — terse, factual, never apologises twice.

---

## What is genuinely good and should survive

- **The seal.** 180px, full quality, native 512 source, top of the stack, the only
  saturated object on a near-black page. It carries the entire brand single-handed
  and every finding above assumes it stays exactly as it is. Note that finding 2's
  fix must not shrink it to make room.
- **`--t-display` at 4rem with `-0.03em`.** The corp's name is the largest thing on
  the surface and the tracking is correct for a grotesque at that size. The comment
  at `globals.css:3577-3583` shows this was a considered correction from 1.5rem;
  do not let a widened panel tempt anyone into re-tuning it.
- **The registration ticks.** 14px, `--gold-dim`, two corners, used once in the
  system. This is the detail that makes a visitor ask how the page was made rather
  than which tool made it. Cheap and specific and exactly right.
- **`describeScope`'s copy, and its refusal to invent.** Descriptions grounded in
  the real call sites, and a fallback that says only "authGD has no description for
  it. Ask whoever runs it what it is for before granting." That is the deadpan voice
  landing perfectly. Finding 1 regroups these sentences; it does not rewrite them.
- **The dt/dd inversion, with `dd` at `--ink-dim`.** Putting the plain sentence at
  the same ink grade as the prose above it, so what a scope *buys* is never quieter
  than its identifier, is the right call and survives the regrouping intact.
- **`.launch__action` shrink-wrapped to `inline-block`.** The focus ring outlines
  the 270px control rather than a 414px strip, and the dead clickable margin is
  gone. `:focus-visible` gives it a 2px `--gold` ring at `globals.css:289-293`, so
  the keyboard state is solid — finding 5 is about the resting state only.
- **`Notice` mounted unconditionally in slot mode**, not behind `&&`, so the live
  region exists before its text does.

## What I could not evaluate

- **Every error state.** There is no shot of `/login?error=…` in any of the three
  tones. I could not judge the `bad`/`warn`/`info` treatments in place, and more
  usefully I could not check what a mounted notice does to the fold: it inserts
  between the motto and the action, and at 390×844 the action currently sits at
  y≈347 with only ~500px of headroom. A two-line `bad` notice may push the primary
  control close to the fold on a phone. Worth one capture.
- **The real deployment's brand strings.** The shots run the fixture — "TEST CORP",
  "TEST MOTTO LINE", "TEST FOOTER LINE". Finding 4's argument holds for any string,
  but the head's balance at the real motto's length is unjudged.
- **Hover and press.** Static captures only; `.launch__action:hover` and the seal's
  620ms `seal-settle` entrance were read from source, not seen. Reduced-motion is
  handled globally at `globals.css:295-304` including `animation-duration`, so the
  entrance collapses correctly — that much I did verify in source.
- **How `hero.webp` reads at 0.07 on a real panel in a dark room.** I judged
  occlusion geometrically and from the capture, which is reliable for *where* the
  artwork is; how much of it a member actually perceives at that opacity on their
  own display is not something a PNG settles.

## Contested

Nothing. I have no quarrel with any settled-taste item as it applies here — the
panel earns its card exception, the ticks are the best detail on the page, and the
tight ramp is not what is wrong with the motto (finding 4 asks for a step that
already exists in the scale, not a new one).

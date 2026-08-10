# `/payouts` — audit

`$impeccable audit`. Register: **PRODUCT**. Read-only pass over
`src/app/payouts/page.tsx`, `src/app/payouts/access.ts`,
`src/app/payouts/pending-link.tsx`, `src/app/_components/scroller.tsx`,
`src/app/_components/ui.tsx` (`Status`, `RuleHead`), and the table/scroller
rules in `src/app/globals.css`. Shots read first, both viewports.

## What the screenshots show, before any source

**Wide (1440×1851).** A 1200px table of 34 rows. Every row is the same
shape: an underlined name, an ISO date, one mono status token, a right-aligned
ISK figure, and two more mono tokens. The one saturated thing on the screen is
the gold `NEW OPERATION` button, top right — until you look at the last two
columns, where 22 of the 34 rows carry two amber tokens each. Roughly 640px of
the 1200px row is ink; the largest single void is ~214px between the end of
`FINALIZED` and the first digit of the total. The word "paid" appears twice in
every row, under two headers that already say Paid and Yours.

**Narrow (390×5699).** The page is 5,699px tall — about fourteen phone
screens. The Name column is pinned at ~70px and the names are broken
mid-syllable to fit it: `Tama gatecamp 01` renders as `Tam / a / gate / cam /
p 01`, five lines, so the row is ~150px tall. The table scrolls sideways and
`TOTAL` is cut mid-number at the right edge; `PAID` and `YOURS` are off-screen
entirely at rest. The column headers scroll off the top after the second row
and never come back.

**Empty (both).** Wide: content stops at y≈475 of a 900px viewport, and the
page's remaining 400px is void. Narrow: an empty ledger still renders a
six-column horizontally-scrolling region, and the empty message's last few
pixels sit under the end fade.

## Audit health score

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3 | The row's identity cell is a `<td>`; the visual pin has no aural equivalent |
| 2 | Performance | 3 | 50 rows server-rendered per page, no client cost of note |
| 3 | Responsive | 2 | Names shredded to one syllable per line at 390px; headers scroll away on a 5,699px page |
| 4 | Theming | 4 | Full token discipline; no hard-coded colour on this surface |
| 5 | Anti-patterns | 3 | Amber is the majority state, not the exception |
| **Total** | | **15/20** | **Good — address responsive and the enumeration** |

**Anti-patterns verdict: pass.** This does not read as generated. No cards, no
gradient text, no glassmorphism, no hero metric, no icon grid, one accent
colour rationed to one button. The one tell is not an AI tell but a
signal-discipline one: the alarm colour is spent on the majority case (finding
2). Nothing here would let someone say "AI made that."

**No Critical findings.** I found no WCAG 2.2 AA failure on this surface.
Contrast measured in rendered sRGB, worst cases: `--ink-faint` `#90877e`
headers on `--hull` `#151514` = 5.21:1; `--ink-dim` `#bab3a9` cells on `--void`
`#0a0a0a` = 9.54:1; `--signal-warn` `#ff9f5f` = 9.75:1; `--gold` `#f1c035` on
`--void` = 11.65:1; the scroller frame `--rule-strong` `#787370` = 4.24:1
against the 3:1 UI-boundary floor. All clear.

---

## Findings, worst first

### 1. Serious — the word "paid" is printed 68 times, and the fact a member came for is printed nowhere

**Where:** `src/app/payouts/page.tsx:295-377` (the Paid and Yours cells), and
`:223-228` (the `RuleHead` aside that could hold the set fact).

Every Paid cell reads `0/5 paid` under a column header that says **Paid**.
Every Yours cell reads `paid` / `unpaid` under a column header that says
**Yours**. On the 34-row shot that is 68 printings of a word the header has
already said — this is exactly the shape `/admin/sync` fixed once with
"Cadence (UTC)", and exactly what pattern 2 is looking for. Meanwhile the
question the page exists to answer at a glance — *am I owed anything?* — is
answered only by scanning 34 rows of one column, because the set-level fact is
never stated. The `RuleHead` aside says `34 total` and stops there.

**Cost:** A member checking at 1am whether the corp owes them anything reads
thirty-four rows of a column, in a 5,699px page on a phone, to compute a number
the page already has in hand.

**Fix:** Two moves, both already in the codebase.

- Strip the repeated word from the visible cell (`0/5`, `—` for the Yours
  column's own state) and restore it per-row in a `.visually-hidden` span so
  the accessible name does not lose it. That is the `Cadence (UTC)` mechanism
  verbatim, and this file already uses the same `aria-hidden` glyph +
  `visually-hidden` words idiom four times (`:283-284`, `:298-299`,
  `:353-355`, `:360-363`) — it is not a new pattern here.
- Put the deviation in the aside, the way `crewNorms` does on `/account`:
  `34 total · 22 unpaid for you`. Compute it from `ops`, which is already in
  hand, so it costs no query — and label it under the same honesty rule
  `complete` / `quantity` already enforces at `:114-120`, since a paged result
  can only claim what is on the page.

**Principle:** Pattern 2 (total enumeration). PRODUCT.md principle 2, state
before action.

---

### 2. Serious — amber is the majority state, so it has stopped meaning "this one"

**Where:** `src/app/payouts/page.tsx:305-313` and `:342-347`. Also visible
without a location: it is the composite that fails, not either branch.

The code already made this argument and stopped one branch short. `:314-323`
reasons, correctly, that a draft mid-payment is normal work and rendering it
amber "burned the alarm colour on nothing" — and sets it neutral. The finalized
branch kept the amber. On the supplied realistic fixture that produces 22 of 34
rows carrying **two** `--signal-warn` tokens each (sampled from the shot at
`#ff9f5f`, confirming `Status tone="warn"` on both Paid and Yours) — 44 amber
tokens on one screen, against one gold button. The two are also redundant with
each other: on a finalized operation, `0/5 paid` amber and `unpaid` amber are
the same claim twice, side by side.

**Cost:** An operator opening the ledger to find the operation that has stalled
sees two-thirds of it lit amber and has nothing to sort on; the one genuinely
old unpaid operation is indistinguishable from last week's.

I am reporting this against the fixture the sweep supplied, and it is
fixture-dependent in one direction only: a corp that pays out promptly shows
fewer amber rows. It is not fixture-dependent in the direction that matters —
any backlog at all reproduces it, and a backlog is when someone opens this page.

**Fix:** Pick one carrier, not two. Keep the amber on `Yours` (the viewer's own
stake, the reason the column was added) and let `Paid` state the fraction
neutrally — the fraction is already self-evidently short of the denominator.
Or, if the fault really is "finalized and still unpaid", make it a fault of
*age*, not of state: amber past some interval since `occurredAt`, neutral
before it. Either way the alarm colour lands on a minority of rows again.

**Principle:** DESIGN.md's own "colour only when the state is actionable";
"saturated colour occupies well under 10% of any screen".

---

### 3. Serious — the only long table in the app whose column headers scroll away

**Where:** `src/app/payouts/page.tsx:229` and `:239`.

`<Scroller label="Operations log">` with `<table className="log log--payouts
log--sticky-col">`. The app's other three long tables all take the pair:
`admin/accounts/page.tsx:445-446`, `admin/audit/page.tsx:563-564`, and
`payouts/[id]/page.tsx:911-913` each use `Scroller tall` +
`log--sticky-head` + `log--sticky-col`. `/payouts` takes the pin and not the
sticky head, on a page whose size is 50 (`PAYOUTS_PAGE_SIZE`,
`src/services/payout-view.ts:49`). At 390px the header is gone after the second
row, and what remains is three near-identical mono tokens per row with nothing
naming which column is which. There is also no top pager: `.pager--top` exists
and `/admin/audit` renders one (`admin/audit/page.tsx:216`), so on the 50-row
case the only way to page is at the bottom of about 7,500px of table.

**Cost:** A member on a phone panning right to read a figure has the row's
identity (the pin works) but not the column's, and has to scroll back to the
top of the page to find out whether the amber token they are looking at is
`Paid` or `Yours`.

**Fix:** Adopt the same pair the other three long tables use — `tall` on the
`Scroller`, `log--sticky-head` on the table. State the tradeoff honestly when
doing it: `.scroller--tall` caps the region at 80svh, which puts the ledger in
a nested scroll box on a phone, and that is a real cost this page has so far
avoided. If it is judged too high, the alternative is to shorten the rows
(finding 4) so more of the table fits between header sightings — but the pin
without a sticky head is the inconsistent option, not a third position.

**Principle:** Consistency with the app's own established mechanism for the same
problem.

---

### 4. Serious — names are broken mid-syllable, and the page pays for it fourteen times over

**Where:** `src/app/globals.css:1364-1366` (`.log--payouts td:first-child {
overflow-wrap: anywhere }`).

`overflow-wrap: anywhere` — unlike `break-word` — participates in min-content
width, which is the point: it is what stops one unbroken 60-character
operation name from dragging the pin across the region, and `payouts.spec.ts`
holds the pinned column under 60% of the region at 320px and 390px. But there is
a ceiling with no floor. The table algorithm therefore shrinks Name to near its
minimum for *ordinary* names too, and `Tama gatecamp 01` renders as five lines
of two-to-four characters. Every row becomes ~150px tall and the 34-row page
becomes 5,699px.

**Cost:** A member scanning for an operation they remember by name reads it one
syllable per line, and scrolls fourteen phone screens to reach the end of a
list that could be five.

**Fix:** Add a floor the ceiling test still passes: `min-width: 11ch` on
`.log--payouts th:first-child, .log--payouts td:first-child`. 11ch is ~88px of
the measured 286px region at 320px — 31%, comfortably under the 60% the spec
asserts — and it holds ordinary names to two lines instead of five while
leaving `overflow-wrap: anywhere` in place for the pathological name it was
written for. The cost is ~20px more horizontal scroll for the columns that
already do not fit, which is scroll, not loss.

**Principle:** Pattern 1 (the page runs long instead of wide). WCAG 1.4.10
reflow is met either way; this is about what the reflow costs.

---

### 5. Moderate — the pin has no aural equivalent: the row's identity cell is a `<td>`

**Where:** `src/app/payouts/page.tsx:255-257`.

The pinned column exists, per the CSS comment at `globals.css:1315-1322`,
because "panning right to read Total costs the reader the row's identity …
the one column every other cell is meaningless without." That argument is
exactly as true for a screen reader user moving cell to cell in table
navigation mode, and they get nothing: the Name cell is a `<td>`, so each cell
announces its column header and not its row. Column headers are correct
(`scope="col"` on all six); it is the row header that is missing. The table
also carries no accessible name of its own — the `Scroller`'s `role="region"`
label covers the region, not the table.

**Cost:** A screen reader user reading down the Total column hears six ISK
figures and no operation names, which is the same defect the pin was built to
prevent, minus the pin.

**Fix:** `<th scope="row">` on the Name cell. **This needs a CSS carve-out and
a naive change will break two other things:** `.log th` (globals.css:1142-1151)
sets `background: var(--hull)`, `color: var(--ink-faint)`,
`letter-spacing: var(--track-label)` and — the dangerous one —
`white-space: nowrap`, which would defeat `overflow-wrap: anywhere` on the
first column and blow the 60% pin ceiling `payouts.spec.ts` asserts. Scope the
body override (`.log--payouts tbody th`) back to the `td` treatment before
changing the element. Optionally add `<caption class="visually-hidden">` for the
table's own name — but note the known-open `<caption>` prose-length item on
`/account` and keep it to three words if so.

**Principle:** WCAG 1.3.1 Info and Relationships (header association).

---

### 6. Moderate — 214px of nothing in the middle of every row, and the class that fixes it is already in the stylesheet

**Where:** whole surface, wide viewport. Measured from
`04-payouts-full.wide.png`: within a 1200px row, ink occupies roughly
x=120-333 (name), 464-541 (date), 615-662 (status), 876-1035 (total),
1050-1128 (paid), 1195-1252 (yours). The single largest gap is ~214px between
the status word and the first digit of the total.

Every column is auto-sized and `width: 100%` distributes the slack across all
six, so Status — a column holding one of two fixed words — is stretched widest
of all. `.log__col--fit` exists for precisely this
(`globals.css:1284-1286`: "Shrink-to-content in an auto-layout table. Applied
to every column except the one that should absorb the leftover width") and is
used by `/account` and `/admin/accounts`. `/payouts` uses it on nothing.

**Cost:** Reading a row means tracking a horizontal association across 214px of
empty ground; a mis-tracked row on a ledger is a member reading someone else's
total.

**Fix:** A `<colgroup>` with `log__col--fit` on Date, Status, Total, Paid and
Yours, letting Name absorb the leftover — which is also the column that most
wants it, since it is the row's identity and its link target. This narrows the
table at wide and does nothing at narrow, where the min-content case governs.

**Principle:** Pattern 1 (unshaped field).

---

### 7. Moderate — the page's 34 primary controls are 22px targets, under this system's own floor

**Where:** `src/app/payouts/page.tsx:256` — the row's `PendingLink`, an inline
anchor in a cell padded `--s-2` (8px) top and bottom around a `--t-data`
(14px × 1.55) line box.

The target is the ~22px line box, not the 37px row. WCAG 2.5.8 is met through
the spacing exception — the row pitch measures ~39px at 1440px, so no two
targets' 24px circles intersect — so this is not a violation. It is a
violation of DESIGN.md's stated 28px in-row grade, and the codebase has already
made this exact argument once, for a *less* important control:
`globals.css:1153-1170` pads out `.log th a` because "a bare inline anchor here
is a 17px line box floating in a 41px header cell … the objection is DESIGN.md's
own floor, which says 28px is the smallest target this system has." The header
sort links got the fix; the 34 row links, which are the entire navigation of
this surface, did not. (`/admin/accounts` records the same 21.7px measurement
at `page.tsx:301`.)

**Cost:** A member on a phone, thumb on a moving train, misses the name link and
hits dead cell; the press does nothing and there is no feedback saying why.

**Fix:** The precedent's own mechanism — `display: inline-block; padding-block:
0.22rem; margin-block: -0.22rem` on `.log--payouts td:first-child a` — which
grows the target to ~29px without growing the row, so the pin measurements and
row-pitch figures elsewhere stay valid.

**Principle:** DESIGN.md's two hit-target grades (28px in-row).

---

### 8. Moderate — the lede is an explanatory subtitle under an H1, and it now under-sells the page

**Where:** `src/app/payouts/page.tsx:162-165`.

"Your own share of each operation is on your account." The brief names this
shape as a smell, and here it has additionally gone half-stale: the `Yours`
column was added precisely so a member can answer "was I paid?" without leaving
the page. The one thing `/account` still adds is the ISK **amount**, which the
`viewerState` docblock explains cannot be shown here. The sentence does not say
that; it says your share lives somewhere else, on a page that now shows your
share's state in its last column.

**Cost:** A member reads a sentence telling them this page is not for them,
directly above a table with a column named after them.

**Fix:** Name the thing the other page actually adds, or drop the line. "Amounts
owed to you are on your account." is one sentence shorter in meaning and
accurate. Dropping it entirely is also defensible — the `Yours` column and the
nav both point there.

**Principle:** The brief's "an explanatory subtitle under an H1 is a smell";
DESIGN.md's copy rule that every word earns its place.

---

### 9. Minor — the empty state renders a six-column scroll region over nothing

**Where:** `src/app/payouts/page.tsx:380-407`, and see
`03-payouts-empty.narrow.png`.

An empty ledger still draws six column headers in a horizontally-scrolling
region at 390px, so the first thing a new corp sees is a scrollbar under a
table with no rows. Two smaller things travel with it: the message's last ~10px
sits under the 24px end fade (`.log__empty-text` caps at `100vw - 2×--s-5` =
342px inside a ~356px region, and the fade overlays 24px of it), and the
`RuleHead` aside vanishes at zero rows (`:115-120` returns `undefined`), so the
one case where a count is genuinely informative — "nothing matches this
filter" — is the case that shows no count.

**Cost:** Small. A first-run operator meets a scrollbar before they meet a row;
a filtered-to-nothing reader loses the "0" that would confirm the filter ran.

**Fix:** Render the `<thead>` only when `ops.length > 0`, and let the three
empty branches stand alone in the frame. Optionally emit `0 shown` in the aside
for the `noMatches` branch specifically, where it is a finding rather than an
absence.

**Principle:** Empty states are a design surface, not a fallback.

---

### 10. Minor — the page does not name the column it chose

**Where:** `src/app/payouts/page.tsx:145` — `className="page"`.

`.page--wide` exists (`globals.css:691-700`) with a comment explaining that it
is there "so the page states which column it chose instead of 'wide' reading as
whatever 'narrow' wasn't." One file in the app uses it
(`admin/access-lists/page.tsx:133`). `/payouts` is a wide page relying on the
bare default. Zero rendered difference; it is a legibility point for the next
reader.

**Fix:** Add `page--wide`, or delete the class as a convention that did not take.
Either is better than one adopter.

---

## What is genuinely good and should survive

- **The `Scroller` contract.** `role="region"` + `aria-label` always, `tabIndex`
  granted only while there is something to scroll, a `:focus-visible` gold
  outline, and a `ResizeObserver` rather than a resize listener so a region
  inside a collapsed disclosure recovers its stop. This is better than most
  production scroll regions and none of it should be simplified.
- **The dash idiom.** `aria-hidden` em dash beside a `.visually-hidden` phrase,
  with the reasoning (an `aria-label` on a bare span is silently dropped)
  written down at the call site. Four instances, and the hidden text differs
  per case because the claim differs — `not on this roster` versus `roster has
  unresolved names`. Do not collapse these into one shared string.
- **Three distinct empty branches**, each with the right exit: past-end,
  no-match, and genuinely-empty, and the genuinely-empty one is further split on
  whether the reader can act on it. Most tables ship one.
- **`total` versus `shown`.** `:108-120` refuses to call a page count a total
  unless the page provably is the whole list, and forces `shown` on any filtered
  result. Keep this exactly as it is when adding the set fact from finding 1.
- **Shape parity on the status tokens.** Circle / triangle / square / hollow, so
  the tone survives a colour-blind read, plus the word itself. Finding 2 is
  about how *often* the amber fires, not about the token.
- **Input hygiene.** `one()`, `statusParam()` and the `q` trim each exist
  because a specific past failure is named in the comment, and `filterParams`
  is single-sourced so the two consumers cannot drift.
- **`PendingLink`.** Soft navigations on this page say they were pressed, with
  the reduced-motion collapse leaving a visible mark rather than an invisible
  one.
- **`.filter-form__actions .btn--quiet` already restores 36px.** I went looking
  for a `clear` control at the in-row grade next to a 36px `Filter` and it is
  not there — `globals.css:2880-2884` fixed it deliberately. Not a finding.

## What I could not evaluate, and why

- **A live 320px render and 200% zoom.** No running app in this worktree (the
  surface needs a session and a database), so both are reasoned from the 390px
  capture, the measurements the stylesheet records against `.log--payouts`
  (736px of table against a 286px region at 320px), and the ratio assertions in
  `e2e/payouts.spec.ts:3715-3820`. The 320px figures I quote in finding 4 are
  derived from those, not measured by me.
- **Hover, focus-visible and in-flight states.** The shots are at-rest only.
  The `PendingLink` mark, the row hover tint, the `Scroller` focus ring and the
  `Submit` busy state are all read from source and none were seen rendered.
- **The `clear` control and both pager links.** Absent from both shots — 34 rows
  is under the 50 page size, and no filter is applied — so their layout,
  wrapping and spacing at either viewport are unverified.
- **Screen reader announcement order**, including whether the region label,
  column headers and the `visually-hidden` phrases compose into a sensible row
  reading. Asserted from markup, not heard.

## Contested — settled items I think are worth one challenge

None. Every settled item I brushed against on this surface (dark ground, the
`--void` chroma, gold rationed to one action, `.st--ok` at `--ink-dim`, the two
hit-target grades, one column origin, no cards) is right for this page, and two
of them — the `.st--ok` decision and the disabled-control rule — are load-bearing
for findings above rather than in tension with them.

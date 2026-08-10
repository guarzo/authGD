# `/payouts/[id]` — critique

Register: **product**. Reviewed from `06-payout-detail-draft.{wide,narrow}.png` and
`07-payout-detail-finalized.{wide,narrow}.png` first, then `page.tsx` (1283 lines)
and all thirteen co-located components, plus `_components/confirm-submit.tsx` and
`_components/confirm-group.tsx`.

## What I saw before I opened anything

**Draft, wide.** A title with a small `EDIT` chip trailing it, a date with another
one, a mono status line. Three label/value rows. One gold `FINALIZE` about a tenth
of the way down, with a permanent sentence under it. Then an orange-bordered
warning about two items priced at 0.00. Then a ten-row item table where every row
carries an `EDIT` chip wedged between the unit price and the line total. Then a
sixteen-row roster where the SHARES column reads `1.00` sixteen times over (one
`2.00`), the AMOUNT column reads `288,600,000.00 ISK` fifteen times over, the STATE
column reads `– UNPAID` fifteen times over, and every row ends in `EXCLUDE  REMOVE`.
Then a notes box, then a delete button. My eye went to the gold button, then had
nowhere else to go for the remaining 2,500 pixels.

**Finalized, wide.** Same page, minus the gold. The roster's STATE column now holds a
full sentence per paid row — `2026-08-10 11:57:07 UTC paid 288,600,000.00 ISK by
Fleet Commander` — and that sentence is character-for-character identical on all six
paid rows. Rows become three lines tall. Nine `MARK PAID` boxes and six borderless
`revert` words alternate down the right edge.

**Both, narrow.** The page is broken. Not "cramped" — broken. Content runs off the
right edge of the viewport and the whole document scrolls sideways. The roster shows
NAME, SHARES and AMOUNT and nothing else; STATE and every action are past the edge.
Rows have unexplained vertical gaps. The loot pools table has a row that is a tall
empty box.

---

## Findings

### 1. Critical — the page does not fit a phone, and I mean the document, not a table

**Where:** `src/app/globals.css:2974` (`.btn-row--tight`), reaching
`src/app/payouts/[id]/page.tsx:508` → `lifecycle-submit.tsx:153`; and
`src/app/globals.css:4859` (`.pool-items`), reaching `page.tsx:682`.

Both narrow screenshots were captured at a 390px viewport at DPR 1. Their PNG
widths are **771px** (draft) and **522px** (finalized). Playwright's `fullPage`
capture is `document.scrollWidth`, so those numbers are the document's own width: the
draft page is 1.98× the viewport and the finalized page 1.34×. I scanned both images
for the rightmost non-`#0a0a0a` pixel and found content at x=770 and x=521
respectively, so this is real paint, not a stray box.

Two independent causes, both in grid tracks that size to their content's max-content
and have nothing clamping them:

**(a) The Finalize cost sentence cannot wrap.** `LifecycleSubmit`'s form is a child of
`<div className="btn-row btn-row--tight">` (`page.tsx:508`), and
`.btn-row--tight` sets `white-space: nowrap` — written, per its own comment, to stop
*row actions in the narrowest column of a table* from stacking. That declaration is
inherited. Inside it now sits a 130-character sentence: "Closes the pools, roster and
shares to editing. Reversible with Unlock until the first payment is recorded, and
permanent after that." It renders as one unbreakable line in **both** screenshots —
that is how I first noticed something was wrong, since 130 characters cannot fit on
one line at 390px. Its max-content sizes `.lifecycle`'s auto track, and the track
overflows the page box. Content in the y-band 750–800px of the draft narrow shot
reaches x=770; that band is this caption.

**(b) `.pool-items` sizes to its table.** `.pool-items` is `display: grid` with an
implicit `auto` column and no `minmax(0, 1fr)`. Its grid item is the `Scroller`'s
frame, whose max-content is the whole item table. The track takes that width and the
region bursts out of the page instead of scrolling. Rows y=1300–2250 of the draft
narrow shot — the Pool 2 item table — all end at x=563, past a viewport of 390. By
contrast the Loot **pools** `Scroller` sits directly under `.page` as a plain block
child and correctly caps at 382px, which is why one of the two tables on this page
scrolls properly and the other does not.

**Cost:** an operator paying out a fleet from their phone at 1am cannot read the page
without dragging it sideways, and every vertical scroll that drifts a few pixels
horizontally loses their column. This is the surface most likely to be used away from
a desk, because the money moves in the game client and the ledger is a second screen.

**Fix:** (a) drop `white-space: nowrap` from the caption's inheritance — either
scope `.btn-row--tight`'s `white-space` to its direct button children, or set
`white-space: normal` on `.confirm-cost`. The caption stays visible and permanent
(the settled `"visible"` decision is untouched); it just wraps. (b) give `.pool-items`
`grid-template-columns: minmax(0, 1fr)`.

**Principle:** WCAG 2.2 SC 1.4.10 Reflow — no two-dimensional scrolling at 320px
equivalent. The brief names it in the floor.

---

### 2. Serious — the Pool items `Scroller` is inert: no edge fades, no keyboard tab stop

**Where:** `src/app/globals.css:4859`, and the comment at `src/app/globals.css:4568-4577`
that already describes this exact failure on a different surface.

A direct consequence of 1(b), and worth its own entry because it costs something
different. `Scroller` withdraws its own tab stop when it measures no scroll range
(`scroller.tsx:47-55`, `setScrollable(scrollWidth > clientWidth + 1 || ...)`). Because
`.pool-items`' track grew to the table's full width, `scrollWidth === clientWidth`
inside the scroller — so it reports itself unscrollable, drops `tabIndex`, and drops
both edge fades. The overflow moved one box out and became the *page's* problem
instead. The codebase has already diagnosed precisely this, on `/admin/accounts`'
crew table: *"the Scroller it escaped through never overflowed (`scrollWidth ===
clientWidth`), which cost it its edge fades and, because scroller.tsx withdraws the
stop from a region with no scroll range, its keyboard tab stop as well."* That comment
names `.pool-items` by name as the only other grid-parented Scroller in the app, then
fixes the drawer and leaves this one.

**Cost:** a keyboard operator cannot reach the loot table's overflow at all, and gets
no fade telling them there is anything to the right. The fix for the other instance
was written, measured and documented; this one was named and skipped.

**Fix:** same as 1(b). Verify afterwards that the region reports `scrollWidth >
clientWidth` at 390px, which is the assertion that distinguishes a fixed Scroller from
one that merely stopped overflowing the page.

**Principle:** WCAG 2.1.1 Keyboard.

---

### 3. Serious — the draft strips thousands separators from the one column where they matter

**Where:** `src/app/payouts/[id]/page.tsx:734-753`.

The unit-price cell is `canEdit ? <InlineEdit value={item.unitPrice}> :
fmtIsk(item.unitPrice)`. `InlineEdit` renders its raw `value` when no `displayValue`
is passed, and this call site passes none. So the two shots differ, on the same ten
rows:

| draft | finalized |
|---|---|
| `9200000.00` | `9,200,000.00` |
| `31000000.00` | `31,000,000.00` |
| `12500000.00` | `12,500,000.00` |

The LINE TOTAL cell immediately to the right of it is `fmtIsk`'d in both states, so a
single draft row reads `9200000.00` beside `165,600,000.00 ISK`. Corp share, three
sections up on the same page, already solves this: it passes `displayValue` to
`InlineEdit` and renders `10.00%` formatted while remaining editable
(`page.tsx:449-462`).

**Cost:** an operator checking a mispriced item against a contract window is counting
digits in an eight-to-eleven digit unformatted number — exactly the transcription
error `CopyAmountButton` exists elsewhere on this page to eliminate — and they are
doing it *only* while the operation is still editable, which is the only window in
which they can act on what they find.

**Fix:** pass `displayValue={fmtIsk(item.unitPrice)}` at `page.tsx:736`. The edit
field keeps the raw value; only the view mode changes. Same one-line shape as corp
share.

**Principle:** consistent component vocabulary — the same value in the same column
must not render two ways depending on a permission the reader does not see.

---

### 4. Serious — pattern 2: the roster is 48 cells, 45 of which say the same three things

**Where:** `src/app/payouts/[id]/page.tsx:952-998`.

Across the draft's sixteen rows: SHARES is `1.00` on fifteen and `2.00` on one.
AMOUNT is `288,600,000.00 ISK` on fifteen and `0.00 ISK` on one. STATE is `– UNPAID`
on fifteen and `excluded` on one. Three columns; three facts about the whole set; and
the deviation in each is a single row. The reader scans forty-five identical strings
to find three that differ, and the three that differ are the entire content of the
table.

This is `crewNorms` verbatim, on a wider table.

**Cost:** a member opening the operation to see what they are owed reads a column of
fifteen identical twelve-digit numbers to find their own, which is the same number as
everyone else's. An operator checking that the split is right cannot see at a glance
that it *is* right — "everyone is on one share" is the thing they want to confirm and
it is the one thing the table does not say.

**Fix:** the pattern the brief names. State the norm once, in the section heading's
aside or a line under it — "15 participants, one share each, 288,600,000.00 ISK; 1
excluded" — then render only deviation in the cells: leave SHARES blank where it is
1.00 and print `2.00` where it is not, leave AMOUNT blank where it matches the norm.
Keep both channels in parity: the accessible name for a blanked cell restores the
shared value in a `visually-hidden` span, the way `/admin/sync`'s "Cadence (UTC)"
column does.

**Principle:** the sweep's pattern 2.

---

### 5. Serious — the narrow roster hides the only column that varies, and keeps the two that do not

**Where:** whole surface, narrow viewport. Visible in
`07-payout-detail-finalized.narrow.png` and `06-payout-detail-draft.narrow.png`.

The roster table is `log--sticky-col` inside a `Scroller`, so NAME pins and the rest
scrolls. At 390px the visible columns are NAME, SHARES, AMOUNT. STATE — and `mark
paid`, `revert`, `copy amount`, `exclude`, `remove` — are all past the right edge.

So the phone shows the two columns that are identical on fifteen of sixteen rows and
withholds the one that is not. "Was I paid?" and "who still needs paying?" both
require a horizontal drag, per row, on the page whose entire purpose is those two
questions.

It gets worse in the finalized state. Row height is set by the tallest cell, and the
tallest cell is the off-screen STATE cell holding the three-line payment sentence
(see finding 6). The result in `07-payout-detail-finalized.narrow.png` is a column of
rows with wildly uneven heights and large blank gaps beside single-line content — the
visible half of the table is being laid out by content the reader cannot see. It reads
as a rendering fault.

**Cost:** a member checking a payment on their phone drags sideways sixteen times, or
gives up. An operator working a payout from a phone cannot reach `mark paid` without
the same drag on every row.

**Fix:** at narrow widths, reorder or reflow. The cheapest honest version: move STATE
to sit under NAME in the same cell below a breakpoint (the roster already has a
one-cell stack idiom in `.stack`), and let SHARES drop out entirely once finding 4
turns it into deviation-only. The action cell should follow NAME, not trail the
numbers.

**Principle:** the sweep's pattern 2 compounding with responsive column priority.

---

### 6. Serious — the finalized STATE cell recites the same sentence six times

**Where:** `src/app/payouts/[id]/page.tsx:993-996` → `payment-history.tsx:38-45`.

Every paid row renders `2026-08-10 11:57:07 UTC paid 288,600,000.00 ISK by Fleet
Commander`. Across the six paid rows in `07-payout-detail-finalized.wide.png` the
timestamp is identical, the amount is identical, and the actor is identical. The
amount is *also* already printed in the AMOUNT cell of the same row, two columns
left. So each of those rows carries the same figure twice and the same
timestamp-plus-actor as its five neighbours, and pays three lines of height for it.

The single-payment inline case was a deliberate fix (finding 1.6 of the 2026-08-07
walkthrough: a drawer with one line in it is a fold with nothing folded). That
reasoning is right about the fold and silent about the recital.

**Cost:** the roster triples in height at exactly the moment it becomes a worklist,
so the nine rows that still need paying are pushed apart by six rows of text that says
nothing new. On the narrow viewport this text is not even visible — it only sets row
heights (finding 5).

**Fix:** same treatment as finding 4. A payment run is one event: say "all six paid
2026-08-10 11:57:07 UTC by Fleet Commander" once, above the table, and let the row
carry only the `paid` token. Print the full line per row only where a payment
deviates — different actor, different amount, or a revert in its history. That also
restores the disclosure's original purpose: a row with a *history* is interesting, a
row with a payment matching the batch is not.

**Principle:** the sweep's pattern 2.

---

### 7. Moderate — pattern 3: seventy controls, one of them emphasised, and it sits above the two sections holding sixty-four of them

**Where:** whole surface, draft state.

Counted from `06-payout-detail-draft.wide.png` and confirmed against the source:

| control | count |
|---|---|
| `edit` (name, date, corp share, battle report, 10 unit prices, 16 shares) | 30 |
| `exclude` | 16 |
| `remove` | 16 |
| `delete` (pool) | 2 |
| disclosure summaries (add paste, add participant, replace roster) | 3 |
| `FINALIZE`, `SAVE`, `DELETE` | 3 |
| **total pressable in `<main>`** | **70** |

Sixty-four of those seventy are the same `btn--quiet btn--micro` grade at
`--ink-faint` (`#90877e`, 5.61:1 on `#0a0a0a`). The one gold control is `FINALIZE`, at
y≈326 of a 2,902px page — about 11% down. Below it: 2,500 pixels in which nothing is
emphasised over anything else.

I want to be fair about what is working here. `primaryStage` (`page.tsx:234-240`) is a
genuinely good mechanism — one gold control at a time, and *which* control it is
tracks how far along the operation is. The single-primary rule is not violated. The
problem is placement and reach: the one thing directing the eye is above the two
sections that hold 64 of the 70 controls, so it directs the eye at nothing the reader
still has to do. A first-time operator scrolling into the item table meets thirty
identical `EDIT` chips with no indication that two of them (the `unresolved` rows,
already flagged by a warning 400px up) are the ones that matter.

**Cost:** an operator fixing a mispriced item scans ten identical chips to find the
two rows the warning notice named, having lost the notice off the top of the screen
by the time they get there.

**Fix:** two things, neither of which adds a second gold. (i) Let the row carry the
emphasis the notice already computed: the two `unresolved` rows have a `Status
tone="warn"` badge but their `edit` chip is the same grade as the eight rows that are
fine. Raise those two chips to the plain `.btn` grade — a border where the others have
none — so the warning's "which rows" is answered in the table rather than in prose
above it. (ii) Demote the roster's per-row `exclude`, which is the least-used of the
three row actions and is currently at identical weight to `remove`.

**Principle:** the sweep's pattern 3.

---

### 8. Moderate — the finalized page never says what to do next

**Where:** `src/app/payouts/[id]/page.tsx:250-255`.

The lede reads `finalized · frozen · 4,810,000,000.00 ISK · 6/15 paid`, and stops.
`STAGE_LABEL` maps `none` to `null`, and its comment defends this: `none` covers both
"finalized, nothing left to promote" and "read-only viewer", and only the first has a
next step, so collapsing them means a viewer is never told to act on something they
cannot touch.

That reasoning protects the viewer case correctly and takes the operator case down
with it. An operator looking at a finalized operation with nine unpaid rows has an
obvious next step — pay nine people — and the summary line is the one place that
answers "what do I do about it". The value it needs is already computed two lines
away: `access.isOperator && paidParticipants.length < owedParticipants.length`.

**Cost:** the operator gets a page with no primary action and no stated next step at
the exact point the operation has the most work left in it. On a partly-paid
operation reopened days later, "6/15 paid" says where it stands but not that it is
theirs to finish.

**Fix:** add a fifth stage — `pay` — computed as operator + finalized + unpaid rows
remaining, with `STAGE_LABEL.pay = "pay the roster"`. Leave the gold alone: nine
identical rows have no one row worth promoting, and `MARK PAID`'s bordered `.btn`
grade against `revert`'s borderless one is already doing that work well.

**Principle:** Nielsen 1, visibility of system status — the page reports state and
withholds the consequence.

---

### 9. Moderate — `copy amount` appears fifteen times and copies the same string fourteen times

**Where:** `src/app/payouts/[id]/page.tsx:1004-1008`.

Every non-excluded row in the finalized state carries a `copy amount` button. Fourteen
of the fifteen copy the identical string. The button is a good idea and it earns its
place — transcribing a twelve-digit ISK figure by hand is the failure it was built to
remove (`copy-amount-button.tsx:5-10`) — but at a flat split it is fifteen controls
doing one control's work, and it is one of the three things per row producing finding
7's uniformity.

`CopyAmountButton`'s `id` is also `PayFlow`'s only stable focus target across
`mark paid`/`revert` (`pay-flow.tsx:179`, `:209`), so it cannot simply be removed from
rows — the focus flow depends on it existing per row.

**Cost:** minor per press, real in aggregate: the operator's eye passes fifteen
identical control clusters to find the nine that still need action.

**Fix:** keep the per-row button (focus depends on it) and add the shared fact where
finding 4 puts the norm — one `copy amount` beside "one share each,
288,600,000.00 ISK". Once the norm is stated, the per-row buttons on rows matching it
can drop to a quieter treatment than the rows that deviate.

**Principle:** the sweep's pattern 2, applied to controls rather than to values.

---

### 10. Moderate — an explanatory paragraph under the Split / Roster heading

**Where:** `src/app/payouts/[id]/page.tsx:893-908`.

The brief calls this smell out directly, so I will not pretend it is not one: two
sentences of prose sit between the `Split / Roster` heading and the table, explaining
what the table means. In the finalized state it reads *"A payment has been recorded,
so the loot pools, roster, shares and corp share are fixed permanently. Reverting a
payment does not reopen editing: it only corrects who was paid, so revert the wrong
one and pay the right person while still frozen."*

I want to be careful here, because this paragraph is better than most things that
match this pattern. It was moved to this spot deliberately (2026-08-07 walkthrough,
findings 1.2 + 1.7) from the Operation section, where it explained a roster
consequence nowhere near the roster. The move was right. Both halves of the
`firstPayment`/`locked` pair render in the same spot at the same weight, which is a
careful piece of construction. And its content is genuinely not derivable from the
table.

The residual problem is that it is 40 words of standing prose above a sixteen-row
table on a page that already carries a `frozen` status token, and it says the same
thing that token says plus one clause the token cannot ("revert does not reopen
editing"). Its second sentence is the load-bearing one; the first restates `frozen`.

**Cost:** the paragraph is above the table, so on the narrow viewport it costs four
lines before the reader reaches the first row, and it is read once and skipped
thereafter — which means the one novel clause is skipped with it.

**Fix:** cut the first sentence (the `frozen` token already carries it) and keep the
second. Better still, attach the surviving clause to `revert` as its `ConfirmCost`,
where it is read at the moment it becomes load-bearing rather than every visit.
`RevertForm` (`pay-flow.tsx:341-362`) is the only confirm control on this page with no
`describedBy` at all.

**Principle:** the brief's "an explanatory subtitle under a heading usually means the
table needs work".

---

### 11. Minor — "Pool 1" and "Pool 2" are numbers with no meaning to the operator

**Where:** `src/app/payouts/[id]/page.tsx:683` and `:640`.

Pool ordering is `asc(lootPool.id)` on a random uuid — deliberately, and the reasoning
in `payout-view.ts:366-376` is sound: neither pool kind carries a creation-order
column that ranks both, so the choice was stability over meaning, which is the right
trade for the bug it was fixing. I am not re-opening that.

What is left is that the ordinal reaches the operator. The unresolved-items notice
says *"Pool 2: Sleeper Drone AI Nexus ×2, Wrecked Drone Transceiver ×3"*, and the
operator has to count table blocks downward to find which one that is. In the draft
shot the flat pool is #1 and the appraised is #2; in the finalized shot the same two
kinds are reversed. Those are two different operations, so it is not instability — but
it does demonstrate that the number carries nothing an operator could predict, and
"Pool 2" is not a name anyone would use out loud.

**Cost:** small; one extra glance when following a warning to the rows it names. It
matters more as the pool count grows.

**Fix:** label the block by what the pool *is*, not by its position — the Loot pools
table already renders `appraised · sell (5th percentile)` and `flat (manual)` as
status tokens. `Appraised pool` / `Flat pool` reads as itself, and the notice can name
the same thing. Keep the ordinal only as a disambiguator when two pools share a kind.

---

### 12. Minor — the loot pools table spends a full-width scrolling table on two rows

**Where:** `src/app/payouts/[id]/page.tsx:572-623`.

Five columns (`#`, Source, Value, Notes, actions) for two rows, and the `#` column
exists only to restate the ordinal from finding 11. At 390px the region correctly
scrolls (it is the one Scroller on the page that works), and the column it cuts off is
Notes — the only cell whose content varies and is not repeated anywhere else on the
page. That produces the tall empty row visible at the top of
`06-payout-detail-draft.narrow.png`: row 1's height is set by an off-screen note.

**Fix:** at two or three pools this is a definition list, not a table. `Appraised ·
sell (5th percentile) — 4,210,000,000.00 ISK` and `Flat (manual) —
600,000,000.00 ISK, "Citadel rigs, priced by hand off contracts"` need no columns,
and the `delete` control can sit at the end of each line the way the roster's do. The
`#` column goes away with finding 11.

---

## What is genuinely good and should survive

- **`primaryStage`** (`page.tsx:234-240`). One gold control, and *which* control it is
  tracks the operation's progress rather than being pinned to one spot. Findings 7
  and 8 ask for placement and a fifth stage; neither asks for a second gold. Do not
  let a fix pass add one.
- **`MARK PAID` bordered against `revert` borderless** in the finalized roster. Nine
  boxes and six words, and the boxes are the remaining work. This is the one place on
  the page where uniform-weight controls were correctly differentiated, and it was
  done with a border rather than a colour. It is the model for finding 7's fix.
- **The `unresolved` / `manual` per-item markers** (`page.tsx:720-731`), and the
  decision that `triff` — the common case — gets no badge at all. The comment
  explaining it is a correct statement of pattern 2 arrived at independently.
- **The item table not being hidden behind a per-pool disclosure** (`page.tsx:672-678`).
  Burying the thing the section exists to show would have been the easy answer.
- **`PayFlow`'s resume-from-where-you-were focus logic** (`pay-flow.tsx:182-213`),
  including the wrap-to-first-unpaid case announcing that it moved backwards. It reads
  like someone actually paid a roster with a skipped pilot in it.
- **`NotesForm`'s "· saved" as a value comparison rather than a dirty flag**
  (`notes-form.tsx:101-117`). It is correct in the case where the operator keeps
  typing during the round trip, which is the case a boolean gets wrong.
- **The one-slot `AppraiseForm`** (`page.tsx:782-790`) — collapsed presentation as a
  prop rather than a second call site, so the dropped-lines effect survives the first
  paste. Any fix pass that splits this back into two call sites reintroduces a silent
  data-loss notice.
- **Amount as `numeric(20,2)` strings and bigint cents throughout.** No floats touch
  money on the read side either.

## What I could not evaluate

- **Weighted shares.** The fixture writes `amount` directly
  (`docs/design-sweep-2/capture.spec.ts.txt:210-222`) rather than through
  `recalculate`, and gives one participant `shares: "2"` while paying them the same
  `each` as everyone else. So the screenshots show a 2.00-share row with a 1.00-share
  amount. I confirmed this is a fixture artifact and **not** a product bug —
  `core/payout-split.ts:73` computes `perShare * shares` correctly. But it means
  **neither shot exercises a non-flat split**, so I cannot say how the AMOUNT column
  reads when the figures actually differ row to row. That matters directly to finding
  4: my proposed norm-plus-deviation treatment is right for a flat split and needs
  re-checking against a genuinely weighted one. Re-seed with `setParticipantShares`
  before acting on finding 4.
- **The empty operation.** No shot of an operation with no pools and no roster, which
  is `primaryStage: "appraise"` — the first thing an operator ever sees after creating
  one, and the state where `hasFacts` is false and most of the page is absent. The
  onboarding path is unreviewed.
- **The member (non-operator) view.** Every shot is an operator. `canEdit` false strips
  30 of the 70 controls, which would materially change finding 7's count and may make
  findings 4 and 5 worse rather than better — a member's roster is three columns of
  near-identical values and no actions at all.
- **Arm-state rendering.** No shot shows a `ConfirmSubmit` armed, so I could not judge
  whether `confirm` reads as a distinct state in a row of `EXCLUDE  REMOVE  REMOVE`
  at the micro grade, or whether `.btn--danger` on `mark paid` reads as alarm at 28px.
- **The 320px case.** Both narrow shots are 390px. Finding 1's overflow is already
  1.98× the viewport there; I did not measure 320px, where it will be worse and where
  the reflow criterion is actually set.
- **Motion.** No transitions are visible in stills, and I did not run the app.

## Contested

Nothing. The two settled items that touch this surface — `ConfirmCost`'s `"visible"`
mode for Finalize/Unlock, and the one-gold-per-view ration — I think are both right,
and finding 1(a) is compatible with the first: the caption should stay permanently
visible and should also be allowed to wrap.

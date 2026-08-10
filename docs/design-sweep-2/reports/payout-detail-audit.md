# `/payouts/[id]` — audit

`$impeccable audit` · register: **product** · read-only pass · re-run 2026-08-10.

This is a re-run. It consolidates the first pass with a second, pixel-led pass
over the same four shots, so it supersedes rather than appends. Where the two
passes disagreed, the disagreement is resolved in the text and the resolution is
stated. Two things changed materially: **finding 1's mechanism is now settled**
(the first pass named the right rule; the second pass measured the consequence
and confirmed it against the CSS), and **four findings are new**, all of them
about classes this table borrows from `/admin/accounts` whose stated
preconditions are false here.

Source read in full: `src/app/payouts/[id]/page.tsx` (1282 lines) and every
co-located component, plus `_components/confirm-submit.tsx`, `confirm-group.tsx`,
`submit.tsx`, `submit-guard.ts`, `scroller.tsx`, `ui.tsx`, and the relevant
`globals.css` blocks. Screenshots looked at before any file was opened.

## What the shots show, before any explanation

Both viewports are a single unbroken vertical run: a name, a date, a summary
line, then five ruled sections stacked one under another for 2900px (wide) /
4000px (narrow). The wide draft holds a 78rem column that the loot table and the
roster fill edge to edge, so **pattern 1 (unshaped field) does not apply here** —
this surface is the opposite problem. Every section is dense and every section is
the same density. One gold button (FINALIZE) sits a ninth of the way down; below
it, seventy controls at one uniform quiet weight. The eye lands on the gold and
then has nothing else to hold it.

The narrow shots gave the first hard finding before a line of source was read.
`fullPage` capture writes the document's scroll width, so the file dimensions are
a measurement:

```
06-payout-detail-draft.narrow.png       771 x 4027   <-- +381px past the viewport
07-payout-detail-finalized.narrow.png   522 x 3944   <-- +132px
11-admin-sync.narrow.png                411 x 1686
every other surface in the sweep        390 x ...
```

The site header bar in `06-payout-detail-draft.narrow.png` paints to x=390 and
stops; the document runs on to 771. **This page horizontally scrolls on a phone
and no other page in the app does.** Scanning the narrow draft for painted pixels
past x=390 returns exactly two bands — `y 767–777` reaching x=770, and
`y 1304–2225` reaching x=563 — which are findings 1 and 2, and nothing else.

## Dimension scores

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3 | Focus management and live regions are unusually strong; reflow and in-flight feedback are not |
| 2 | Performance | 3 | ~70 client component instances on a read-first page; no images, no animation cost |
| 3 | Responsive | 1 | Document is 771px wide at a 390px viewport, from two independent sources |
| 4 | Theming | 4 | Every colour is a token; no hard-coded value anywhere in this route |
| 5 | Anti-patterns | 4 | No cards, no gradients, no glass, no hero metric. Reads as authored |
| **Total** | | **15/20** | Good — one dimension is dragging the rest down |

---

## Findings

### 1. The page scrolls horizontally at every viewport under about 800px, because Finalize's caption cannot wrap

- **Severity:** Critical
- **Where:** `src/app/globals.css:2974-2977` (`.btn-row--tight { flex-wrap:
  nowrap; white-space: nowrap }`), inherited into
  `src/app/payouts/[id]/page.tsx:508` →
  `src/app/payouts/[id]/lifecycle-submit.tsx:139-156`.

  `.btn-row--tight` sets `white-space: nowrap` for the reason its own comment
  gives: *"Row actions sit in the narrowest column in the table, and the browser
  will happily squeeze them into a vertical stack. Keep them on one line."*
  `page.tsx:508` wraps Finalize/Unlock in it — but that control does not sit in a
  table row, and inside it hangs `LifecycleSubmit`'s
  `<ConfirmCost visibility="visible">`, a 137-character sentence. `white-space`
  inherits, the span cannot break, and its max-content becomes the automatic
  minimum size of every box between it and the page column.

  Measured, not asserted. At 1440 the caption runs x=120 → x=874: **754px on one
  line.** At 390 the whole document is 771px wide and the only content reaching
  that far is that same line — 16px of page padding plus 754 of unbreakable
  sentence. Its tail, "and permanent after that.", is off-screen. The content
  column is `viewport − 48px` at wide and `viewport − 32px` at narrow, so the
  document overflows at any viewport below roughly 800px: 320px, 390px, a 768px
  tablet, and **200% zoom on any display narrower than about 1600 physical px**.
- **Cost:** An operator finalizing from a phone, or anyone at 200% zoom, reads
  "Closes the pools, roster and shares to editing. Reversible with Unlock until
  the first payment is recorded, and permanent…" and the sentence walks off the
  screen exactly where it was about to say the part that matters. The whole point
  of `visibility="visible"` — settled, and not challenged here — is that this copy
  reaches sighted operators; at these widths it does not. Every other section of
  the page then inherits a 380px horizontal scroll it has no use for, so a
  vertical scroll that catches any horizontal component drifts the entire ledger
  sideways under the reader's thumb.
- **Fix:** Take `.btn-row--tight` off `page.tsx:508`. The lifecycle row holds one
  button — Finalize and Unlock are mutually exclusive by construction
  (`canFinalize` wants a draft, `canRelease` a finalized operation), so there is
  nothing for `nowrap` to keep on one line and nothing for `flex-wrap: nowrap` to
  hold either. A plain `.btn-row` is enough. If the class must stay, add
  `white-space: normal` to `.confirm-cost` (`globals.css:961`), which is correct
  for a prose caption in any context.
- **Principle:** WCAG 2.2 AA 1.4.10 Reflow and 1.4.4 Resize Text. Neither
  exemption reaches a prose sentence.

### 2. Each loot pool's item table escapes its own scroll region and widens the document instead of scrolling inside it

- **Severity:** Critical
- **Where:** `src/app/globals.css:4859-4862` (`.pool-items { display: grid; gap }`)
  holding `src/app/payouts/[id]/page.tsx:684` (`<Scroller label={"Pool N items"}>`).

  `.pool-items` is a grid; the `.scroller-frame` inside it is a grid item whose
  `min-width` is `auto`, so its floor is the item table's min-content width and
  the track grows past the container. The `Scroller` never gets to scroll: its
  scrollport is as wide as its content.

  This is a known-at-authoring-time risk fixed at one of the two sites it applies
  to. `globals.css:4583` says it in as many words: *"of the ten Scroller call
  sites, only two sit in a grid or flex parent where the floor can bite at all —
  this one and `.pool-items` on the payout detail page."* `.drawer__crew` got
  `min-width: 0` (`globals.css:4607`). `.pool-items` did not.

  Measured: in `06-...narrow.png` the bands covering the Pool 2 item table
  (y 1304–2225) reach x=563 against a content right edge of x=373 — 190px of
  escape. In `07-...narrow.png` the Pool 1 table reaches x=521 and is what sets
  that document's entire 522px width.
- **Cost:** Three compounding losses, and the third is the one nobody would guess.
  (a) The page scrolls horizontally rather than the region, so panning to read a
  line total drags the section headers and the roster with it. (b) The `Scroller`'s
  edge fades never appear, because `scrollWidth === clientWidth` — the one
  affordance that says "there is more this way" is silent precisely when there is
  more. (c) `scroller.tsx:95` withdraws the region's tab stop when it measures no
  scroll range, so a **keyboard operator loses the tab stop into the pool item
  table entirely**, on the surface where the per-item `edit` price controls live.
- **Fix:** `.pool-items .scroller-frame { min-width: 0 }`, mirroring
  `globals.css:4607` at the site that rule's own comment already names.
  `.pool-items { grid-template-columns: minmax(0, 1fr) }` is the equivalent fix
  one level up and either works. Add the assertion to whichever e2e 320px spec
  covers this route; note that fixing this *changes* whether the region has a tab
  stop, which is the correct direction but is a behaviour change worth pinning.
- **Principle:** WCAG 2.2 AA 1.4.10 Reflow, and 2.1.1 Keyboard for the lost stop.

### 3. At 390px the roster spends 75% of its visible width on two columns that carry one fact, and hides the column that answers the question

- **Severity:** Serious
- **Where:** `src/app/payouts/[id]/page.tsx:913-928` (column order:
  Name / Shares / Amount / State / actions); visible in
  `07-payout-detail-finalized.narrow.png`.

  Measured off that shot: the scroll region runs x=35→374, and the column rules
  fall at Name 35–121 (86px), Shares 121–190 (69px), Amount 190–374 (184px).
  **Shares + Amount = 253px of a 339px region.** STATE and the whole action cell —
  `copy amount`, `mark paid`, `revert`, `exclude`, `remove` — begin past the end
  fade. Unlike findings 1 and 2 this is a deliberate scroll inside a labelled
  region, which the settled constraints permit; the defect is *which* columns were
  left outside.

  The visual tell is in the crop: Bad Scout's row is roughly three times the
  height of Booster Alt's and nothing on screen explains why. The cause is the
  hidden STATE cell, where a paid row carries a three-line payment sentence
  (finding 5). The reader gets the rhythm of the data without the data.
- **Cost:** A member opening a payout link on a phone at 1am — the session
  PRODUCT.md describes — cannot answer "was I paid?" without discovering a
  sideways scroll and panning past two columns, one of which says `1.00` on
  fifteen of sixteen rows. An operator on a phone cannot reach `mark paid` at all
  until they pan, and the region scrolls back for the next row.
- **Fix:** Move STATE ahead of SHARES. State is the only cell that varies for a
  reason the reader came for; Shares is the *input* to Amount, which sits next to
  it. `Name / State / Amount / Shares / actions` puts a phone's three visible
  columns on identity, answer, and figure. If Shares must stay beside Amount it
  reads fine as a suffix (`288,600,000.00 ISK ×2`) and gives the column back.
  Below 40rem, rendering STATE inside the pinned NAME cell under the name is the
  stronger version of the same move and is what `.log--payouts`
  (`globals.css:1315-1322`) already reasoned toward for `/payouts` — "a pin hides
  nothing from anyone", except here the pin is holding the wrong fact. Do **not**
  promote NAME to `<th scope="row">` as part of this: `.log th` carries
  `white-space: nowrap`, and this column already holds an unbounded
  operator-typed name plus a parenthesised alt list.
- **Principle:** PRODUCT.md principle 2, "state before action", and principle 3.
  WCAG 1.4.10 is satisfied by the region, so this is a priority defect rather
  than a conformance one.
- **Fixture caveat, per the brief:** the payout fixture writes `amount` directly
  and never runs `recalculate`, so AMOUNT is identical on every row in the shot
  *including* Hurricane Main's 2.00-share row. Under a real weighted split Amount
  varies and earns its place. This finding does not rest on that — it rests on
  Shares (genuinely constant) preceding State (genuinely varying) at a viewport
  where three columns fit. Finding 5's Amount half does rest on it, and says so.

### 4. Nothing on this page shows an action is in flight, and a refused second press is completely silent

- **Severity:** Serious
- **Where:** whole surface. Concretely: `page.tsx:1063-1072` (`exclude`),
  `pay-flow.tsx:326-334` (`mark paid`), `:353-359` (`revert`), `:397-403`
  (`remove`), `pool-flow.tsx:149-155` (`delete`), `lifecycle-submit.tsx:147-152`
  (Finalize/Unlock), `page.tsx:1171-1177` (Replace roster), `page.tsx:1260-1267`
  (Delete operation).

  Every one passes no `pendingLabel`. `Submit`'s own docblock
  (`submit.tsx:14-19`) states the contract: the button is deliberately not
  disabled, so *"`pendingLabel` and `aria-busy` are the whole of the in-flight
  signal"*. With no `pendingLabel`, `aria-busy` is the whole of it — and
  `aria-busy` renders nothing. Three controls on the page do it right (`open
  info`, `saving…` in `InlineEdit`, `Pricing…` in `AppraiseForm`), which makes
  the omission read as drift rather than a decision.

  The second half is specific to this route. `ConfirmSubmit` reports a
  guard-refused press through `useConfirmReport()` (`confirm-submit.tsx:394`),
  which resolves to `null` unless a `ConfirmGroup` is above it. **No
  `ConfirmGroup` is rendered anywhere on `/payouts/[id]`** — the component is
  rendered by `/admin/accounts`, `/admin/sync` and `/admin/access-lists` only;
  this route mentions it in comments and never mounts it. So every refused press
  here vanishes.

  `submit-guard.ts`'s docblock justifies that silence: *"a `ConfirmSubmit` in a
  plain redirecting form still refuses silently"* — the navigation is the
  feedback. **That premise is false on this page.** `markPaidAction`,
  `revertPaymentAction`, `removeParticipantAction`,
  `setParticipantExcludedAction`, `finalizeAction`, `unlockAction` and
  `deletePoolAction` all end in `revalidateOperation` and do not redirect. The
  page does not move. `deleteOperationAction` is the sole exception.
- **Cost:** An operator paying fifteen people presses `mark paid`, the round trip
  takes a few hundred milliseconds against a database transaction, nothing on
  screen changes, and they press again. The second press is correctly refused and
  correctly invisible — so the button reads as dead on a money control. This is
  the exact failure `NotesForm` opted into `onRefused` to fix
  (`notes-form.tsx:69-81`), on the same page, for a lower-stakes control.
- **Fix:** Two independent changes. (a) Give the eight controls a `pendingLabel`
  ("paying…", "reverting…", "removing…", "finalizing…"). Note
  `confirm-submit.tsx:290-294`: `pendingLabel` is outside the ghost-label width
  reservation, so a longer pending word reflows the button — reserve for it or
  keep the words at or under the rest label's length. (b) Wrap the roster and the
  lifecycle block in a `ConfirmGroup`, or extend `onRefused` to `ConfirmSubmit`
  as an explicit prop, so the refusal lands somewhere.
- **Principle:** WCAG 2.2 AA 4.1.3 Status Messages for the refusal.

### 5. The State column recites one identical payment sentence on every paid row

- **Severity:** Serious
- **Where:** `src/app/payouts/[id]/page.tsx:993-996` →
  `src/app/payouts/[id]/payment-history.tsx:36-46`.

  This is the sweep's pattern 2 in its most literal form on any surface here. In
  `07-payout-detail-finalized.wide.png`, six rows each render:

  > `2026-08-10 11:57:07 UTC` paid `288,600,000.00 ISK` by Fleet Commander

  Same timestamp to the second, same actor, six times — and the amount repeats
  the AMOUNT cell two columns to the left, verbatim, in the same row.

  `PaymentHistory` renders inline rather than behind a `Disclosure` when there is
  exactly one payment, and the reasoning at `payment-history.tsx:47-52` is sound
  for a single row read alone: a fold with nothing folded. It does not hold for
  sixteen of them read as a column.
- **Cost:** The operator's job on this table is to find the rows that are *not*
  paid. Six rows carry three lines each of text that says nothing distinguishing,
  the unpaid rows carry one, and the eye sorts them by row height — an artefact,
  not a design. On a sixteen-person roster this is four screens where one would
  do, and at 390px it is the invisible cause of finding 3's ragged rows.
- **Fix:** `crewNorms` in `src/app/account/page.tsx` is the pattern the brief
  names and it transfers directly. Derive the shared facts once — the pay run's
  instant and the actor — and say them in the section header beside the existing
  `6/15` aside: "paid 2026-08-10 11:57 UTC by Fleet Commander". Then each row's
  STATE cell holds `PAID` alone, and only a row that *deviates* (a different
  actor, a different instant, an amount that differs from that row's own AMOUNT
  cell) spells its sentence out. Keep both channels in parity the way
  `/admin/sync`'s "Cadence (UTC)" does: a `visually-hidden` span per row
  restoring the full instant, so the audit-grade detail is not lost to a screen
  reader.
- **Principle:** PRODUCT.md principle 3, "scanning is the primary act".
- **Fixture caveat:** the per-share amount is *not* safe to hoist into the header
  as a shared fact — the fixture's uniform amounts are an artefact of `amount`
  being written directly with no `recalculate`, and under a real weighted split
  Hurricane Main's 2.00 shares would pay double. Hoist the instant and the actor;
  leave the money per row.

### 6. The roster borrows `.log--dense`, whose `vertical-align: middle` is documented as safe *because* its cells are never multi-line — and this table's State cell is three lines on every paid row

- **Severity:** Moderate — **new in this re-run**
- **Where:** `src/app/payouts/[id]/page.tsx:913` (`log--dense` on the roster)
  meeting `src/app/globals.css:1219` (`.log--dense td { vertical-align: middle }`).
  That rule states its own precondition: *"Middle alignment is safe here — unlike
  `.log--audit`, this table's cells are all short, single-purpose values, never
  the multi-line blobs top alignment exists for."* The roster's State cell holds
  `Status` **plus** `PaymentHistory` (`page.tsx:993`), which is three wrapped
  lines on every paid row in the wide shot.
- **Cost:** Inside each paid row, Name / Shares / Amount are optically centred
  against a `● PAID` token sitting at the top of its cell — so the column of
  names loses its baseline against the column of states, in the one table where
  reading across a row is the task. The ragged look survives even if finding 5 is
  fixed, because a deviating row will still be multi-line.
- **Fix:** Give the roster its own density rule keyed to `.log--roster` — the
  class already exists at `page.tsx:913` — carrying `.log--dense`'s padding and
  `vertical-align: top`, and drop `log--dense` from the element. This is exactly
  the call `.log--manifest` (`globals.css:1381`) and `.log--payouts`
  (`globals.css:1289`) each already made, in comments that argue explicitly
  against borrowing the accounts table's class for this reason. The roster is the
  one table that borrowed it anyway.

### 7. At 390px the loot table's first row is 130px tall and shows nothing, because an invisible prose column sets its height

- **Severity:** Moderate — **new in this re-run**
- **Where:** `src/app/payouts/[id]/page.tsx:581` and `:605` — the `Notes` column,
  rendered when `anyPoolNotes` (`:275`). In `06-payout-detail-draft.narrow.png`
  the pool-1 row occupies y≈880–1010 with `1 ▲FLAT (MANUAL)` on the first line and
  blank ground below it; the note that sets the height ("Citadel rigs, priced by
  hand off contracts") is off-screen right along with the Value cell.
- **Cost:** A member scrolling the operation on a phone meets the loot summary as
  a mostly-empty box whose largest feature is a gap, with nothing on screen to
  explain it — the cause is a column they cannot see. A third of a phone screen
  spent displaying two words.
- **Fix:** The notes are prose about one pool, not a fact that varies across a
  column — `anyPoolNotes` at `:275` already concedes this ("almost never has
  any"). Render the note under the source token in the Source cell, the same shape
  the item rows already use for their `manual` / `unresolved` markers. That
  removes the column, the conditional and the height it sets, at every viewport.
- **Principle:** the same argument `page.tsx:703-719` gives for deleting the
  "Price source" column — a column spent on the rare row that has one.

### 8. Seventy pressable things, sixty-two of them the same 28px quiet grade

- **Severity:** Moderate
- **Where:** whole surface — the finding the brief asked for by name, and it has
  no single line.

  Counted off `06-payout-detail-draft.wide.png` (16 participants, 2 pools, 10
  items), excluding the header nav: 4 standalone `edit` triggers (name, date, corp
  share, battle report), FINALIZE, 2 pool `delete`, 10 per-item `edit`, 3
  disclosure summaries, 48 roster controls (16 × `edit` + `exclude` + `remove`),
  Save, Delete. **Seventy.** Add three `Scroller` tab stops and the battle-report
  link and a keyboard operator has 74 stops between the top of the page and the
  Notes field. Sixty-two of the seventy are `.btn--quiet .btn--micro` —
  transparent, borderless, `--ink-faint`, 28px. One is gold.
- **Cost:** An operator scanning the roster for the row they need to act on reads
  a wall of identical grey verbs. A keyboard operator wanting the Notes field tabs
  through all forty-eight, and a screen-reader user hears each named on the way.
- **Fix:** Fold `exclude` and `remove` behind a per-row disclosure the way
  `/admin/accounts` folds its row controls into a drawer, leaving `edit` shares in
  the row. That takes the roster from 48 controls to 32 and returns the row to one
  action plus one disclosure. The `Disclosure` primitive, the arm scope and
  `PayFlow`'s focus restoration all already handle the drawer shape. Whatever the
  fix, do not remove a `RuleHead` heading or a `Scroller` label while tidying —
  heading and landmark navigation are what make 70 stops survivable, and they are
  the existing escape hatch.
- **Principle:** the sweep's pattern 3. Note `primaryStage` (`page.tsx:226-255`)
  is good and is not what this finding is about — see "what must survive".

### 9. `remove` never changes appearance when armed, and the shared component's docblock asserts the opposite

- **Severity:** Moderate
- **Where:** `src/app/payouts/[id]/pay-flow.tsx:397-403` against `:353-359` and
  `src/app/payouts/[id]/pool-flow.tsx:149-155`; the false claim is at
  `src/app/_components/confirm-submit.tsx:249`.

  `RevertForm` and `DeletePoolForm` pass `armedClassName="btn btn--micro
  btn--danger"`. `RemoveParticipantForm` passes none, so `ConfirmSubmit` falls
  back to `armedClassName ?? className` and the armed control renders exactly as
  it did at rest. `LifecycleSubmit` has no `armedClassName` parameter at all
  (`lifecycle-submit.tsx:147-152`), so armed Finalize stays gold and armed Unlock
  stays plain. `confirm-submit.tsx:249` states: *"No caller now keeps the same
  class in both states."* Three callers on this page do.

  The only cue that `remove` is armed is the word changing from "remove" to
  "confirm" — and the ghost-label width reservation
  (`globals.css:2776-2790`) means the button does not even change size while it
  does so.
- **Cost:** In a sixteen-row column of near-identical grey verbs, one word going
  from six letters to seven is not a state change anyone notices. An operator who
  armed row 9 and looked away comes back unable to see anything is armed, and
  their next click on that row deletes a participant. `remove` is the one control
  here with no undo path on the page.
- **Fix:** Give `RemoveParticipantForm` the same `armedClassName` its two
  structural siblings use, and correct the docblock claim — or, if Finalize and
  Unlock keeping their grade is deliberate, say that there instead of asserting
  the universal.
- **Principle:** WCAG 2.2 AA 3.2.4 Consistent Identification for the sibling
  mismatch.

### 10. `.btn--danger-quiet` is pixel-identical to plain `.btn--quiet` until you hover or focus it

- **Severity:** Moderate
- **Where:** `src/app/globals.css:2904-2920`.

  **Contrast is not the problem — it passes comfortably.** Converted to rendered
  sRGB: `--ink-faint` is `#90877e`, and against `--void` `#0a0a0a`, `--hull`
  `#151514` and `--hull-hi` `#21201f` it measures **5.61:1 / 5.18:1 / 4.61:1**.
  All clear 4.5:1, including on a hovered row. The hover colour `--signal-bad`
  `#f05751` measures 5.83 / 5.38 / 4.79.

  What is gated on hover is the *meaning*. `.btn--danger-quiet` sets only
  `color: var(--ink-faint)` at rest, the identical value `.btn--quiet` already
  takes (`globals.css:506-508`). So in the roster action cell, `exclude` (plain
  quiet) and `remove` (danger-quiet) are the same colour, size, weight and
  absence of border. Red arrives on `:hover` and `:focus-visible` and nowhere
  else.
- **Cost:** On a touch device there is no hover, so the destructive grade is
  invisible until the control is pressed — and by then arming has happened. A
  member on a phone sees `exclude` and `remove` as one undifferentiated pair.
- **Fix:** Not a colour retune (out of scope, and the value is fine). Give
  `.btn--danger-quiet` a rest-state carrier that survives no-hover: the
  `--rule-strong` border it already takes in the accounts drawer variant
  (`globals.css:1625`), applied to the roster case too, so a destructive control
  at least reads as an edged control among borderless ones.
- **Principle:** none cleanly — WCAG 1.4.1 is not violated, since the labels
  differ in text. This is a consistency finding without a conformance citation.

### 11. Six `&&`-mounted `Notice`s, and the navigation that used to excuse them is gone

- **Severity:** Moderate — **and this explicitly re-opens a closed item.**
- **Where:** `src/app/payouts/[id]/page.tsx:357`, `:387`, `:625`, `:650`,
  `:1106`, `:1123`. Only `page.tsx:355` mounts unconditionally.

  Stating the closure honestly: `docs/design-sweep/SYNTHESIS.md:338-350` ruled on
  this. It verified three `tone="bad"` sites (one of them this page's, since
  fixed — line 355 is now correct) and explicitly set the block-level
  conditionals aside as *"a real but different finding — those notices arrive
  through a navigation."*

  **The new evidence is that the premise no longer holds.** Since that sweep,
  `AppraiseForm` stopped redirecting: `appraise-form.tsx:111-115` pushes the
  dropped payload with a same-route `router.replace(..., { scroll: false })`,
  chosen precisely so the route tree is *not* replaced (its docblock argues this
  at length — a redirect would collapse every `Disclosure`).
  `addParticipantAction` and `setRosterAction` revalidate in place. So the
  `?dropped=` notice at `:357` and the unresolved-items notice at `:625` now
  appear inside a tree that never remounted, born holding their text — the exact
  shape the primitive exists to prevent, arriving by the exact route the earlier
  ruling said it did not.
- **Cost:** An operator pastes loot with two unresolved items. Sighted, they see
  the orange warn box. Using a screen reader they hear nothing: the pool total is
  short by whatever those items are worth and the tool did not say so.
- **Fix:** Mount all six unconditionally and move the condition inside, the way
  `appraise-form.tsx:145-147` already does within this same route:
  `<Notice tone="warn">{droppedReport ? <span>…</span> : null}</Notice>`. The
  empty slot is out of flow and draws nothing, so spacing is unchanged.
- **Principle:** WCAG 2.2 AA 4.1.3 Status Messages.

### 12. A successful "Add participant" announces nothing and moves no focus

- **Severity:** Moderate
- **Where:** `src/app/payouts/[id]/add-participant-form.tsx:61-63`.

  Every other roster mutation here is meticulous about this. `PayFlow` announces
  `"Removed X. N participants remain."` and lands focus on the next row
  (`pay-flow.tsx:222-247`); `PoolFlow` does the same for a deleted pool;
  `LifecycleSubmit` announces and focuses the H1. Add is the odd one out: on
  success it clears the input and returns. Focus stays on the button, and the
  only signal is a text field emptying — which is also what a rejected-then-
  retyped field looks like mid-edit.
- **Cost:** A screen-reader operator building a roster one name at a time cannot
  tell an add that landed from one that did not, on a form whose whole reason for
  existing (`page.tsx:820-829`) is that it is the only way to add someone without
  discarding share edits.
- **Fix:** A `role="status"` span in this form, written on `state.ok` with
  `Added {name}. {n} participants.` — the successful `FormData` is in hand at
  `:61`. The clear-then-set idiom from `pay-flow.tsx:109-113` handles two adds of
  the same name.
- **Principle:** WCAG 2.2 AA 4.1.3 Status Messages.

### 13. The roster takes the accounts table's `scroll-margin-left: 10rem` by class inheritance, and its pinned column measures 169px

- **Severity:** Minor — **new in this re-run**
- **Where:** `src/app/globals.css:2006` — the selector is
  `.log--dense.log--sticky-col …`, and its comment says *"Scoped per table rather
  than set once on `.log--sticky-col`. **Both tables** share that class and pin a
  first column of a different width (audit's is a fixed 12.25rem; the accounts
  table's is auto-sized around a name)."* There are three such tables now; the
  roster is the unmentioned one and it inherits the accounts figure through
  `.log--dense`. Measured on `07-payout-detail-finalized.wide.png`: the table's
  vertical rules fall at x=120 / 289 / 1319, so the pinned Name column is
  **169px** — 9px past the 10rem the rule reserves.
- **Cost:** A keyboard operator at a mid-width window (wide enough that the
  roster's ~1199px of columns overflows, narrow enough that Name is still near
  its content width) Shift+Tabs from a row's `exclude` back to that row's shares
  `edit` and lands with the control parked ~9px under the pinned column — focus
  ring drawn, partly invisible. Small today; the gap grows with the data, because
  this column holds `displayName` (operator-typed free text, uncapped for an
  unresolved name) plus a comma list of source characters, where the accounts
  table's pin is bounded by an EVE character name.
- **Fix:** Add a `.log--roster.log--sticky-col` branch beside the audit and
  accounts ones with its own figure, over-estimating on purpose the way that
  rule's comment already argues for. If finding 6's `log--dense` removal lands
  first, this rule stops matching the roster at all and the branch becomes
  required rather than corrective.
- **Principle:** WCAG 2.2 2.4.11 Focus Not Obscured (Minimum) — the near-miss the
  rule exists to prevent.

### 14. `log--sticky-head` is inert on the roster at the size the roster usually is

- **Severity:** Minor — **new in this re-run**
- **Where:** `src/app/payouts/[id]/page.tsx:911` —
  `tall={participants.length > ROSTER_TALL_THRESHOLD}` with the threshold at 20
  (`:117`) — meeting `:913`, which sets `log--sticky-head` unconditionally. Below
  21 participants the `Scroller` gets no `.scroller--tall` and so no height cap;
  `globals.css:1787` states the consequence directly (*"scrollHeight equals
  clientHeight and `top: 0` has nowhere to go"*). The 16-row fixture is in that
  regime, so nothing in either shot is pinned.
- **Cost:** At 390px the 16-row roster is roughly 1,700px tall. A member scrolling
  it passes the header row within one screen and reads the rest — the table they
  must also pan sideways (finding 3) — with no column labels anywhere on screen.
  The threshold was chosen against desktop height; it does not describe a phone.
- **Fix:** Make `tall` viewport-aware rather than count-only, or lower the
  threshold to something that reflects a roster taller than a phone screen. The
  threshold *idea* is right and the Aug-5 sweep was right to defend it — this is
  about the constant, not the mechanism. Related and still open from that sweep:
  the pool-items table (`page.tsx:685`) is the page's longest table and is the one
  with no sticky head at all (Aug-5 audit finding 6, unfixed).

### 15. The H1's accessible name includes a button label

- **Severity:** Minor
- **Where:** `src/app/payouts/[id]/page.tsx:293-301`. While `canEdit`, the H1
  wraps an `InlineEdit`, which renders the value, an `edit` button and a
  `role="status"` span as children of the heading. The computed name becomes
  "Wormhole eviction — J155843 edit". When editing opens, the H1 contains a
  `<form>`, an `<input>`, two buttons and a `role="alert"`.
  `LifecycleSubmit` focuses `#operation-name` after finalize
  (`lifecycle-submit.tsx:144`), so a screen reader lands here and reads the
  trailing "edit" as part of the operation's name.
- **Cost:** Small and constant: every heading announcement on the page's most
  important element carries a stray verb.
- **Fix:** Move the `InlineEdit` beside the `<h1>` rather than inside it, keeping
  the plain name in the heading. The `id`/`tabIndex` contract
  `lifecycle-submit.tsx` depends on stays on the `<h1>` either way.
- **Principle:** WCAG 2.2 AA 4.1.2 / 1.3.1.

### 16. `ConfirmArmScope` hands out a fresh context value on every render

- **Severity:** Minor
- **Where:** `src/app/_components/confirm-submit.tsx:49-60`. The provider's
  `value` is an object literal containing two fresh closures, so every arm and
  disarm invalidates it for every consumer. On this page the scope wraps the
  entire content (`page.tsx:419-1278`), so a single arm re-renders roughly twenty
  `ConfirmSubmit`s and three `ConfirmCost`s. `PayFlow` (`pay-flow.tsx:249-254`)
  and `PoolFlow` (`pool-flow.tsx:111-114`) both memoize their context value and
  both leave a comment explaining that context consumers are exempt from the
  children-as-prop bailout. That reasoning applies here identically.
- **Cost:** Not user-visible today; the re-renders are cheap. Recorded because it
  is the largest provider on the largest page and the two smaller providers beside
  it took the opposite decision with a written rationale.
- **Fix:** `useMemo` on `[armed]`, with `arm`/`disarm` in `useCallback`.

### 17. `.copy-result` reserves 5rem on every roster row, permanently

- **Severity:** Minor
- **Where:** `src/app/globals.css:3043-3047`, rendered at
  `copy-amount-button.tsx:88-90`. The reservation is right in principle — its
  comment explains that "copied" appearing must not shove the neighbouring
  controls — but it costs 80px of empty width in each of fifteen action cells,
  always, and that width is part of what puts the action column past the narrow
  viewport in finding 3.
- **Fix:** Reserve inside the button's own row rather than as a sibling, or render
  the result absolutely positioned over the reserved gap so it occupies no inline
  size at rest.

### 18. `CopyAmountButton` sets both `role="status"` and `aria-live="polite"`

- **Severity:** Minor
- **Where:** `src/app/payouts/[id]/copy-amount-button.tsx:88`. `role="status"`
  already implies `aria-live="polite"`, and every other live region in this route
  uses the role alone. Harmless drift — but on a finalized page there are fifteen
  copies of it.

---

## What is genuinely good and must survive

**The focus-restoration architecture is the best work in this codebase and none
of the fixes above should touch it.** `PayFlow` and `PoolFlow` host their effects
*above* the lists whose rows unmount, drive them from server-rendered state
rather than an optimistic promise, compute the next focus target before the
removal so the pre-removal ordering is still available, and — the detail I would
not have thought of — resume the pay run from where the operator was rather than
from the first unpaid row, wrapping to the top only when nothing is left below,
and *saying so out loud* when it wraps (`pay-flow.tsx:185-208`). The Aug-5 audit's
finding 2 ("focus is destroyed on every control that removes itself") is
comprehensively closed. Do not fold the two split effects into one.

**`useOptimistic` was rejected for a money ledger, on the record**
(`pay-flow.tsx:69-74`). The live region can only claim a payment on a render
where the server says it landed. Keep that.

**One `ConfirmSubmit` component type in the mark-paid slot**
(`pay-flow.tsx:284-288`) rather than a ternary between component types. That is
the #146 fix and it is invisible in the diff that would undo it.

**`.inline-edit--standalone .btn--quiet { min-height: 2.25rem }`**
(`globals.css:2838`) with `standalone={false}` passed only at the two genuine
in-row sites (`page.tsx:749`, `:967`). The 36/28 split is correct here and
correct for the stated reason, not by accident.

**`ConfirmSubmit`'s ghost-label width reservation.** The `content: attr(...)`
approach (`confirm-submit.tsx:256-284`) is correct, and the reasoning for why a
hidden real element would not work — generated content is invisible to
Playwright's text engine where a `visibility: hidden` span is not — is worth
keeping written down.

**No arm timer.** `confirm-submit.tsx:33-39` refuses a 4-second auto-disarm on
WCAG 2.2.1 grounds and covers abandonment with blur, Escape and pointer-leave
instead. Correct, and correctly argued.

**Contrast across this route passes with margin.** Every token converted to sRGB
and checked against all three grounds. Worst case anywhere on this surface is
`--ink-faint` `#90877e` on `--hull-hi` `#21201f` at 4.61:1 — a hovered row's quiet
control, still over the 4.5 floor. `--rule-strong` `#787370` holds 3.47:1 against
`--hull-hi` for the scroll region's boundary, over the 3:1 that 1.4.11 asks. No
hard-coded colour appears anywhere in this route.

**The one-gold-control-per-stage rule** (`page.tsx:226-255`) and the decision to
leave Unlock and the payment controls plain, with `primaryStage` surfaced in the
summary line as `· next: finalize`. Finding 8 is about the sixty-two controls
below it, not this.

**`LifecycleAnnouncer` mounted outside the `showLifecycle` gate**
(`page.tsx:505`), and `#mark-paid-cost` rendered once and shared
(`page.tsx:1099`) rather than per row.

**Per-row accessible names that name the subject** — `confirm revert payment for
{name}`, `copy amount for {name}`, `unit price for {item}`. With 48 roster
controls this is the difference between usable and not.

**`Notice` at `page.tsx:355` is mounted unconditionally** — the fix from the last
sweep held. Finding 11 is about the other six, not a regression of this one.

---

## What I could not evaluate

- **The arm-then-press flow with an actual screen reader.** The live regions, the
  `restName`/`confirmName` pairs and the `aria-describedby` wiring are
  structurally right, but "does NVDA re-announce this" is not a claim source and
  screenshots can support. Per project memory there is no jsdom here, so this
  needs Playwright plus a real AT harness.
- **Hover, focus and armed states generally.** Every shot is a rest-state capture.
  Findings 9 and 10 are read from CSS and from what the shots prove about the rest
  state; no armed button was rendered.
- **200% zoom directly.** Finding 1's 1.4.4 consequence is derived from the
  measured 754px caption against the content column rather than captured at zoom.
  The arithmetic is stated so it can be checked.
- **Hydration and interaction cost.** The Aug-5 audit left this open and this pass
  only narrows it: the fixture's draft ships ~70 `Submit`/`ConfirmSubmit` leaves,
  3 `ResizeObserver`s, and — once finalized — 15 `CopyAmountButton`s each with its
  own `role="status"`, i.e. ~23 polite live regions in one document. All are empty
  at rest so nothing announces spuriously, but whether that many degrades
  NVDA/JAWS is a screen-reader measurement. No profile was run.
- **`open info`.** `access.canOpenInfo` is false in the fixture, so that control
  never renders in either shot. It is the one control on the page that does carry
  a `pendingLabel`, which is also why finding 4 does not cover it.
- **Anything requiring a weighted split.** The fixture writes `amount` directly
  and never calls `recalculate`, so no screenshot exercises one. The two places
  this bears on a conclusion (findings 3 and 5) are marked in place.

## Resolved from the Aug-5 sweep, not re-filed

- That audit's second "could not evaluate" — *"actual column widths at 320px, and
  therefore whether the roster's pinned Name column can ever exceed the
  scrollport"* — is answerable now. The pin is 169px at 1440 and ~86px at 390,
  roughly a quarter of the region, so it never strands the other columns.
  Separately: `.log--payouts td:first-child { overflow-wrap: anywhere }`
  (`globals.css:1367`) is the guard that keeps a long token from doing it on the
  sibling table, and **the roster has no equivalent rule** despite holding the
  less bounded of the two name sets. Not filed as a finding — nothing in the shots
  exhibits it — but it is the one-line prophylactic that belongs beside finding 13.
- Aug-5 findings 3 (`.disc` styling) and 7 (`PaymentHistory`'s summary target) are
  fixed in the CSS read here (`globals.css:3799`, and `:3707`, which now carries
  the 28px floor). Finding 2 (focus destruction) is fixed by `PayFlow`. Finding 4
  (the borrowed `scroller--tall` cap) is fixed by
  `.scroller--tall:has(.log--roster)` at `globals.css:1857` — findings 6 and 13
  above are two *different* classes borrowed from the same table, not that item
  re-opened.

---

## Contested — settled taste, raised once

**`.st--ok` on the roster.** Not re-opening the "no green" rule, which is right.
But `paid` (`.st--ok`, `--ink-dim`, filled dot) and `unpaid` (neutral,
`--ink-dim`, a 0.15em bar) render at the *same colour* in the one column whose
entire job is separating two states, on a table read fifteen rows at a time. The
words differ and the glyphs differ, so it conforms; it just does not scan. The
settled rule says an `ok` should not shout — it does not say `ok` and
`not-ok-yet` should be indistinguishable at a glance. `--ink-dim` for `paid` and
`--ink` for `unpaid` would separate them by lightness alone, spend no colour, and
put the weight on the row that still needs work rather than the row that does
not. Raised once; nothing in the body of this report depends on it.

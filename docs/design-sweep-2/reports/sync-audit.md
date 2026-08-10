# `/admin/sync` — technical audit

Register: **product**. Command: `$impeccable audit`. Source read in full:
`src/app/admin/sync/page.tsx` (1143 lines), `actions.ts`, `view.ts`,
`src/core/schedules.ts`, `src/core/run-health.ts`,
`src/app/_components/{disclosure,confirm-group,scroller,submit,relative-time,ui}.tsx`,
and the `.strip` / `.st` / `.notice` / label-register blocks in
`src/app/globals.css`. Shots read before source:
`docs/design-sweep-2/shots/11-admin-sync.{wide,narrow}.png`.

## What the shots show

**Wide (1440).** A 1200px column. H1 "Sync", then a three-line subtitle. Then a
red notice (mono, `worker · heartbeat check failed`) and an amber one
(proportional, `SYNC_MODE=dry-run`), both stopping at ~46% of the column width
while the strip below runs the full 1200. Then `9 JOBS · CHECKED 11:57:14 UTC`
with a hairline, then the strip: a column-label row, then four group labels
(SWEEP / MEMBER-FACING / ON-DEMAND / HOUSEKEEPING) over eight collapsed job rows
and one collapsed housekeeping summary line. Seven of the eight rows read
`▲ OVERDUE`; all eight read `19h ago`. Every row's name ends around x=247 and its
health token starts at x=627. The rightmost content on any row ends at x≈1030;
the strip's border is at x=1320. Bottom: `SYNC NOW` in gold, then
`RECHECK INVALID AFFILIATIONS`, then `REFRESH`.

**Narrow (390).** The column-label row is gone and each job reflows to two lines
(name, then health/age/cadence). The housekeeping summary line does not reflow:
`+ ▲2 JOBS · TOKEN-HEALTH OVERDUE, PURGE OVERDUE` runs past the strip's right
border at x≈375 and is cut at the viewport edge. The first job row sits ~750px
down the page.

## Audit health score

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 2 | Two R4 parity breaks in opposite directions on a surface otherwise unusually careful (F2, F3) |
| 2 | Performance | 3 | Nine drawers' subtrees render and hydrate whether opened or not — argued for, but it is the cost |
| 3 | Responsive Design | 2 | Housekeeping's health line overflows the viewport below ~26rem (F1); 48% of the strip empty at 1440 (F4) |
| 4 | Theming | 4 | Every colour a token; one hard-coded `1.5px` |
| 5 | Anti-Patterns | 4 | No cards, no gradients, no glass, no hero metric, no side stripes |
| **Total** | | **15/20** | **Good — address the two weak dimensions** |

**Anti-patterns verdict: pass.** Nothing here reads as generated. Structure is
hairlines and typed labels; the one bordered box on the page is a list region,
not a card. The absent tells are the load-bearing ones: no green wall of healthy
dots, no icon-and-heading grid, no glassmorphism, no `border-left` accent, no
gradient anywhere. The strip's grouped-list construction is the opposite of a
template.

---

## Findings, worst first

### F1 — Housekeeping's collapsed health line overflows the viewport, and it is the only place either of those two jobs can report a fault

- **Severity:** Serious
- **Where:** `src/app/globals.css:4389` (the `@media (max-width: 46rem)` block)
  — `.strip__group-disc > summary` is absent from it, while
  `.strip__disc > summary` at `:4394` gets `flex-wrap: wrap`. Compounded by
  `.st { white-space: nowrap }` at `src/app/globals.css:2461`.
- **Evidence:** visible in `11-admin-sync.narrow.png` at 390px — the line
  crosses the strip's border and is clipped by the viewport. At 320px the page
  content box is 288px, the strip's inner box 286px, less the summary's two
  `--s-4` paddings and the `+` marker plus its `--s-3` gap leaves ~233px. The
  string is 44 characters at `--t-label` (11px) IBM Plex Mono with
  `--track-value`, ~7.5px per character, so ~330px plus the status token's own
  dot and gap. Roughly 106px of overflow that cannot wrap. The healthy string —
  `2 jobs · nothing needs attention`, 31 characters, ~242px — is over the same
  233px budget, so this line has never fitted at 320px in any state.
- **Cost:** `token-health` and `purge` are reachable from no control anywhere in
  the product, which is the stated reason this collapsed line exists at all. An
  admin reading on a phone at 1am sees `2 JOBS · TOKEN-HEALTH OVERDU` and the
  second job's state is off the right edge of the screen.
- **Fix:** add `.strip__group-disc > summary` to the 46rem block alongside its
  sibling, and let the token wrap there — either `white-space: normal` scoped to
  `.strip__group-disc .st`, or split `groupHealthSummary` (`view.ts:200`) so the
  count stays inside the `Status` token and the flagged-job list becomes a
  wrapping sibling beside it. The base stylesheet already pairs
  `.strip__disc > summary` and `.strip__group-disc > summary` in five places
  (`:4239`, `:4256`, `:4263`, `:4268`, `:4280`, `:4285`); this is the one place
  the pairing was dropped, and it is the one that decides reflow.
- **Principle:** WCAG 2.2 1.4.10 Reflow.

### F2 — Every "next HH:MM" is announced with no timezone; the only channel carrying UTC for those rows is `aria-hidden`

- **Severity:** Serious
- **Where:** `src/app/admin/sync/page.tsx:543` and `:576-577`, with
  `src/app/admin/sync/view.ts:252-260` and `:288-292`.
- **Mechanism:** `.strip__head` is `aria-hidden="true"`
  (`page.tsx:381`), so `Cadence (UTC)` reaches sighted readers only.
  `splitCadenceUtc` restores ` UTC` in a `visually-hidden` span exactly when the
  cadence string ends in ` UTC`, which `formatCadence` writes only on its
  fixed-hour branches. `nextRunFor` returns `null` on precisely those same
  branches (`cadenceNamesTime`, `view.ts:277-280`). The two are mutually
  exclusive by construction: **a row that renders a "next HH:MM" always has
  `hiddenUtc === false`.**
- **Count, checked against `JOB_CRON`:** six of the nine seeded jobs render a
  bare wall clock with no zone anywhere in the accessible name — `membership`
  (`every 30m` / `next 12:00`), `contacts`, `wanderer`, `discord-roles`,
  `location`, `access-lists`. The three that do get the restoration —
  `membership-recheck` (`Sun 04:00 UTC`), `token-health`, `purge` — are the
  three that render no next-run time and never needed it. The restoration works
  correctly and covers only the rows that were never at risk.
- **Cost:** a screen-reader admin hears "wanderer, overdue, 19h ago, hourly :10,
  next 12:10" and cannot tell whether 12:10 is their own clock. For a UK admin
  in summer it is an hour out, and "is this job actually late" turns on it.
- **Fix:** give the next-run clause the same treatment the cadence got —
  `next {utcHhmm(nextRun)}<span className="visually-hidden"> UTC</span>` at
  `page.tsx:577`. One span. Alternatively drop `aria-hidden` from the cadence
  header cell alone, but the per-row span is the shape this page already uses.
- **Principle:** DESIGN.md Ruling R4 (parity, standard direction); WCAG 1.3.1.

### F3 — The queued marker's only copy of itself lives in the assistive-tech channel

- **Severity:** Serious
- **Where:** `src/app/admin/sync/page.tsx:497-509`;
  `src/app/globals.css:4117-4138`.
- **Mechanism:** the ring is `aria-hidden="true"`. The word "queued", and the
  escalation "queued 18m ago" (`queuedMarkerText`, `view.ts:496`), exist only in
  the adjacent `.visually-hidden` span. On screen the whole fact is a 0.5em
  outlined circle with no label, no legend anywhere on the page, and no column
  header naming it — the track it sits in is headed "Health". When
  `queuedMarkerStuck` fires, meaning the dispatcher has been wedged 15 minutes or
  more, the visible change is that the circle fills amber. No word appears
  anywhere. `startDispatcher` swallows a dispatch failure into `console.error`
  and reports it nowhere else, which the CSS comment at `:4128` states, so this
  ring is the only surface that condition has.
- **Cost:** a sighted admin who pressed "Sync now" and came back to find nothing
  landed sees a small ring beside "overdue" and has no way to learn what it
  means. The sentence that would tell them is written, correct, and deliberately
  withheld from them.
- **Fix:** R4's remedy is to say it on screen. The component's own comment is
  right that the 7.5rem health track has no room for a second word, so the fix is
  not a second word in that track — put the state where there is room: appended
  to `.strip__cadence` ("queued 18m"), or as a second line under the health token
  in the wrapped narrow layout, or promoted to the group line the way
  housekeeping's own summary already works. The `Absent` precedent the comment
  cites (`page.tsx:113`) does not transfer: `—` and `…` are conventional absence
  marks in a cell whose column header names the missing value. This ring has no
  header naming it and no convention behind it.
- **Principle:** DESIGN.md Ruling R4 (parity, inverse direction — the codebase's
  own characteristic failure, named in DESIGN.md:461-467); WCAG 1.4.1.

### F4 — 48% of the strip's width carries nothing, on every row, at every width above 46rem

- **Severity:** Moderate
- **Where:** `src/app/globals.css:4076` (`grid-template-columns: 1ch
  minmax(7rem, 28rem) 7.5rem 6.5rem 9rem 1fr`), with `.strip` at `:4038`.
- **Measured**, from the track list and confirmed against
  `11-admin-sync.wide.png`: at 1440 the page content box is 1200px. From the
  strip's left border the fixed tracks and gaps consume 905px, so the cadence
  column ends at x≈1026 (the shot reads x≈1030) and the trailing `1fr` spacer
  runs 260px to the border at x=1320 — 22% of the strip, empty inside a visible
  border on every row. Inside that, the name track sits at its 28rem (448px)
  ceiling for a longest job name of `membership-recheck`: 18 characters at
  `--t-label` 11px mono with `--track-furniture`, ~147px. The shot shows the gap
  directly — "MEMBERSHIP" ends at x≈247, "▲OVERDUE" starts at x≈627, ~380px of
  unbroken near-black. Together ~570px of the strip's 1199px is unfilled.
- The CSS comment at `:4067-4075` documents finding this once already ("the three
  value columns sat ~840px from the name they describe with nothing... filling
  the gap") and fixing it by capping the name track at 28rem. That took 840px to
  ~380px, not to zero. This is the sweep's pattern 1, half-resolved.
- **Cost:** an admin scanning at 1440 crosses ~380px of empty ground between a
  job's name and its state, on a 62px row with no zebra and no leader. Scanning
  the health column vertically works — that is what the grid buys and it works.
  The horizontal read, "which job is the red one", is what costs a second look.
- **Fix:** the name track's ceiling is a guess where the content is a closed set
  of nine known strings. Cap it near `max-content` — ~14rem covers
  `membership-recheck` with room, and `.strip__name` already carries
  `overflow-wrap: anywhere` for safety. Then cap `.strip` itself at its own
  content measure rather than leaving a 260px empty `1fr` inside its border.
  "Narrow surfaces cap their contents, never the column" sanctions this: `.strip`
  is contents, not the column.
- **Principle:** none cited. The sweep's pattern 1.

### F5 — The health column restates the page-level worker condition on every row, and this codebase has already written down why that is wrong

- **Severity:** Moderate
- **Where:** whole surface. Observation: in `11-admin-sync.wide.png` seven of
  eight visible rows read `▲ OVERDUE` and all eight read `19h ago`, directly
  below a red notice that already says the worker's state is unknown.
- `view.ts:99-105` excludes `overdue` from auto-open and states the reason: "when
  the worker dies, every row goes overdue at once, so opening on it would expand
  all seven drawers together and destroy exactly the 'this one job needs you'
  signal auto-open exists to create. A dead worker is a page-level condition and
  it is the worker line above the strip that says so." That argument is applied
  to the drawer and not to the token, so the token paints the page-level
  condition nine times.
- **Cost:** an admin arriving because a Discord role never landed reads a column
  of identical amber. The worst case is bounded — `rowHealth` returns `failing`
  before it reaches the overdue branch (`run-health.ts:212`), so a job that
  actually errored still reads red among the amber. What is lost is the middle
  case: a job that succeeded and then silently stopped being scheduled is
  indistinguishable from eight casualties of a dead worker, and that is the
  failure `run-health.ts` was written to catch (its own docblock, lines 7-15).
- **Fix:** the `crewNorms` shape from `/account`. When `worker.fresh` is false,
  `overdue` is not a per-row fact. State it once — in the worker line, or as a
  note on each group — and let the rows show their last recorded outcome, so the
  column carries deviation from the shared condition rather than the condition
  itself. Both channels stay in parity, because it is the same sentence either
  way.
- **Principle:** the sweep's pattern 2; consistent with `NEEDS_ATTENTION`'s own
  stated reasoning.

### F6 — On a phone the first job row is ~750px down, and a third of that is a subtitle restating the notice beneath it

- **Severity:** Moderate
- **Where:** `src/app/admin/sync/page.tsx:233-251`.
- The lede's second half branches on worker state and, in the captured state,
  reads "whether the worker picks it up is unknown right now — its heartbeat
  could not be checked — see the line below". The red `Notice` roughly 40px
  beneath it reads "worker · heartbeat check failed — unknown whether the worker
  is running". One fact, twice, in two type families, and the second of the two
  is the element designed to carry it. Read off `11-admin-sync.narrow.png`: nav
  ends y≈215, lede ends y≈390, the two notices run to y≈600, section header
  y≈655, first job row y≈750. At 844px of viewport that is one job row above the
  fold.
- **Cost:** the admin who opened this at 1am on a phone because a role did not
  land scrolls past a paragraph telling them nothing they will not read again 40
  px later, before they can see a single job.
- **Fix:** the branching half of the lede is a status readout wearing a subtitle.
  Cut it. Keep "The jobs that keep tiers, roles and standings in step with the
  game. The buttons enqueue work." and let the worker `Notice` — which already
  branches on the same three heartbeat states, and which a screen reader reaches
  as a `role="alert"` rather than as prose — be the only thing reporting worker
  state.
- **Principle:** the brief's "an explanatory subtitle under an H1 is a smell",
  in its live-state variant.

### F7 — The bottom control row's widest label is its least consequential action, and one of the three is a link

- **Severity:** Minor
- **Where:** `src/app/admin/sync/page.tsx:1108-1140`.
- Gold correctly takes the eye to "Sync now". Measured off the wide shot,
  `SYNC NOW` is ~97px and `RECHECK INVALID AFFILIATIONS` ~260px — the secondary
  action is 2.7× the primary's width, so size pulls against colour rather than
  with it. `Refresh` (`:1137`) is an `<a>` styled identically to two `<button>`s
  that enqueue work; assistive tech separates them by role, a sighted admin
  cannot.
- Separately: nothing visible connects "Sync now" to the `SWEEP` group label
  ~600px above it. The comment at `:1111-1115` says the group header is what now
  answers "which jobs", and the header does exist — but no thread ties the button
  to it, so the answer is only available to someone who already knows to look.
- **Cost:** an admin who cannot tell what "Sync now" touches either presses
  per-job Re-run four times, or presses it and re-runs three jobs that were fine.
- **Fix:** name the scope on the control ("Sync sweep", or a `.btn-row__stamp`
  beside it reading the four job names), and separate `Refresh` from the two
  enqueues using the hairline vocabulary the strip already owns.
- **Principle:** none cited. The sweep's pattern 3, already partly answered by
  the gold ration.

### F8 — A refused second press is silent on all three enqueue controls

- **Severity:** Minor
- **Where:** `src/app/admin/sync/page.tsx:1043`, `:1110`, `:1120`.
- `Submit` is deliberately not disabled while pending, and `useSubmitGuard`
  refuses the second press. `onRefused` is opt-in (`submit.tsx:49-52`) and none
  of this page's three `Submit`s pass it. `pendingLabel="Queueing…"` covers the
  sighted case for as long as the round trip lasts; a press landing after the
  label reverts and before the fresh render arrives is refused with no output at
  all, in either channel.
- **Cost:** bounded. The window is short and the outcome — nothing enqueued twice
  — is the desired one. Filed because the mechanism to say so exists and costs
  one prop, and because "nothing happened, press again" is the trap the rest of
  this page spends `ConfirmNotice` and `ConfirmGroup` on avoiding.
- **Fix:** pass `onRefused` on the Re-run `Submit`, reporting through the
  drawer's existing `ConfirmGroup` via `useConfirmReport`. The two bottom
  controls have no group and would need one, so they are the larger half.

---

## A correction to the brief's premise

The dispatch block asks me to "check the arm-then-press confirm flow on the
per-job Re-run controls with a keyboard." **There is no arm-then-press flow on
this page.** `page.tsx` imports `ConfirmNotice`, `ConfirmGroup`,
`ConfirmingForm`, `Disclosure` and `Submit` — not `ConfirmSubmit`, which is
where the two-stage arm/press behaviour lives and which this file never
references. The per-job Re-run is a single-press enqueue: one Enter on a
`.btn`, the action fires, `ConfirmGroup` moves focus to the confirmation
sentence below it. That flow is correct — the confirmation is a DOM sibling
after the form, so focus moves forward, and `ConfirmGroup`'s counter-based
effect re-fires on a repeat press even when the sentence is byte-identical
(`confirm-group.tsx:92-98`).

Whether an immediate enqueue is the right call for this control is a design
question outside an audit's remit; the stakes are low (a queued sync job) and
the surrounding admin tables that do arm-then-press guard destructive or
tier-changing acts, which this is not.

## Queued-status announcement: the answer

Nothing announces it, and nothing updates it. The page is `force-dynamic` with
no polling — deliberately, per the comment at `page.tsx:1132-1135` ("an admin
reading an expanded failed row must not have the page move under them").
`RelativeTime` ticks only its own age text, in a `<time>` that is not inside a
live region, so a job going queued → running → ok is invisible until a reload.
The copy is honest about this: `queuedNotice` ends every sentence with "reload
this page to see the run land." I agree with the trade. The gap it leaves is F3
— the marker that *would* report a wedged dispatcher after a reload has no
visible form.

---

## What is genuinely good and should survive

- **Contrast, everywhere, measured.** Rendered sRGB: `--ink-faint` `#90877e` on
  `--void` `#0a0a0a` is 5.64:1 and on a hovered row `#21201f` is 4.63:1;
  `--signal-warn` `#ff9f5f` is 9.75:1 on void; `--signal-bad` `#f05751` is
  5.83:1. The one combination worth checking by hand — the red worker line
  inside the red-tinted `.notice--bad`, whose ground composites to `#261313` —
  measures 5.22:1. The strip's own boundary, `--rule-strong` `#787370`, is
  4.24:1, clearing 1.4.11's 3:1 as a control boundary. Nothing on this surface
  is close to a floor. Do not touch the tokens.
- **`Absent`** (`page.tsx:113`) and the `.only-narrow` `started … UTC`
  restorations (`page.tsx:690`, `:851`). The brief asks that these survive; they
  should, and they are the correct model for fixing F2.
- **`Scroller`'s conditional `tabIndex`** (`scroller.tsx:95`) — a tab stop only
  while there is scroll range, with a `ResizeObserver` so a drawer opening
  restores it. That is the right answer to a problem most codebases get wrong in
  one direction or the other, and it is pinned by an e2e case.
- **`RelativeTime`'s single shared 30s ticker** for up to 42 instances, with
  per-subscriber `try`/`catch` so one bad instant cannot freeze every timestamp
  registered after it.
- **Re-run at the full 36px grade.** `page.tsx:1043` uses `className="btn"`
  (`min-height: 2.25rem`, `globals.css:2675`), not `.btn--micro`'s 28px. The
  brief's requirement is met, and the reason is written down at the call site.
- **`syncJobAction` returning through `useActionState`** instead of redirecting,
  so pressing Re-run does not collapse the drawer it was pressed in — a defect
  caught twice on two pages and fixed once, in a shared component.
- **`role="list"` per group with `aria-labelledby`** pointing at a *visible*
  heading. The trade (losing the flat "list, 9 items" count) is real, was
  weighed, and was resolved in the direction that keeps the grouping actionable
  for everyone.
- **Focus rings inset at `outline-offset: -2px`** on the summaries
  (`globals.css:4285`) so the strip's own border cannot clip them.
- **`Notice`'s empty-slot pattern** — the live region is registered before its
  text arrives, which is the one shape that actually announces.
- **Reduced motion.** The global `prefers-reduced-motion` block
  (`globals.css:295`) covers the page's only motion, a 140ms background-colour
  transition on the summaries — which would be harmless either way.

## What I could not evaluate, and why

- **Every drawer is closed in both shots.** The run-history table, the counter
  columns, the `Absent` glyphs in situ, `Json`'s Raw cell, the `.log--runs`
  44rem (704px) floor inside a `Scroller`, and the Re-run control itself were
  read from source only and never seen rendered. At 320px that 704px table sits
  in a ~254px scrollport — roughly 450px of horizontal scroll to read one run.
  It is inside a labelled, keyboard-reachable `Scroller` with edge fades and the
  ISO stamp drops to relative time below 40rem, so I believe it is handled, but I
  am reporting a reading of the CSS, not of a picture.
- **No screen reader was run.** F2's claim is structural — there is no UTC token
  anywhere in that subtree, in any engine — and does not depend on the name
  computation. I considered and am *not* filing the `<h3>`-inside-`<summary>`
  question: the WebKit behaviour that prunes headings applies to `<button>`, and
  `<summary>` is not a `<button>`, so the concern does not survive checking.
- **The queued ring never appears in either shot** — no job had work queued when
  the fixture was captured. F3's visible rendering is derived from
  `globals.css:4117-4138`, not observed.
- **Zoom was not rendered.** By calculation, 200% at 1280 gives an effective
  640px, above the ~430px where F1 bites, so F1 is a narrow-phone and 320px
  failure rather than a 200% one. At 400% — the 320 CSS px width 1.4.10 is
  actually specified at — it bites hard.
- **`ConfirmGroup`'s focus move** on a Re-run press was traced through
  `confirm-group.tsx` but not observed in a browser.

## Contested — settled taste, challenged once

The impeccable shared design laws ban em dashes in copy outright. This surface
has four in user-visible strings: two in the page lede (`page.tsx:247`), one in
`workerLine` (`page.tsx:180`), one in the dry-run notice (`page.tsx:319`). I am
not filing this as a finding, because "deadpan voice" is listed as settled and
em dashes appear in shipped copy across the whole app, so the house voice has
plainly chosen them. Raising it once: three of those four sit inside sentences
that are already doing two jobs, and in each case the clause the dash introduces
is the one I would cut rather than repunctuate — see F6, where deleting that
clause is the fix regardless of how it is punctuated.

## Recommended actions

1. **[P1] `$impeccable adapt`** — F1. Add `.strip__group-disc > summary` to the
   46rem block and let the housekeeping health sentence wrap; verify at 320px,
   not at 390px.
2. **[P1] `$impeccable harden`** — F2 and F3. One `visually-hidden` span for the
   next-run clause; a visible home for the queued state.
3. **[P2] `$impeccable layout`** — F4 and F6. Tighten the name track to its
   content, cap `.strip` at its own measure, cut the lede's status half.
4. **[P2] `$impeccable clarify`** — F5 and F7. Say "overdue" once when it is a
   page-level condition; name "Sync now"'s scope; separate `Refresh` from the
   enqueues.
5. **[P3] `$impeccable polish`** — F8, and a re-run of this audit against the
   drawer-open state, which nothing in this sweep has photographed.

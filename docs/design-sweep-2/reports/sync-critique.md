# `/admin/sync` — critique

Register: product. `$impeccable critique`. Read-only pass over
`11-admin-sync.wide.png`, `11-admin-sync.narrow.png`,
`src/app/admin/sync/{page.tsx,actions.ts,view.ts}`, `src/core/schedules.ts`,
`src/services/health.ts`, and the `--- Sync status strip ---` block of
`src/app/globals.css`.

## What I see, before explaining it

**Wide (1440×900, page runs 1310px).** A title, then three lines of grey prose,
then a red box, then a brown box, then a rule reading `9 JOBS · CHECKED
11:57:14 UTC`, then a bordered panel of nine rows in four labelled groups, then
three buttons of which the first is gold.

The panel is 1200px wide and about half of it is empty. Job names sit at x=161
and stop around x=246. The health tokens start at x=627. Between the name of a
job and the word telling you whether it is broken there are roughly 380px of
nothing — no rule, no zebra, no leader. Past the cadence column at x=1030 there
is another 290px of nothing before the panel's own right border at x=1320.

The `Last run` column reads `19h ago`, nine times, identically. The `Health`
column reads `OVERDUE` seven times with the same amber triangle, `OK` once, and
the ninth is folded. The `Cadence (UTC)` column stacks two lines on six of the
seven visible rows, and the second line begins with the word `next` every time.

The top third of the page is left-half-only. The prose wraps at ~600px; both
notice boxes stop at ~545px; the right 650px is void.

The three buttons are at y≈1203 — below the 900px fold.

**Narrow (390×844).** The panel becomes a stacked list. The column headers are
gone, and with them `Cadence (UTC)`, so the timezone is nowhere near the times.
The housekeeping line — `+ ▲2 JOBS · TOKEN-HEALTH OVERDUE, PURGE OVERDUE` — runs
straight off the right edge of the screenshot, past the panel border.

---

## Findings

### 1. Half of every row is empty, and the health token sits 466px from the name it describes

**Severity:** Serious
**Where:** `src/app/globals.css:4076` (and the composite of the wide shot)

The name track is `minmax(7rem, 28rem)`. At `--measure-page` (78rem) it resolves
to its 28rem maximum, 448px. The longest string it will ever hold is
`membership-recheck` — eighteen characters, measured at 154px in the wide shot,
because every job name is a literal key of `JOB_CRON` (`src/core/schedules.ts:10`)
and there are exactly nine of them. The track is spending 448px to hold 154px.
Add the trailing `1fr` spacer (~290px) and roughly 580px of a 1200px row — just
under half — is blank by construction, on every row, at every load.

The comment above the line is right about what it fixed: an unbounded `1fr` was
worse, and it says so honestly (~840px). The direction is correct and the number
is not. 28rem was chosen to be smaller than "the viewport" rather than to be
larger than "the widest job name," and those are different sizes.

**Cost:** The primary act on this page is finding the one row that is not `OK`
among nine. An admin does that by scanning the health column, which means nine
saccades across ~380px of empty ground away from the label that says which job
they are looking at — and then nine back, once they find the amber one, to read
its name. On the narrow viewport the same content stacks and reads fine, which
is the tell: the wide layout is doing less with more.

**Fix:** Cap the name track at the content it actually holds —
`minmax(7rem, 13rem)` clears 154px with room — and let the trailing `1fr` absorb
the rest. The four values then read as one left-aligned block about 700px wide,
the health column lands ~50px from the name, and nothing about the fixed value
tracks, the grouping, or the accessible names changes. `.strip__name` already
carries `min-width: 0; overflow-wrap: anywhere`, so the `other` bucket's
arbitrary job type still wraps rather than overflowing.

**Principle:** Pattern 1 (unshaped field), stated inside a table rather than at
page scale. Also *impeccable* product register: "predictable grids… consistency
IS an affordance" — a fixed grid whose largest track is mostly air is paying
grid's cost without buying its benefit.

---

### 2. The one line carrying a folded fault overflows the panel on a phone

**Severity:** Serious
**Where:** `src/app/globals.css:4239-4244` with `.st`'s `white-space: nowrap` at
`src/app/globals.css:2461`

`.strip__group-disc > summary` is `display: flex` with default `nowrap`, holding
a single `<Status>`, and `.st` sets `white-space: nowrap`. Its text is
`groupHealthSummary` (`view.ts:200`), which names every flagged member:
`2 jobs · token-health overdue, purge overdue` — 43 characters of uppercase mono
that cannot break anywhere. In the 390px shot it runs past the panel's right
border to the edge of the capture. `.strip` sets no `overflow`, so the string
escapes rather than clipping.

This is the worst place on the surface for that to happen. Housekeeping is
folded precisely because `token-health` and `purge` are reachable from no
control on this page and surface nowhere else in the product; `view.ts:176-198`
argues at length that the collapsed sentence has to say enough on its own,
because a shut `<details>` is out of the accessibility tree. The sentence is
load-bearing, and it is the sentence that runs off the screen.

**Cost:** An admin checking on a phone why nobody's tokens refreshed reads
`2 JOBS · TOKEN-HEALTH OVER` and has to scroll the page sideways — or, at 320px,
may not get the horizontal scroll at all depending on the ancestor — to find out
which two jobs and in what state. The fold is a summary that does not fit in the
space a summary gets.

**Fix:** Let this one summary wrap: `flex-wrap: wrap` on
`.strip__group-disc > summary`, and either `white-space: normal` scoped to
`.strip__group-disc .st` or move the sentence out of `Status` into a sibling
span so the token keeps its `nowrap` and the prose does not. The token's own dot
and word stay unbreakable; only the comma-joined member list wraps. Do not
truncate it — the member names are the payload.

**Principle:** WCAG 2.2 1.4.10 Reflow (content must not require two-dimensional
scrolling at 320px), and the sweep's own rule that the narrow viewport is not an
afterthought.

*(Adjacent, same block: `.strip__cadence` also carries `white-space: nowrap`
(`globals.css:4308`). `every 15m from :02` fits at 390px with ~40px to spare, so
it is not broken today, but it is the same unbreakable-string posture one
`formatCadence` branch away from the same failure.)*

---

### 3. The `Cadence (UTC)` fix loses its visible channel below 46rem

**Severity:** Serious
**Where:** `src/app/globals.css:4390-4392` against `src/app/admin/sync/view.ts:252`

This is the surface's celebrated pattern-2 solve, and at 1440px it is exactly
right: the header states the shared timezone once, `splitCadenceUtc` strips
` UTC` from every row's visible text, and `page.tsx:543` restores it per row in a
`visually-hidden` span so the accessible name keeps it. Two channels, parity
held.

Below 46rem, `.strip__head { display: none }` — correctly, the tracks it labels
no longer exist. But `splitCadenceUtc` is not media-queried. So on a phone the
visible text says `Sun 04:00` and `next 12:00` with the timezone deleted from
the only channel a sighted user has, while the hidden span still announces
`Sun 04:00 UTC` to a screen reader. The parity the fix was built to preserve is
now inverted: the fix removed the word from the visible channel on the strength
of a header that is no longer on screen.

The nearest UTC on the narrow page is `CHECKED 11:57:14 UTC` in the section
rule, attached to a different fact five rows up. EVE runs on UTC and an
experienced admin will assume it, but the reason this fix was made at all was
that assuming it is not good enough.

**Cost:** An admin on a phone at 1am reads `next 12:00`, checks a wall clock
showing 07:00 local, and cannot tell whether that job is five hours out or
already late.

**Fix:** Restore the visible ` UTC` below the breakpoint where the header that
replaced it is hidden — either a `.strip__cadence` `::after` inside the same
`@media (max-width: 46rem)` block that hides the header, paired with dropping
the hidden span there so it is not said twice, or a narrow-only `UTC` label in
the row. Whichever way, the invariant to hold is: the word appears exactly once
per channel per row-set, at every width.

**Principle:** Pattern 2's own rule — "keep both channels in parity." The fix is
correct; its scope stops at a breakpoint it does not know about.

---

### 4. Nine rows say `19h ago`; nothing says what that adds up to

**Severity:** Moderate
**Where:** whole surface (the wide and narrow shots, `Last run` and `Health`
columns)

This is the answer to "what still enumerates." When the worker stops — the
condition that brings an admin to this page — every row's `Last run` collapses
to the same value and every scheduled row's `Health` collapses to the same word.
The shot shows `19h ago` nine times and `OVERDUE` seven times. Those eighteen
cells carry one fact between them: *nothing has run since about 16:57
yesterday*, and that sentence appears nowhere on the page.

The red notice above says the heartbeat check failed. That is a different fact —
it is about the check, not about the consequence. `queuedNotice` (`view.ts:398`)
already writes careful sentences distinguishing "the read failed" from "no
heartbeat recorded" from "last checked in Xh ago"; none of them says how long
the queue has actually been still, which is the number an admin needs to size
the backlog they are about to create by pressing `Sync now`.

I am filing this as distinct from the closed dead-worker-reads-healthy item: the
health column is now honest (`OVERDUE`, amber), which is what that item fixed.
The finding here is that nine honest cells are not a summary.

**Cost:** The admin arrives during an outage, reads three lines of prose and two
boxes, then reads nine rows to derive by eye a number the page already has. The
`crewNorms` treatment on `/account` is the shape: measure against the set, state
the shared fact once, let the rows carry deviation.

**Fix:** When every scheduled row shares one `Last run` bucket, say it once in
the section rule that already exists — `9 jobs · nothing has run since 16:57 UTC
(19h) · checked 11:57:14 UTC` — and let the rows carry only what deviates. The
`RuleHead` aside at `page.tsx:334-341` is already the right slot, and `groups`
is already in hand there. The per-row `RelativeTime` stays for the rows that
differ.

**Principle:** Pattern 2 (total enumeration).

---

### 5. `next HH:MM` restates the cadence it sits under, on four of six rows

**Severity:** Moderate
**Where:** `src/app/admin/sync/view.ts:288` (`nextRunFor`)

`nextRunFor` suppresses the decoration only when `cadenceNamesTime` is true —
that is, when the cron's *hour* field is a fixed number. So `membership-recheck`
(`0 4 * * 0` → `Sun 04:00`) correctly gets no second line. But `contacts`,
`wanderer`, `discord-roles` and `access-lists` are `hourly :05`, `hourly :10`,
`hourly :15`, `hourly :25` — the cadence already names the minute — and each
carries `next 12:05`, `next 12:10`, `next 12:15`, `next 12:25` beneath it. The
only thing the second line adds is the current hour, which the reader's own
clock supplies.

Two rows earn it: `every 30m` genuinely does not say whether the next tick is
`:00` or `:30`, and `every 15m from :02` needs arithmetic. Four of six do not.

**Cost:** The word `next` is printed six times for two rows' worth of
information, and the second line doubles the height of the cadence cell on the
rows where it says nothing — which is what makes the strip a 640px-tall block
rather than a 400px one, and pushes the controls below the fold (finding 8).

**Fix:** Widen the suppression: return `null` when the cron's minute field is a
fixed number *and* the hour is `*`, since `formatCadence` then prints
`hourly :NN` and the minute is already stated. The test belongs beside
`cadenceNamesTime` in `view.ts`, reading the raw expression the same way, and
the existing docblock's reasoning ("would either repeat that number or read as
'soon'") already covers this case — it just stops one branch short.

**Principle:** Copy: "every word earns its place. No restated headings."

---

### 6. Every row promises a run that is not going to happen

**Severity:** Moderate
**Where:** `src/app/admin/sync/page.tsx:426` / `src/app/admin/sync/view.ts:288`

`nextRunFor(g.jobType, renderedAt)` is computed from the cron table and the
clock. It has no knowledge of `worker.fresh`, which the same render already
holds (`page.tsx:163-167`). So in the shot — heartbeat unreadable, every row
overdue by 19 hours — six rows say `next 12:00`, `next 12:05`, `next 12:10`,
`next 12:15`, `next 12:02`, `next 12:25`. Nothing will fire at any of those
times.

I flag this as adjacent to, not a re-opening of, the closed dead-worker item:
that one was about the `Health` column, which now correctly reads `OVERDUE`.
This is the cadence cell, three columns over, still making a forward-looking
promise the page has already contradicted two inches above.

**Cost:** An admin who has just read `heartbeat check failed` scrolls down and
sees six scheduled times in the next 25 minutes. The reasonable read is "it will
catch up on its own shortly," and they close the tab.

**Fix:** Suppress the `next` decoration when `worker.fresh` is false — thread
the flag into `nextRunFor`, or gate the JSX at `page.tsx:544`. The cadence itself
stays: `hourly :05` is a fact about configuration and remains true. `next 12:05`
is a prediction and is not.

**Principle:** Nielsen 1, visibility of system status — the status shown must
not contradict the status shown.

---

### 7. The lede states the fault, and the alarm 20px below states it again

**Severity:** Moderate
**Where:** `src/app/admin/sync/page.tsx:244-250` against `page.tsx:288-294`

Three lines of grey prose under the H1 end with "its heartbeat could not be
checked — see the line below," and the line below is a red box saying `worker ·
heartbeat check failed — unknown whether the worker is running`. Same fact,
twice, adjacent, with a cross-reference between them that would be unnecessary
if either were deleted.

The lede is doing two unrelated jobs at once: a standing explanation of what the
page is ("the jobs that keep tiers, roles and standings in step with the game")
and a live status report that changes on every load through a four-branch
ternary. The first belongs under the H1. The second is what the `Notice`
component exists for, and it is already there.

The brief names this shape directly: an explanatory subtitle under an H1 is a
smell.

**Cost:** The first thing an admin reads on an outage page is three lines of
prose whose payload is restated in an alarm they have not reached yet. Both
notices then push the strip down; the panel's first row starts at y≈500 on a
900px viewport.

**Fix:** Cut the lede to the standing sentence and let the notice own the live
claim: *"The jobs that keep tiers, roles and standings in step with the game.
The buttons enqueue work; the worker picks it up."* Drop the four-branch ternary
at `244-250` and the "see the line below" pointer with it — the `Notice` is
already the next thing in document order, so there is nothing to point at. The
notice's own text (`workerLine`, `page.tsx:177-198`) already distinguishes the
four heartbeat states carefully and does not need a second copy upstream of it.

**Principle:** The brief's own H1-subtitle rule; and Copy, "no intros that
repeat."

---

### 8. The page's one gold control is below the fold on the viewport it was shot at

**Severity:** Moderate
**Where:** `src/app/admin/sync/page.tsx:1108` (the composite of the wide shot)

`btn-row--controls` renders at y≈1203 on a page that runs 1310px, shot at a
900px viewport. On first paint an admin sees the title, two notices, and the
strip — and no controls at all. `Sync now` is the only saturated element on the
page (`#f1c035`, 11.63:1 on `#0a0a0a`) and it is invisible until they scroll.

The comment above it defends the position by PRODUCT.md principle 2, state
before action. That principle is right and is not what I am contesting: the
strip *should* be read first. But the principle is satisfied by the strip being
above the buttons, not by the buttons being 300px below the fold — and the two
notices (finding 7) and the redundant `next` lines (finding 5) are what pushed
them there. Fix either of those and the row lands near the fold on its own.

**Cost:** An admin who came to press `Sync now` after fixing an ESI outage scrolls
a page they did not need to read to find the button they came for; an admin who
came to read state, scrolls past the end of the table and finds the controls by
accident.

**Fix:** No new control and no sticky bar. Take the height back from findings 5
and 7 — the redundant `next` lines are ~20px × 4 rows and the lede is ~72px —
which brings the row to roughly y≈1030. If more is wanted, the two notices could
sit side by side above 60rem rather than stacked (see finding 10).

**Principle:** Nielsen 7, flexibility and efficiency of use.

---

### 9. `Refresh` and `Recheck invalid affiliations` are the same control

**Severity:** Minor
**Where:** `src/app/admin/sync/page.tsx:1119-1139`

This is pattern 3's real instance here, and it is not between the gold button
and the rest — the gold does its job and the eye does go to `Sync now` first.
It is between the second and third controls, which are visually identical
(`.btn`, same 36px grade, same border, same casing) and are not remotely the
same kind of act. `Recheck invalid affiliations` writes an audit row and
enqueues a job that re-checks every invalid affiliation in the corp. `Refresh`
is an `<a href="/admin/sync">` that reloads the page and drops the query string.
One is idempotent navigation; the other is work.

They also differ in feedback in a way the styling hides: both `Submit`s carry
`pendingLabel="Queueing…"`; the anchor has no pending state at all, so the
control that looks most like the other two is the one that gives no
acknowledgement when pressed.

**Cost:** An admin who wants to re-read the page after a press is one target away
from queuing a corp-wide affiliation sweep, with nothing but a 27-character label
distinguishing them.

**Fix:** Demote `Refresh` to the quiet grade the design system already has
(`.btn--quiet`, as used elsewhere for non-consequential controls), so the row
reads gold → default → quiet and the visual weight tracks the consequence. Do not
promote `Recheck` — the gold ration is one per view and it is spent.

**Principle:** Pattern 3 (repeated identical controls at uniform weight). Also
Nielsen 5, error prevention.

---

### 10. Two one-line state banners wear a prose measure

**Severity:** Minor
**Where:** `src/app/globals.css:3440` (`.notice { max-width: var(--measure) }`)

`--measure` is 68ch, the right cap for prose. Both notices here are single
sentences of machine state — one is a mono string. At 1440px they stop at ~545px
inside a 1200px column, and the resulting shape is a page whose entire top third
is left-aligned in the left half with 650px of void beside it. That is pattern 1
at page scale, arriving through a component default rather than through a
decision anyone made about this page.

**Cost:** Small on its own; it is mostly the reason findings 7 and 8 compound
into 500px of vertical before the first data row.

**Fix:** Not a token change and not a `.notice` change — it is correct for the
prose notices elsewhere. Either let this page's two notices share a row above
60rem, or accept the measure and take the height back from finding 7 instead.
Listed last because it is the least of the three contributors to the same
problem.

**Principle:** Pattern 1 (unshaped field).

---

## What is genuinely good and should survive

Name these before touching anything above.

- **`overdue` is excluded from auto-open** (`view.ts:99-105`). When the worker
  dies every row goes overdue at once, and opening on it would throw nine
  drawers open and destroy the "this one job needs you" signal auto-open exists
  to create. This is the single best judgement call on the surface, it is
  correctly reasoned in place, and finding 4's fix must not disturb it.
- **`groupTone` refuses to go green on a group where nothing has succeeded**
  (`view.ts:170-173`). A two-test cascade defaulting to `ok` would paint a fresh
  deployment's never-run housekeeping green. It doesn't.
- **`windowRestatesGroup`** (`view.ts:221`) — pattern 2 solved a third time, at
  drawer scale: the `last N runs` caption is suppressed exactly when the table's
  own `N runs` cell already states it. This is the same instinct as
  `Cadence (UTC)`, applied without being asked.
- **The `Cadence (UTC)` split itself** (`view.ts:252`, `page.tsx:543`). Finding 3
  is about its scope at one breakpoint, not about the fix. Do not undo it.
- **`Absent`** (`page.tsx:113`) — aria-hidden glyph paired with the words it
  stands for. Untouched by everything above.
- **The `.strip__queued` ring escalating shape rather than adding a word**
  (`globals.css:4117-4138`). A fixed 7.5rem track with no room for a second word,
  answered by changing the mark that is already there.
- **The bounded name track is the right *idea*.** Finding 1 changes 28rem to
  13rem. It must not revert to `1fr` — the comment at `globals.css:4066-4076`
  explains why that was worse, and it is correct.
- **`_everyGroupIsOrdered`** (`page.tsx:79`) — a type-level guarantee that no
  `JobGroup` can be added without appearing in `GROUP_ORDER`, with an honest
  comment about why proximity to `GROUP_LABEL` was not a guarantee.
- **The `checked HH:MM:SS UTC` stamp living in the section rule at the top of the
  strip**, not at the bottom of the page. Finding 4's fix builds on this slot.

## What I could not evaluate, and why

- **Every interactive state.** The shots are static and I am read-only on
  source, so hover, focus-visible, the `+`→`−` marker flip, an open drawer, a
  pending `Queueing…` label, and `ConfirmNotice`'s focus move were read from CSS
  and JSX only.
- **Five of the nine `RowHealth` states.** The fixture contains `overdue`, `fresh`
  and (folded) two more overdue. `failing`, `degraded`, `inflight`, `stuck`,
  `never` and `unknown` — and with them the auto-open behaviour, the `bad` tone,
  the error-summary line and the `.strip__queued--stuck` escalation — I judged
  from `view.ts` alone. The `other` bucket has no fixture at all.
- **320px reflow.** Finding 2's overflow is measured from the 390px shot plus
  `.st { white-space: nowrap }`. I inferred that 320px is worse; I did not
  render it.
- **The drawer's run tables.** Nothing is open in either shot, so `collapseRuns`,
  the counter columns, `Raw`, the `44rem` table floor and the `40rem`
  `.only-wide`/`.only-narrow` swap are source-only judgements. Finding 1 does not
  touch them.
- **Whether the panel scrolls or the document does** when finding 2's string
  overflows — `.strip` sets no `overflow`, but the ancestor chain at 390px I did
  not trace.

## Contested (settled taste)

None. Nothing above requires re-opening a settled item. Finding 8 reads as a
challenge to "state before action" and is not one: the principle asks that the
strip be read before the gold button, which a control row at y≈1030 satisfies as
well as one at y≈1203. The finding is about the 500px of removable height in
front of it, not about the ordering.

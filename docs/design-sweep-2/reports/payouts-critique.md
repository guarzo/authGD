# `/payouts` — critique

Register: product. Shots read before source: `04-payouts-full.wide.png`,
`04-payouts-full.narrow.png`, `03-payouts-empty.wide.png`,
`03-payouts-empty.narrow.png`.

## What I see, before explaining any of it

**Wide, 34 operations.** A single 1200px-wide table under two rule-headed
sections. Left to right the row reads: an underlined operation name, an ISO
date, a small `draft`/`finalized` chip, a very long right-aligned ISK figure,
then two more chips. The eye lands on the gold **New operation** button, then
falls into the table and finds nothing to catch it — 34 rows of identical
height, identical weight, no grouping, no emphasis. Reading down the two
right-hand columns: **every one of the 34 rows says `0/5 PAID`, and every one of
the 34 rows says `UNPAID`.** Those two columns carry no row-to-row variation at
all in this fixture. The 26 finalized rows render both of those chips in warn
amber, so the screen holds roughly 52 amber tokens, and the only thing amber
distinguishes is finalized-from-draft, which the Status column already said in
words one column to the left. Every Total cell ends in the same three
characters, ` ISK`. There is a wide horizontal void in every row between where
`FINALIZED` ends (~x=697) and where the money starts (~x=880), so the eye
travels 1200px per row across mostly nothing.

**Narrow, 390px, same 34 operations.** This is the one that stops you. The page
is 5699px tall. The table scrolls horizontally with Name pinned, and the pinned
Name column has been squeezed to roughly 40px, so *the pin renders the thing it
exists to preserve as an unreadable vertical ribbon*: "Structure bash, J155843
03" comes down the left edge broken mid-word into three- and four-character
fragments, about eight lines deep, which is what makes each row ~150px tall.
At rest the reader sees ribbon, date, chip, and a truncated total (`412,`).
Paid and Yours are entirely off-screen. To answer "was I paid?" on a phone you
pan right on each of 34 rows, and panning is what the pin was added to survive.

**Empty, wide.** Correct short sentence, one exit hint, and then 425px of
nothing below it in a 900px viewport. **Empty, narrow.** The zero-row table
*still* presents a horizontal scrollport: six column headers, the last one
clipped to `YOU`, and the message pinned under them.

---

## Findings, worst first

### 1. The narrow layout defeats its own pin, and the fix already exists in this repo

**Severity:** Critical
**Where:** `src/app/globals.css:1289-1366` (the budget comment and
`.log--payouts td:first-child { overflow-wrap: anywhere }`),
`src/app/payouts/page.tsx:239`, `e2e/payouts.spec.ts:3808-3818`

The budget comment is honest and its arithmetic holds: six columns are 736px
against a 286px region at 320px, every abbreviation available saves 200px, and
that still lands at 536px. Column-dropping was considered and rightly rejected
(it would collapse the `/payouts`-vs-`/account` distinction R3 draws). So the
table scrolls and Name is pinned. That reasoning was sound *at the time it was
written* — but it enumerates only two alternatives, abbreviate and drop, and a
third was invented in this same stylesheet afterwards and never came back here.
`.log--crew` (`src/app/globals.css:5450-5476`) hits the identical wall, cites
`.log--payouts`'s own comment as the precedent for refusing to drop columns, and
then **reflows**: `<thead>` hidden below 30rem, every `<td>` a labelled block
via a real `.crew__label` element rather than `::before` generated content, so
both channels keep every fact. Nothing is hidden from anyone, which is the
property the pin was chosen for, and the ribbon problem cannot arise because no
column is competing for width.

The measured consequence of not doing that here: the comment itself records the
pin at **69px of a 286px region, 24%**, and `overflow-wrap: anywhere` — added
for the good reason that one 60-character operation name would otherwise widen
the column to 637px for every row — is what turns 69px into mid-word breakage.
The guardrail is one-sided by construction: `payouts.spec.ts:3813-3818` asserts
`cellWidth / regionWidth < 0.6`, a **ceiling and no floor**. There is no
assertion that a pinned name is legible, which is exactly the side that failed.

**Cost:** A member checking on a phone at 1am reads a 5699px page on which every
operation's identity is a vertical stack of three-letter fragments, and the two
columns that answer "was I paid?" are off the right edge on all 34 rows. The
corp's transparency mechanism does not function on the device it is most often
opened on.

**Fix:** Apply the `.log--crew` reflow to `.log--payouts` below the same
breakpoint — `<thead>` hidden, each `<td>` a block carrying a real label
element, `.log--sticky-col` and the Scroller dropped at that width since there
is nothing left to scroll. Rewrite the `payouts.spec.ts` pin block as a reflow
assertion (labels present, no horizontal overflow, `thead` hidden) rather than
loosening the 60% ceiling; keep the pin above the breakpoint where it earns its
keep. Row height rises per row but total page height falls hard, because the
current height is driven by the eight-line ribbon, not by content.

**Principle:** Product register — "responsive behavior is structural (collapse
sidebar, responsive table, breakpoint-driven columns), not fluid typography."
And R4 parity, which the crew reflow was built to satisfy.

---

### 2. Total enumeration: ` ISK` 34 times, `paid` 34 times under a header that says Paid

**Severity:** Serious
**Where:** `src/app/payouts/page.tsx:245-249` (headers), `:288`, `:301-324`

Two facts are repeated on every row and belong to the set, not the row:

- **`ISK`.** Every operation in this system is denominated in ISK; there is no
  second currency in the schema. 34 repetitions of a constant suffix, inside the
  one column the reader is trying to compare figures down.
- **`paid`.** The cells read `0/5 paid` under a `<th scope="col">` that already
  reads **Paid**. A screen reader traversing the column hears "Paid, 0 of 5
  paid" on every row; a sighted reader reads the word 34 times below its own
  label.

This is `/admin/sync`'s "Cadence (UTC)" fix in miniature, twice over — state the
shared fact in the header, strip it from every row's visible text, restore it
per-row in a `visually-hidden` span so no accessible name is lost. Roughly 34px
of row width comes back per row from `ISK` alone, which is real money against
the narrow budget in finding 1.

**Cost:** The reader scanning for the largest operation counts comma groups
through 34 repetitions of a constant, and the accessible reading of the Paid
column stutters on every row.

**Fix:** Header `Total (ISK)` with a per-row `<span class="visually-hidden">
ISK</span>` beside the figure; header `Paid` with cells reading `0/5` and the
word carried in a `visually-hidden` span. Note the interaction with finding 1:
above the breakpoint the header is always on screen, and below it the reflow's
per-cell label carries the unit, so the fact survives at both widths.

**Principle:** Sweep pattern 2 — "a value repeated identically on every row when
it is really one fact about the whole set."

---

### 3. The page never states anything about the set it is showing

**Severity:** Serious
**Where:** `src/app/payouts/page.tsx:162-165` (the lede), `:223-228` (the
quantity aside)

The only aggregate this page produces is `34 total`, which is a row count and
tells the reader nothing they could act on. Everything else is per-row. The H1
is followed instead by an explanatory subtitle — *"Your own share of each
operation is on your account"* — which is the smell the brief names: a caption
explaining what the table means, standing in for the table meaning something.

Compare the reference surface. `/account` — a *personal* page, with less at
stake — leads with **"6 characters need attention"** and **"no characters on the
map"** on the H1's own line. The corp-wide ledger, whose stated job is
reconciliation, leads with a signpost to somewhere else.

The shot makes the cost concrete: 34 rows, all `0/5 paid`, all `unpaid`, and no
line anywhere saying *"26 finalized operations, none of them paid out"*. That
sentence is derivable from data already in hand (`ops`, at zero query cost) and
would be the single most useful thing on the page.

**Cost:** An operator opening this to find out what is outstanding must read 34
rows and hold a running count, on a page whose whole purpose is to make that
count visible. A member wanting "is anything owed to me" gets a link to another
page instead of an answer.

**Fix:** Replace the lede with a set-level reading on the H1 row, in the
`crewNorms` shape: measure deviation against the set, state it once. Something
in the register of *"26 finalized, none paid"* / *"all operations settled"*,
warn-toned only when the finalized-and-unpaid count is non-zero. Keep the
`your account` link, demoted — it is a signpost, not a lede.
I am not re-opening the closed "was I paid?" item; the Yours column stays. This
is additive, and it is what makes the column mostly unnecessary to read.

**Principle:** Sweep pattern 2's remedy (`crewNorms`); "an explanatory subtitle
under an H1 is a smell."

---

### 4. Fifty-two amber tokens on one screen, each individually correct

**Severity:** Serious
**Where:** whole surface. The two decisions composing it are
`src/app/payouts/page.tsx:305-312` and `:342-347`

Every rule here is defensible in isolation. A finalized operation with unpaid
rows genuinely is the stalled case (`page.tsx:305-312` argues it well). A draft
mid-payment is deliberately neutral, and that restraint is right. But 26 of the
34 rows in the realistic fixture are finalized-and-unpaid, and each contributes
**two** warn tokens — `--signal-warn`, rendered `#ff9f5f`, against `#0a0a0a` —
so the screen is a field of amber in which amber distinguishes nothing. The one
operation that actually needs chasing is indistinguishable from the twenty-five
that are simply awaiting a normal payout run.

Worse, the amber is redundant with information already present: on this surface
a warn Paid chip and a warn Yours chip appear on exactly the rows whose Status
column says `finalized`. The alarm colour is currently a second, louder
rendering of the Status column.

**Cost:** The operator who opens this to find the one stalled operation cannot
find it by looking, only by reading, which is the failure the colour was
introduced to prevent. Once every row is amber, no row is.

**Fix:** Reserve warn for deviation from the set, not for membership in the
common case. With finding 3's aggregate in place, the shared state is stated
once at the top and rows can drop to `--ink-dim`; amber then marks only rows
that deviate from what the header just said — the same measure-against-the-set
logic `isNominal`/`crewNorms` runs on `/account`. If a stronger per-row signal
is wanted, age is the axis that actually varies (finalized longest ago and still
unpaid), not the binary that Status already shows.

**Principle:** Sweep pattern 3 — repeated identical signals at uniform weight,
where nothing directs the eye. Also the settled `.st--ok` reasoning, applied to
warn: a state that has to shout on every row is competing with the one row that
isn't.

---

### 5. Paid and Yours are two adjacent columns running one tone machine on correlated facts

**Severity:** Moderate
**Where:** `src/app/payouts/page.tsx:295-377`

The two cells duplicate each other's tone logic explicitly — the Yours docblock
says so: *"`paid`/`unpaid` reuse the neighbouring Paid column's own tone
logic."* They are the last two of six columns, which puts both of them off the
right edge at narrow (finding 1) and puts the viewer's own answer furthest from
the row's identity at wide. In the fixture they are also perfectly correlated:
`0/5 paid` + `unpaid` on all 34 rows, which is what a reader will usually see,
since a member is normally on the roster of the operations they are looking at.

The column itself is settled and stays. Its **position** is not: "was I paid?"
is the member's question, and it is answered last, after four columns of
corp-wide bookkeeping.

**Cost:** The member — the larger audience for this page, since any member reads
it and only operators act on it — travels the full width of the row to reach the
one cell addressed to them, and on a phone never reaches it at all.

**Fix:** Move Yours immediately after Name (or, once finding 1 lands, put it
first in the reflowed block), so the viewer's own state sits next to the
operation's identity. Keep Paid where it is, as corp bookkeeping. This costs
nothing in width and makes the narrow layout answer the member's question
without any panning even before the reflow.

**Principle:** Product register, "predictable grids... consistency IS an
affordance" cuts the other way here: the most-asked question should not be in
the column position reserved for the least-asked.

---

### 6. The empty state presents a horizontal scrollport with nothing in it

**Severity:** Minor
**Where:** `src/app/payouts/page.tsx:229-251`, visible in
`03-payouts-empty.narrow.png`

With zero rows the table still renders six `<th>`s inside a `Scroller`, so at
390px the header row overflows (`YOURS` clipped to `YOU`) and the reader is
handed a scrollbar over a single sentence. The `.log__empty-text` sticky rule is
doing real work to keep the message on screen — work that only exists because
the empty table is being made to scroll.

**Cost:** Small, but it is a first-run impression: the first thing a new corp
sees on this page is a broken-looking clipped header.

**Fix:** Falls out of finding 1's reflow for free at narrow. Above the
breakpoint, consider suppressing `<thead>` when `ops.length === 0` — six column
promises over an empty set teach nothing.

**Principle:** Product register — "empty states that teach the interface."

---

### 7. Full-precision ISK across a 3-order-of-magnitude range

**Severity:** Minor
**Where:** `src/app/payouts/page.tsx:288` (`fmtIsk`)

The column spans `412,000,000.00` to `14,008,000,000.00` and asks the reader to
rank by counting comma groups. Right-aligned monospace helps and is the right
call; the ledger's need for exact figures is real and I am not proposing to
remove precision. Noted only because the budget comment already identified
`12.35B` as an available saving and rejected it on the narrow-width argument
alone — the *legibility* argument for it at wide was never weighed, and finding
1 changes the constraint that decided it.

**Fix:** Optional and low confidence. If tried, abbreviate in the cell with the
exact figure in a `title`/`visually-hidden` companion, never abbreviate alone.

---

## What is genuinely good and should survive

- **The three-way empty state** (`page.tsx:380-407`). `pastEnd`, `noMatches` and
  first-run are three genuinely different sentences with three different exits,
  and the reasoning for splitting them — telling an operator their data is gone
  — is exactly right. Most tables ship one string for all three. Do not collapse
  these when reflowing.
- **`complete` vs `shown`** (`page.tsx:114-120`). Refusing to say "34 total"
  unless the page provably *is* the whole list, and forcing `shown` under any
  filter, is a level of honesty about counts that most products never reach, and
  it costs no `COUNT(*)`.
- **The dash idiom**, applied identically in five places: `aria-hidden` em dash
  plus `visually-hidden` words, never `aria-label` on a bare span. Both channels
  in parity, one pattern, no drift. Keep it as the model when the reflow adds
  per-cell labels.
- **Draft-mid-payment is neutral, not amber** (`page.tsx:314-324`). The
  restraint is correct and is *not* the cause of finding 4 — the finalized
  branch is. Do not "fix" finding 4 by making drafts louder.
- **Gold spent exactly once**, on New operation, and hidden rather than disabled
  for non-operators. Filter is deliberately `.btn`, not `.btn--primary`.
- **The pager carries filters forward and offers `← Latest` off `cursor` rather
  than `nextCursor`**, so the last page — the one that previously had no control
  at all — keeps a way back.
- **`PendingLink`** on all three soft navigations, with the reasoning for
  rejecting `loading.tsx` (it would blank the header) recorded.

## What I could not evaluate, and why

- **Interaction states.** Hover, focus, `:active`, the `.link-pending` mark, the
  Scroller's keyboard focusability and its `tabIndex` flip — static fullPage
  shots only, and I am read-only, so I did not run the app.
- **How much of finding 4 is fixture.** All 34 rows carry `0/5` and `unpaid`, so
  I cannot tell from the shot what the real distribution of paid/unpaid looks
  like in production. Finding 4's *mechanism* holds regardless (warn fires on
  finalized-and-unpaid, which is the steady state between finalizing and paying
  out), but its severity scales with how long operations sit in that window.
  Findings 1, 2, 3 and 6 do not depend on the fixture at all.
- **320px and 200% zoom.** Shots are 1440 and 390 only. Finding 1's figures at
  320px are quoted from the stylesheet's own measurements, not remeasured by me.
- **Filter behaviour end to end.** I traced the code path (`statusParam`, `one`,
  `filterParams`, the cursor drop) and it reads correct, but no filtered shot
  exists, so I did not see `noMatches` or the `clear` control rendered.

## Contested — settled-taste items I am challenging

None. Nothing in the settled-taste list is doing damage on this surface, and the
"no cards" rule in particular is not threatened by the reflow in finding 1 —
labelled blocks inside `<tr>`/`<td>` keep the table's semantics and add no
panel, border box, or third card exception.

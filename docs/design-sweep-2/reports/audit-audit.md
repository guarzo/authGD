# `/admin/audit` — technical audit

`$impeccable audit` · register: PRODUCT · design-sweep-2 · 2026-08-10

Read first: `10-audit-full.{wide,narrow}.png`, `09-audit-empty.{wide,narrow}.png`.
Then `src/app/admin/audit/page.tsx`, `summarize.ts`, `src/services/audit.ts`,
`src/app/_components/{scroller,submit,submit-guard,focus-heading,ui}.tsx`, and
the `.log--audit` / `.scroller--tall` / `.filter-form` / `.pager` blocks of
`src/app/globals.css`.

## What the screenshots show, before any source

**Wide (1440×1243, fullPage).** A left-aligned column: `Audit log`, a
one-sentence lede, a `FILTER` rule with three empty inputs and a `FILTER`
button, then a `62 ENTRIES · as of 11:57 UTC` rule, then one bordered box
holding the table. The box ends at y≈1148 with the last row flush against its
bottom edge and ~95px of empty ground below it — the box is a height-capped
scroll region, not the whole table, and no pager renders (62 < the 100-row page
size, so `hasOlder` is false). Five columns: a 19-character ISO stamp, Actor,
Action, Target, Details. **Every visible row's stamp begins `2026-08-08`** — 13
of 13. Actor, Action and Target are underlined links; Target alternates between
a name and a truncated UUID (`6c4f2916-903b…`). Details is a `+`-prefixed
disclosure line, and six of the thirteen read the identical string
`+ roleId=1284410981234567890, characterId=90000006`.

**Narrow (390×1500, clipped by the capture).** Nav wraps to three rows. The
filter stacks; `FILTER` sits beside the Target field rather than under it. The
`At` column swaps the ISO stamp for elapsed time and the table scrolls
sideways, cut mid-`TARGET`; Details is entirely off-screen. The At column reads
`42h, 41h, 41h, 41h, 40h, 40h, 39h, 39h, 38h, 38h, 37h, 37h, 36h` — **four
consecutive rows carry the same value.**

**Empty (both).** One `<tr>` reading `Nothing has happened yet.`, centred, with
the header row above it and the count rule reading `NO ENTRIES`. The message is
on-screen and left-pinned at 390px, not scrolled away.

The circular `N` badge at the left edge of three of the four shots is the
Next.js dev-tools indicator, not app UI.

## Audit health score

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3 | A pager press is completely silent: no announcement, no focus move, and the count that would say what happened is ~300 tab stops back. |
| 2 | Performance | 3 | 100 rows each ship their payload twice (peek + collapsed `<pre>`); identity resolution itself is properly batched. |
| 3 | Responsive Design | 3 | Below 66rem the At column reads in whole hours, and four consecutive entries render as the same value. |
| 4 | Theming | 4 | Every colour on this surface is a token; no hard-coded value anywhere in the page or its rules. |
| 5 | Anti-Patterns | 4 | No cards, no gradient text, no glass, no hero metric. The one smell is the explanatory lede under the H1. |
| **Total** | | **17/20** | **Good — address accessibility and responsive.** |

**Anti-patterns verdict: pass.** Nothing here reads as generated. Structure is
hairline rules and section headers; the two type families do the work the split
promises (Archivo for the lede, mono for every stamp, id and payload); the
`FILTER` button correctly refuses gold. A category-reflex check on "admin audit
log" would predict a dark blue-grey table with a green/red status column and a
row of icon buttons, and none of that is here.

---

## Findings, worst first

### 1. A page change on this table is completely silent

**Severity:** Serious
**Where:** `src/app/admin/audit/page.tsx:200-231` (`Pager`), and
`src/app/_components/focus-heading.tsx:25-37` for the measurement that makes
this certain.

The pager's next/previous controls are `<a href>`, which the App Router
intercepts as a *soft* navigation. `FocusHeading`'s docblock records the
measurement: "Nothing in the framework moves focus for us. The App Router does
call `focus()` on arrival, but it targets the first element of the changed
segment — which is the `<header>` — and a `<header>` is not focusable, so the
call is a no-op and focus stays wherever it fell." So focus stays on the
`Older →` link. Next's `AppRouterAnnouncer` portals `document.title` into an
assertive region, and this route's title is the constant `"Audit log"` on every
page — no change, no announcement.

Net: a screen-reader admin presses `Older →`, hears nothing at all, and is
still standing on a link whose label has not changed. Nothing tells them the
press landed, which page they are on, or how many rows arrived. The one piece
of text that answers all three — `100+ older entries`, deliberately written to
distinguish page 1 from page 7 (`page.tsx:379-389`) — is above the table, i.e.
roughly 300 tab stops backward from where they are standing.

I checked the obvious adjacent hazard and it is *not* present: `Pager`'s JSX has
two fixed child slots (`{hasLatest && …}`, `{hasOlder && …}`), so React's
positional reconciliation keeps `Older →` in slot 1 across the page-1 → page-2
transition. The focused node does not silently become `← Latest`. Focus staying
put is in fact the right ergonomics for repeat paging; the defect is purely that
nothing is said.

**Cost:** An admin using a screen reader to walk a 300-row log presses `Older →`
and cannot tell a successful page turn from a dead control, so they press again,
and again, skipping pages they never knew they had loaded — on the one surface
in the app whose job is to establish exactly what happened and in what order.

**Fix:** Put the count line in a polite live region rather than moving focus.
`RuleHead` already renders the count and already carries the `id` +
`tabIndex={-1}` contract for a focus landing (`ui.tsx:204-209`), but focusing it
here would drag the keyboard user backward past the table on every page turn,
which is worse than the silence. A `aria-live="polite"` wrapper around the
count's text — announcing `100+ older entries` on arrival — costs nothing to
sighted use and answers all three questions. The precedent for the region is
`Notice` (`ui.tsx:299`); the precedent for announcing a soft transition is
`FocusHeading` itself.

**Principle:** WCAG 2.2 AA 4.1.3 Status Messages. Also the product register's
"every interactive component has a loading and a feedback state."

---

### 2. At 200% zoom the table's scroll region ends far below the fold

**Severity:** Serious
**Where:** `src/app/globals.css:1792-1812` (`.scroller--tall`), and
`globals.css:1817-1830` for the fix that was scoped away from this table.

`.scroller--tall` caps the region at `80svh`. The accounts table got a second,
narrower cap — `100svh - 29rem` — with a comment that states the reasoning
plainly: "80svh alone is a blind claim: it describes the region without
reference to what is above it… at 900px tall an 80svh region ended 246px below
the fold, so the sticky header the cap exists to enable had nothing on screen to
pin against." That fix is scoped to `:has(.log--dense)` because "/admin/audit's
region sits under far less chrome" — which is true at 100% zoom and stops being
true at 200%.

Arithmetic, from the stylesheet rather than a browser (see *what I could not
evaluate*): 200% zoom on a 1440×900 screen gives a 720×450 CSS-px viewport.
`svh` halves with it, so the cap is 360px. Everything above the region is
expressed in `rem` and does not shrink: the header bar, `.page`'s top padding,
the H1, a two-line lede, the `FILTER` rule, the filter form, its hint line, its
`--s-5` bottom margin, and the count rule. 720px is also below the 66rem stop
and below the width at which `.filter-form`'s four flex cells fit on one line,
so the actions cell wraps and the form gains a row. That chrome lands around
380–400px of a 450px viewport, and a 360px region starting there ends roughly
300px past the fold.

**Cost:** An admin who zooms to 200% — the population this route is most likely
to have, since reading UUID fragments and 19-digit snowflakes at 14px is the
whole task — must scroll the page to reach the table, then scroll inside a
region whose bottom edge they can never bring on screen, with a sticky header
that has almost no visible range to pin against. Two nested scrollbars for one
list.

**Fix:** Give `.scroller--tall:has(.log--audit)` its own chrome-subtracting cap
in the same form the accounts table uses, measured against this page's chrome
(which is different — no standing pending notice, but a taller filter form once
it wraps). Do not widen the shared `.scroller--tall`; the comment's reason for
keeping it narrow is sound. `e2e/admin.spec.ts:2469` is the existing shape for
the regression test ("the accounts scroller does not floor to the same height at
every zoom level") and has no audit counterpart.

**Principle:** WCAG 2.2 AA 1.4.4 Resize Text — content must remain usable at
200%; a region whose end is unreachable is the canonical failure.

---

### 3. The Filter button's in-flight machinery cannot fire, and its guard can outlive the page

**Severity:** Serious
**Where:** `src/app/admin/audit/page.tsx:456` (`<form method="get">`) →
`:527` (`<Submit>`), against
`src/app/_components/submit.tsx:79-80` and
`src/app/_components/submit-guard.ts:67-79`.

`Submit` calls `useFormStatus()`, which reports status only for submissions
React itself manages — a form with a function `action`. This form is a native
`method="get"` with no `action` prop, so the browser owns the submit and
`pending` is never `true`. Two consequences:

- **No feedback.** `aria-busy`, and the `pendingLabel` swap the docblock calls
  "the whole of the in-flight signal", never engage. On a `force-dynamic` route
  that runs up to three queries before it renders, the button is inert-looking
  for the whole round trip. The page's own comment at `:26-31` notes that
  `Submit` is a client component; it does not note that the component's reason
  for existing is switched off here.
- **A latch with no release.** `useSubmitGuard` sets `inFlight.current = true`
  synchronously on click and clears it only after observing `pending` go true
  and then false (`submit-guard.ts:71-78`). With `pending` pinned false, the
  latch is set and never cleared for the life of that document. Normally the
  document is replaced by the navigation and nothing is lost. It is not
  replaced when the document is restored from the back/forward cache: filter →
  follow a row's actor link → press Back restores the *submitting* document with
  its JS heap intact, latch still set, and every subsequent press of `Filter`
  is silently swallowed. No `onRefused` is wired at this call site, so there is
  no message either.

**Cost:** An admin narrowing a log — filter, click a name to widen, press Back,
retype — finds the `Filter` button dead with no error and no visual change, and
the only recovery is a manual reload they have no reason to think of.

**Fix:** Two independent halves. (a) Do not pass this form through `Submit` at
all; a plain `<button type="submit" className="btn">Filter</button>` is honest
about what a native GET form can signal, and drops a client-component boundary
the page does not need. (b) If the guard is wanted here, it needs a release
path that does not depend on `useFormStatus` — a `pageshow` listener clearing
the ref covers the bfcache case, which is the one that bites.

**Principle:** Product bans — "every interactive component has default, hover,
focus, active, disabled, loading, error. Don't ship with half of these." Also
WCAG 2.2 AA 3.2.2 On Input, in the degenerate sense: the control accepts a press
and produces nothing.

---

### 4. The date is stated 62 times, and the narrow rendering that saves the width loses the ordering

**Severity:** Moderate
**Where:** `src/app/admin/audit/page.tsx:617-625`, with
`globals.css:5242-5260` (narrow column widths) and
`src/app/_components/format-ago.ts:8-15`.

This is pattern 2, and it has an unusually clean fix because both viewports fail
for the same reason.

Wide: every row renders `2026-08-08 17:31:04`. Thirteen of thirteen visible rows
share the date; a full 100-row page at this fixture's spacing spans about 47
hours, so two or three distinct dates carry 100 renderings of a ten-character
string, in the pinned column — the one column that costs 12.25rem of a fixed
62rem table and paints over whatever the horizontal scroll has brought
alongside it.

Narrow: the swap to elapsed time was measured and is right in principle — a
19ch stamp at 69% of a 286px region is indefensible. But `elapsedShort` rounds
to whole hours past 90 minutes, and this log's entries are ~28 minutes apart, so
the shot shows `41h ago` four times in a row and `37h ago` twice. On a phone the
At column can no longer order or distinguish adjacent entries, on the surface
whose entire premise (`page.tsx:444-447`) is "newest first". The exact instant
survives in a `visually-hidden` span, so a screen reader is fine and a sighted
phone reader is not — the two channels have fallen out of parity, which is the
same fault the `Cadence (UTC)` fix on `/admin/sync` exists to prevent.

One change fixes both. `17:31:04` is 8 characters; `365d ago` — `elapsedShort`'s
widest output — is also 8. The narrow column already reserves 5rem for the
second, so it fits the first at no cost, and it restores second-level ordering.
The date then moves to where a repeated fact belongs: a group row, once per
date, in the manner `crewNorms` on `/account` states a shared fact once, or the
existing `.log--group` row on `/admin/sync`.

**Cost:** An admin on a phone at 1am, asked why someone's role is wrong, reads
four entries that all claim to have happened 41 hours ago and cannot tell which
of them came first — so they cannot tell which change caused which. On desktop
the same admin scans past 100 copies of a date to find the one time that
matters.

**Fix:** Render `HH:MM:SS` in the cell at every width. Emit a `.log--group`-style
date row whenever the date changes between consecutive entries, carrying the
date once. Keep the `visually-hidden` full-stamp span so the accessible name
stays absolute. The pinned column can then come down from 12.25rem, which buys
Details back real width at the 43rem and 34rem floors.

**Principle:** The sweep's pattern 2 — a value repeated identically on every row
when it is one fact about the set. And "reflow is not permission to destroy
data", which `globals.css:5140` already states about the sync table's Started
column.

---

### 5. The table is ordered by a key it does not show, and the lede promises the one it does

**Severity:** Moderate
**Where:** `src/services/audit.ts:623` (`orderBy(desc(auditLog.id))`) against
`src/app/admin/audit/page.tsx:445` ("newest first").

The query orders by serial `id`; the column the reader sees is `at`. The
screenshot is a literal demonstration that they can disagree — the wide shot
runs `17:31:04` at the top down to `23:11:04` at the bottom, which is oldest
first, under a lede that says newest first. Here that is the fixture's doing
(`capture.spec.ts:305-320` back-dates `at` while inserting forward), and in
production insert order normally tracks event order, so this is not a live bug
today.

It is still a real property worth naming, because the keyset pager inherits it:
`Older →` means `id < cursor`, not "earlier than". Any writer that computes a
historical `at` — a backfill, an import, a job reconstructing an event it
detected late — produces a log that is ordered by something invisible while
claiming to be ordered by the column on screen, and the pager walks a key the
admin cannot see.

**Cost:** An admin reconstructing a sequence trusts the order of the rows,
because the page told them to. If `at` and `id` ever diverge they get a
confident wrong answer, and nothing on the page gives them a reason to doubt it.

**Fix:** Cheapest honest option: order by `(at desc, id desc)` so the visible
column is the sort key and `id` is only the tiebreaker, and make the pager's
cursor match. If insertion order is deliberately the sort key, say so in the
column header rather than in a lede that names a different one.

**Principle:** None cited — this is a correctness-of-claim finding, not a rule
violation.

---

### 6. Actor and Target are trimmed; Action is not

**Severity:** Moderate
**Where:** `src/app/admin/audit/page.tsx:267-272`, and its own comment at
`:261-266`.

`actor` and `target` get `.trim()`, with a good reason given: these are typed or
pasted by hand and a trailing space off a copied UUID would fall through to "no
such name". `action` is deliberately left alone, and the comment says so —
"its semantics are out of scope for this branch."

The scoping decision has outlived its branch. `action` is a prefix match built
into `like(escape(value) + '%')` (`services/audit.ts:604-608`), so a pasted
`"tier.changed "` becomes `LIKE 'tier.changed %'` and matches nothing. The
empty state then says `Nothing matches this filter.` — true, confidently
phrased, and wrong about the reason. Worse, the actor-column nudge that softens
the same state for `actor` (`page.tsx:425-434`) does not apply, so this failure
mode has no hint at all.

**Cost:** An admin pastes an action name out of a Discord message — where
trailing whitespace is routine — and is told the log has nothing on it. They
conclude the event was never recorded.

**Fix:** Trim `action` the same way, in the same expression. The prefix
semantics are unaffected: no action name in `ACTION_NAMESPACES` or `PARTS`
begins or ends with whitespace, so trimming can only turn a guaranteed-empty
query into a matching one.

---

### 7. Each resolved name announces its UUID twice — re-opening a closed item with a consequence it did not name

**Severity:** Moderate
**Where:** `src/app/admin/audit/page.tsx:76-78` (`RawId`), used at `:118` and
`:154`, in combination with the `title` on the same anchors (`:115`, `:153`).

I am re-opening `/admin/audit`'s "UUID recital", listed as closed by the Aug-5
sweep. The visible recital is genuinely fixed — the columns render names, and
`shortId` truncates what cannot be named. What the closed item does not name is
the assistive-tech channel, where the recital was not removed but doubled.

Each resolved actor and target anchor carries both a `visually-hidden` span
`(id 6c4f2916-903b-…)` inside its content **and** `title={r.actor}` on the
element. The hidden span joins the accessible *name*; `title` supplies the
accessible *description*. NVDA and JAWS announce both, so a single link reads as
"Bad Scout, open paren, i-d, six-c-four-f-two-nine-one-six dash…, link,
six-c-four-f-two-nine-one-six dash…" — the same 36-character hex string spelled
out twice. On a full page that is up to 200 anchors, up to 400 spoken UUIDs.

`RawId`'s docblock argues, correctly, that `title` alone is unreachable to
VoiceOver, TalkBack and touch, and that the raw id is real information rather
than a restatement of the name. Both halves of that argument are right; what
follows from them is that the hidden span should *replace* `title`, not join it.

**Cost:** A screen-reader admin scanning the log by link, or tabbing the actor
column, hears each name buried between two recitals of a UUID they did not ask
for and cannot act on — on the page where finding the right person quickly is
the entire promise.

**Fix:** Drop `title` from the two anchors that carry `RawId`, keeping the
hidden span. `title` stays where the visible text and the raw value are already
the same string (`system`, the reserved literals, the unresolved branch), which
is exactly the split `RawId`'s own docblock already draws. Consider whether the
id needs to be in the name at all rather than behind a per-row disclosure the
Details column already establishes.

**Principle:** WCAG 2.2 AA 2.4.4 Link Purpose, in the "purpose should be
determinable *efficiently*" sense; and the register's density permission does
not extend to the audio channel.

---

### 8. The scroll region and the table it holds announce nearly the same name

**Severity:** Minor
**Where:** `src/app/admin/audit/page.tsx:563` (`label="Audit entries"`) and
`:565` (`<caption>Audit log entries</caption>`).

`Scroller` emits `role="region" aria-label="Audit entries"`; the table inside it
carries a visually-hidden caption reading `Audit log entries`. Entering the
region announces both, four words apart, differing by one word.

**Cost:** Two seconds of duplicate speech per entry into the table, and a
landmark list with an entry that says nothing the table does not.

**Fix:** Make the region's label say what the *region* is, since that is the
thing with a distinct job: `label="Audit entries, scrollable"` is wrong (state
belongs in the role), but `label="Audit log"` on the region with the caption
keeping `Audit log entries` at least separates them. Better: drop the caption
and let the region label carry the name, since `<caption>` here is buying
nothing the region does not already provide.

---

### 9. The lede explains what the table means

**Severity:** Minor
**Where:** `src/app/admin/audit/page.tsx:444-447`.

"Every state change, append only, newest first. Nothing here can be edited or
removed." Four claims, three of which the table should be making itself. "Newest
first" is a sort order, which belongs on the column that carries it (and see
finding 5, where it is currently not even true of the screenshot). "Append only"
and "nothing can be edited or removed" are the same fact said twice.

**Cost:** Every admin reads two lines of preamble on every visit to learn one
thing — that this log is immutable — that they learn permanently on the first
visit.

**Fix:** Cut to the one durable claim: `Append only. Nothing here can be edited
or removed.` Put the ordering on the `At` column header, where a reader looks
when they want to know it.

**Principle:** The sweep's own note — "an explanatory subtitle under an H1 is a
smell." And Copy: "no intros that repeat the title."

---

### 10. The Action field's hint and its datalist offer different vocabularies

**Severity:** Minor
**Where:** `src/app/admin/audit/page.tsx:499-506` against
`src/services/audit.ts:193-195`.

The `<datalist>` offers eleven namespace *prefixes* (`tier.`, `token.`,
`discord.`, …). The hint under the field reads "what happened, like
tier.changed" — a complete action name, which is not one of the eleven options
and cannot be, since the list is derived from `NAMESPACE_TARGET_KIND`'s keys.
The field is a prefix match, so both work; the two channels simply describe
different things and a reader who opens the list after reading the hint finds
nothing resembling the example.

**Cost:** A moment's confusion the first time, and a mild reason to distrust the
suggestions afterwards.

**Fix:** Make the hint describe the prefix behaviour the field actually has —
`"a namespace like tier., or a full action"` — so the list and the sentence are
saying the same thing.

---

### 11. Every row ships its payload twice

**Severity:** Minor
**Where:** `src/app/_components/ui.tsx:352-371` (`Json`), used at
`src/app/admin/audit/page.tsx:676-687`.

Each row renders a summary line *and* a `<pre>` holding
`JSON.stringify(value, null, 2)` — indented, so roughly 3–4× the compact form —
inside a collapsed `<details>`. All 100 of them are in the HTML on first paint
whether or not anyone opens one.

This is a deliberate trade and mostly the right one: `<details>` needs no JS,
and the docblock's argument for keeping the full value reachable (role IDs and
trailing counters live past the truncation point) is sound. It is worth naming
only because the multiplier is per-row and the page size is 100.

**Cost:** A slower first byte and a larger document on a `force-dynamic` route,
paid by every admin on every load for content almost none of them open.

**Fix:** Pass `pretty={false}` here. The prop exists for exactly this, with a
measured precedent on `/admin/sync` ("the difference between a 227px row and a
~116px one"), and audit payloads are flat scalar objects in every declared
`PARTS` shape — the one-key-per-line indent buys nothing a compact string does
not already say. Not worth building lazy expansion for.

---

## What is genuinely good and should survive

- **Contrast, everywhere, with margin.** Rendered sRGB, computed from the
  tokens: `--ink-faint` `#90877e` on `--void` `#0a0a0a` is **5.61:1**, and on
  the hovered row's lighter ground **4.61:1** — both over the 4.5:1 floor at the
  12px and 11px sizes this page uses it at. `--ink-dim` `#bab3a9` on void is
  **9.53:1** (body cells), `--ink` `#ece7de` **16.08:1**, `--gold` `#f1c035`
  **11.63:1**, `--signal-warn` `#ff9f5f` **9.78:1** (the `_failed` action cells).
  `--rule-strong` `#787370` — the field and header borders — is **4.23:1**, over
  the 3:1 UI-boundary floor. Nothing on this surface is close to failing.
- **The two-channel discipline holds nearly everywhere.** The exact UTC instant
  survives the narrow elapsed-time swap in a hidden span; `_failed` actions get
  warn colour *and* already contain the word "failed"; `system` is distinguished
  by mono + dim rather than colour alone. Finding 4 is the one place the two
  channels have drifted, and it is a rounding artifact, not a design decision.
- **Hit targets are argued, not assumed.** `.cell-link` takes an explicit 28px
  floor with a written refusal of WCAG 2.5.8's inline-target exception ("each is
  the whole content of its `<td>`, not a link inside a sentence"), and
  `.json > summary` took the same floor for the same reason. The 28px grade is
  the sanctioned in-row one; `.btn` is 36px. Both correct, neither invented.
- **Focus is not obscured by either sticky edge.** `scroll-margin-top: 3rem` and
  a per-table `scroll-margin-left` that tracks the pin's width through all three
  breakpoints (12.25rem → 8rem → 5rem), with the reasoning for over-estimating
  written down and the figures pinned in e2e. This is WCAG 2.4.11 done properly,
  including the part about Chromium's programmatic focus scroll not reproducing
  the bug.
- **The `Scroller` earns its tab stop conditionally**, granting one only while
  there is something to scroll, with the pre-hydration default erring toward
  reachable rather than toward tidy. That default is the right way round.
- **The empty state does real work.** Four distinct messages — unmatched name
  (naming *which* field and what kinds of thing it could have matched),
  past-the-end (with an exit link that keeps the filter), filtered-no-match
  (with the actor/target asymmetry nudge, shown only when it can help), and
  genuinely-empty — plus a count heading that says the same thing in the second
  channel. `.log__empty-text` stays pinned to the scroller's left edge at 320px
  so the message does not scroll out of view.
- **The middle-band breakpoint.** The 66rem stop exists because someone measured
  a 2px-of-viewport / 399px-of-scroll cliff at 640px and fixed the band nobody
  had looked at. Tablets are the correct place to have found that.
- **`summarize.ts`'s declared-keys design.** Tagging each renderer with the keys
  it reads, so `+N more` means "nobody looked at this" rather than "deliberately
  silent", is the difference between a summary that is incomplete and one that
  lies about being complete. Do not let a fix pass collapse `Part.keys`.

## What I could not evaluate

- **The Details column, from the screenshots.** The capture fixture
  (`capture.spec.ts:293-304`) seeds action names that are not in the app's
  vocabulary — `discord.role.added`, `payout.paid`, `acl.member.added`,
  `contact.sync_failed`, none of which are keys in `PARTS` — so every seeded row
  falls through to the generic `key=value` fallback. The wall of identical
  `+ roleId=…, characterId=…` in the wide shot is that artifact, not the
  column's real behaviour. What the column looks like at 62 rows of *real*
  actions is unknown and should be re-shot with names drawn from `PARTS` before
  anyone judges it. I have deliberately filed nothing about Details density.
- **The pager itself.** 62 rows is under the 100-row page size, so no pager
  renders in either shot. Findings 1 and 5 are reasoned from source; I have not
  seen the control on screen at either viewport. (The known duplicate-pager item
  is out of scope per the brief and I have not spent a finding on it.)
- **Anything measured in a browser.** No dev server or seeded database was
  started for this pass, and there is no jsdom in this project, so every pixel
  figure here is arithmetic over the stylesheet with its inputs stated —
  specifically finding 2's 200%-zoom chrome estimate and finding 4's 8-character
  column-width claim. Both should be confirmed with Playwright before the fix
  is sized. Finding 3's `useFormStatus` behaviour follows from React's contract
  (status is reported only for React-managed submissions) and finding 1's from
  the repo's own recorded measurement, but neither was re-run here.
- **Real screen-reader output.** Finding 7's double-announcement follows from
  the accessible name/description computation and NVDA/JAWS defaults; it was not
  verified against a running screen reader, and VoiceOver's `title` handling
  differs.

## Contested — settled taste I think is worth one challenge

Nothing. The settled-taste list holds up on this surface: gold is correctly
rationed (the `FILTER` button explicitly refuses it, with the reason written at
`page.tsx:525-526`), the two-family split does real work here, there are no
cards, and the near-zero radii are consistent. I have no challenge to file.

## Recommended actions

1. **[P1] `$impeccable harden`** — announce the soft page change (finding 1) and
   fix the Filter button's dead in-flight state and bfcache latch (finding 3).
2. **[P1] `$impeccable adapt`** — give the audit scroller a chrome-subtracting
   height cap so 200% zoom does not strand the region below the fold (finding 2).
3. **[P1] `$impeccable layout`** — move the date to a group row and render
   `HH:MM:SS` at every width, then reclaim the pinned column's width for Details
   (finding 4).
4. **[P2] `$impeccable harden`** — trim `action`, and order by the column the
   page shows (findings 5, 6).
5. **[P2] `$impeccable clarify`** — drop the doubled `title`, separate the
   region and caption names, cut the lede, align the Action hint with its
   datalist (findings 7, 8, 9, 10).
6. **[P3] `$impeccable optimize`** — `pretty={false}` on the audit `Json`
   (finding 11).
7. **[P2] `$impeccable polish`** — final pass once the above land.

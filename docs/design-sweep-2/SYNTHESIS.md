# Design sweep 2 — synthesis and ranked backlog

Sweep of 2026-08-10. Eight in-scope surfaces plus one reviewed unrequested.
Eighteen reports in `reports/`, 63 screenshots in `shots/` (30 from the sweep
proper, 33 from the two re-shoots that closed the capture gaps).

**Nothing in `src/` has been modified.** This document is the Phase 3 output and
the Phase 4 gate: the owner chooses what gets worked before any edit.

Ranked by **what the problem costs a user**, not by how many surfaces it recurs
on. Recurrence is recorded per item as a separate leverage note.

---

## Rank

### 1 — `/payouts/[id]` does not fit a phone, at the document level

**Severity:** Critical (both reviewers, independently, with identical numbers)
**Cost:** The page where ISK is finalized and paid is the only surface in the app
whose narrow `fullPage` capture is wider than the viewport: **771px (draft)** and
**522px (finalized)** against 390px. A fleet member checking whether they were
paid, on a phone, scrolls the whole document sideways. It also fails SC 1.4.4 at
200% zoom on any display narrower than ~1600 physical px.

Two independent causes, both one-line:

- **(a)** `.btn-row--tight { white-space: nowrap }` — `globals.css:2974` — inherits
  into Finalize's visible `ConfirmCost` sentence at `payouts/[id]/page.tsx:508`
  → `lifecycle-submit.tsx:139-156`. A 137-character sentence renders as one
  unbreakable **754px** line (measured x=120→x=874 at 1440).
  Two fixes on the table: **remove `.btn-row--tight` from `page.tsx:508`
  entirely** (the audit's — the row holds one button, Finalize and Unlock being
  mutually exclusive by construction), or scope the `white-space` to direct
  button children (the critique's). The first is cleaner and strictly local.
- **(b)** `.pool-items` is `display: grid` with an implicit `auto` track and no
  `minmax(0, 1fr)` — `globals.css:4859` holding `page.tsx:682`. The item table
  escapes its `Scroller`, which also kills the edge fades **and withdraws the
  keyboard tab stop** at `scroller.tsx:95` (SC 2.1.1).
  Fix: `.pool-items { grid-template-columns: minmax(0, 1fr) }`.

**Leverage:** `globals.css:4583` already names `.pool-items` by name as one of
exactly two at-risk sites, and fixes only the other one (`.drawer__crew` got
`min-width: 0` at `:4577`).

---

### 2 — Four of `/payouts/new`'s five error messages cannot be reached through the form

**Severity:** Serious
**Where:** `new-operation-form.tsx:96` (`required`), `:111-112` (`max={today}` +
`required`), `:119` (`type="url"`), against `src/app/payouts/errors.ts:34-44`
**Cost:** Native constraint validation runs before the `submit` event, and React's
`<form action>` runs from that event — so `name_required`, `date_invalid`,
`url_invalid` and `url_scheme` are server backstops for scripted requests only.
An operator pasting `zkillboard.com/related/…` gets the browser's "Please enter a
URL.", which auto-dismisses and cannot be recalled; the app's own sentence
("Battle report links must start with http:// or https://") never renders. All
four end "Everything else you typed is still here." — a promise about a screen
nobody sees. SC 3.3.3.
**Fix:** `noValidate` on the `<form>`. Worth thirty seconds of manual confirmation
first; the two remedies differ.
**Leverage:** no e2e asserts any of the four, and cannot — `e2e/payouts.spec.ts`
and `e2e/submit-guard.spec.ts` reach `/payouts/new` six times and never a
rejection notice. Worth one grep for the same shape elsewhere when this is worked.

---

### 3 — `/admin/audit`: ~20 seconds to a confident wrong answer

**Severity:** Serious
**Where:** `admin/audit/page.tsx:425-434`
**Cost:** Actor is the first field and the first tab stop, and every tier change
is written with `system` or an admin as actor — so an admin looking up "what
happened to this member" filters by the member, gets nothing, and concludes
nothing happened. The actor/target nudge that would prevent this lives *inside*
the `rows.length === 0` branch, so it fires only on the harmless failure.
**Fix:** surface the nudge above the results, not inside the empty branch.

---

### 4 — `/payouts`' narrow layout defeats its own pinned column

**Severity:** Critical (critique's grade)
**Where:** budget comment `globals.css:1289-1366`; assertion
`e2e/payouts.spec.ts:3813-3818`
**Cost:** The pin measures **69px of a 286px region (24%)** at 390px, so the
column that exists to keep a payout identifiable while scrolling doesn't.
**Fix:** the answer is already in-repo — `.log--crew` (`globals.css:5450-5476`)
hits the identical wall, cites `.log--payouts`'s comment as precedent, and
reflows instead: `thead` hidden below 30rem, each `<td>` a labelled block.
Interim: `min-width: 11ch` (~88px of 286px = 31%).
**Sequencing hazard:** promoting the Name cell to `<th scope="row">` inherits
`.log th`'s `white-space: nowrap` (`globals.css:1142-1151`), which defeats
`overflow-wrap: anywhere` and blows the 60% ceiling. `.log--payouts tbody th`
must be scoped back to the `td` treatment **first**.
**Note:** `e2e/payouts.spec.ts:3813` asserts `cellWidth/regionWidth < 0.6` — a
ceiling with no floor, so it passes at 24%.

---

### 5 — `/admin/sync`'s housekeeping summary has never fitted at 320px, in any state

**Severity:** Serious
**Where:** `globals.css:4389` — `.strip__group-disc > summary` is absent from the
`@media (max-width: 46rem)` block that gives `.strip__disc > summary`
`flex-wrap: wrap` at `:4394`
**Cost:** `display: flex` (nowrap) holding one `<Status>` with `.st`'s
`white-space: nowrap` (`globals.css:2461`). Even the *healthy* string — `2 jobs ·
nothing needs attention`, 31 characters, ~242px — is over the same 233px budget.
The faulted strings run 43 unbreakable characters and escape the panel.
**Fix:** add `.strip__group-disc > summary` to that media query. The base
stylesheet pairs the two selectors in five places; this is the one place the
pairing was dropped. **Do not truncate — the member names are the payload.**

---

### 6 — A retry that *succeeds* drops focus to `<body>` and announces nothing

**Severity:** Serious
**Where:** `error.tsx:295-306`
**Cost:** No page in `src/app/` renders a `FocusHeading`, so on a successful
`reset()` focus falls to `<body>` with no `<title>` change and no live region. A
keyboard or screen-reader user who recovers from an error is silently returned to
the top of the tab order with no confirmation anything happened. The **failed**
path is documented in detail at `error.tsx:280-294` and pinned by
`e2e/error-boundary.spec.ts:96-140`; the successful one is nowhere. SC 4.1.3 /
2.4.3.
**Fix:** move focus to `#main` before `reset()`, or add a `role="status"` line.

---

### 7 — `.notice` reorders inline content, app-wide

**Severity:** Serious (two reports, same mechanism, same coordinates)
**Where:** `globals.css:3429-3431` (`.notice` is `display: flex`), reaching
`error.tsx:197-214`
**Cost:** The digest branch's three children become flex items 2/3/4, so the
rendered reading order is *"…what you were **4292868890** . doing and quote
reference"*. Measured in Chromium: the `<code>` box lands at x=208 / x=278 /
x=500 while the notice starts at x=16 / x=16 / x=120 (320/390/1440). SC 1.3.2.
**Fix:** have `Notice` wrap `{children}` in a `<span>` at **`ui.tsx:321`** — this
fixes every `Notice` in the app carrying inline markup, not just this caller.
**Leverage:** `admin/accounts/page.tsx:298-300` and all four multi-part notices on
`/payouts/[id]` already work around it by hand.
**Note:** `e2e/error-boundary.spec.ts:239` was written to fix exactly this. The
DOM merge landed; the render undid it. The spec asserts `toContainText` and
`toBeVisible` on `code.mono`, both of which pass while the digest sits anywhere
on the page.

---

### 8 — `/admin/access-lists`: "Check now" confirms success where it provably cannot act

**Severity:** Serious — **out of scope, cleanly liftable**
**Where:** `admin/access-lists/page.tsx:153-160` against `src/jobs/access-lists.ts:59-62`
**Cost:** The form renders unconditionally, outside the `showsObservations(state)`
gate. In `grant-needed` — the state every new deployment opens on — the job
returns having read nothing, and the admin is told "Check queued at 09:41:22.418
UTC. Reload this page once the worker has run." They reload to a byte-identical
page and cannot tell whether the worker is dead, the queue is stuck, or the
feature is unconfigured.
**Fix:** wrap the form in the same `showsObservations(state)` condition.

---

### 9 — `/payouts/[id]` at 390px hides State and every row control

**Severity:** Serious
**Where:** roster `page.tsx:952-998`; 253px of a 339px region spent on
Shares+Amount
**Cost:** A member cannot see paid/unpaid — the one thing the roster exists to
say — and rows are visibly ragged for a cause that is off-screen.
**Fix:** move STATE into the NAME cell below 40rem, per `globals.css:1315-1322`.

---

### 10 — `/admin/audit` announces nothing when the page changes

**Severity:** Serious
**Where:** `admin/audit/page.tsx`
**Cost:** Paging a 62-row table is completely silent to a screen reader.
**Fix:** `aria-live="polite"` around the count text. **Not** a focus move.
`e2e/admin.spec.ts:2469` is the existing shape for the regression test.

Related, same surface: `<form method="get">` + `<Submit>` — `useFormStatus()`
never reports pending for a native GET, **and `useSubmitGuard`'s latch is set and
never cleared, surviving a bfcache restore**.

---

### 11 — `/admin/access-lists`: `<main>` is not focusable, so the skip link does nothing

**Severity:** Serious — **out of scope, one attribute**
**Where:** `admin/access-lists/page.tsx:133`
**Cost:** Eleven elements in `src/app` carry `id="main"`. Ten carry
`tabIndex={-1}`. This one does not, so the fragment target scrolls but does not
move focus and the next Tab resumes at the first nav link. Worst possible route
to lose it on: the link sits last in a nav of seven plus "Sign out", and three of
its four server actions redirect back to this same URL
(`actions.ts:34, 42, 56`). SC 2.4.1.
**Fix:** add `tabIndex={-1}`.

---

### 12 — Pattern 2 (total enumeration), five instances

**Severity:** Serious in aggregate
**Cost:** A reader scans a column looking for what differs and finds nothing
differing, so the column teaches them to stop reading it.

| Surface | Where | The recital |
|---|---|---|
| `/payouts/[id]` | `page.tsx:993-996` → `payment-history.tsx:38-45` | six rows, each `2026-08-10 11:57:07 UTC paid 288,600,000.00 ISK by Fleet Commander` |
| `/payouts/[id]` | roster `page.tsx:952-998` | 48 cells, 45 saying the same three things — "`crewNorms` verbatim, on a wider table" |
| `/payouts` | `page.tsx` | ` ISK` ×34, `paid` ×34; and no set-level fact anywhere |
| `/admin/audit` | | the date stated 62 times; narrow is worse — `elapsedShort`'s hour granularity gives `41h ago` three times running, **in the pinned column** |
| `/admin/sync` | `page.tsx:334-341` | `19h ago` ×9, `OVERDUE` ×7, and the one fact appears nowhere |

**Fix shape, uniform:** `crewNorms` — measure deviation against the set, state the
shared fact once in the head's aside, keep a `visually-hidden` per-row
restoration so both channels stay in parity.

**One inversion, one refusal, worth keeping distinct:**
- `/admin/access-lists` is pattern 2 **inverted** — both siblings put two facts in
  the head aside (`9 JOBS · CHECKED 11:57:14 UTC`, `13 MEMBERS · as of 11:57 UTC`)
  and this page spends its aside on the label "add a list", on the surface where
  "how current" matters most (every number is a worker read that may be hours old).
- `/login` has pattern 2 and `login-audit` **recommends leaving it** — the
  `esi-`/`.v1` scope affixes, because "a consent screen is the one place a
  truncated identifier is worse than a long one."

**Parity already broken twice:** `/admin/sync`'s `Cadence (UTC)` loses its visible
channel below 46rem (`globals.css:4390-4392`) while `splitCadenceUtc` is not
media-queried; `/admin/audit` restored `(UTC)` per row and then lost sighted-channel
ordering to `elapsedShort`.

---

### 13 — Pattern 1 (unshaped field), four instances

**Severity:** Moderate–Serious
**Cost:** the page runs long instead of wide; the primary action lands below the
fold on surfaces with half their column empty.

| Surface | Measured | Where |
|---|---|---|
| `/payouts/new` | panel 611px of a 1248px column, **637px (51%) empty for the whole 1,477px scroll**; CREATE OPERATION 412px below the fold at 1440, 577px at 390 | `globals.css:3222`, `new-operation-form.tsx:146` (`rows={10}`), `:158` (`rows={8}`) |
| `/login` | `width: min(30rem, 100%)` = 480px, so **960px (67%) empty ground** while the page overflows vertically by 406px | `page.tsx:32-54` |
| `/admin/access-lists` | content ends x≈700/y≈275 of 1440×900 — ~89% of the fold empty | `page.tsx:133` |
| boundaries | 476px of content in a 912px column | `page--narrow` vs `--measure` 68ch |

**Constraints that must ride with the fix:**
- `/payouts/new`: the `Disclosure` fix **must** pass `defaultOpen={paste !== ""}`
  or a rejected submit hides a 200-line paste behind a closed twisty; the fields
  **must** stay controlled (`new-operation-form.tsx:34-41` — React DOM resets
  uncontrolled fields when the action settles); the loot label **must not**
  contain the word "name" (22 payouts specs match on strict mode); **do not delete
  the panel to fix the whitespace** — it earns its card exception.
- `/login`: do not shrink the seal, do not re-tune `--t-display`, do not raise the
  hero opacity (0.8% effective — the problem is placement), do not widen the panel
  globally. It is the *disclosure* that is unshaped, not the panel, and `.launch`
  carries `overflow: hidden` so it must keep growing.
- Boundaries: **the two 404s do not have this — do not let a fix pass inflate
  them.** Cap `.page__head` at `--measure` instead of widening content.
- `/admin/access-lists`: `.page--wide` is used exactly once, here, and its own
  comment says it "changes nothing about the box… It exists so the page states
  which column it chose." Moving to `page--narrow` leaves `.page--wide` with no
  callers.

---

### 14 — Pattern 3 (uniform control weight), three real instances

**Severity:** Moderate
- `/payouts/[id]`: **70 pressable things, 62 at the identical 28px quiet grade,
  one gold.** Fix raises two `edit` chips to plain `.btn` and demotes per-row
  `exclude`. **Neither adds a second gold.**
- `error.tsx:265-313`: both controls plain `.btn`, 8px apart. A member who has
  just read "check whether it took effect before you send it again" is offered,
  as the first and visually equal choice, the control that sends it again.
  **Fix: differentiate downward** — `.btn--quiet` on Try again, or reverse the
  order. Gold on "Try again" is settled and correct and is not being reopened.
- `/admin/sync`: `Refresh` is an `<a href>` with no pending state, drawn
  identically to `Recheck invalid affiliations`, which enqueues a job.

**Anti-fix, recorded:** `/payouts` has 52 amber tokens and four `DRAFT` rows that
are the only actionable state and the dimmest. **Do not "fix" this by making
drafts louder.**

---

### 15 — Eight confirm controls on `/payouts/[id]` are silent when a press is refused

**Severity:** Moderate
**Where:** `page.tsx:1063-1072`, `pay-flow.tsx:326-334`, `:353-359`, `:397-403`,
`pool-flow.tsx:149-155`, `lifecycle-submit.tsx:147-152`, `page.tsx:1171-1177`,
`page.tsx:1260-1267`
**Cost:** No `pendingLabel` on any of them, and **there is no `ConfirmGroup`
anywhere on this route**, so `useConfirmReport()` is null and a guard-refused
press produces nothing at all.
**`submit-guard.ts`'s justifying premise is false here:** seven actions in
`src/app/payouts/actions.ts:770-810`, `:836-843`, `:948+` end in
`revalidateOperation` and do not redirect.

---

### 16 — `/login`'s six scopes are one weight, and they are three facts

**Severity:** Serious
**Where:** `login/page.tsx:32-54` (`describeScope`)
**Cost:** Six items at identical weight, and the only one that *writes* is row
two of six. They collapse to three facts.
**Fix:** group under three sub-heads, `crewNorms`-style.
**Related on the same surface:** `emblem.webp` is 512×512 / **79.8 KB** drawn at
180px with no `fetchPriority`, while the **2,248-byte** SSO button carries the
page's one explicit hint — not "no priority", *negative* priority. And the error
notice has **0px** above it; the fix must be scoped
`.launch__panel > .notice { margin-top: var(--s-5) }`, **not** a change to
`.notice`, which is load-bearing on six other pages.

---

### 17 — `.status-line__label` renders 400 where the register says 600

**Severity:** Serious (record-contradiction's grade)
**Where:** `globals.css:2404-2410`; markup `account/page.tsx:994`, `:1018`, `:1027`
**Cost:** It is register-shaped — mono, `--t-label`, uppercase, `--ink-faint` —
and is the only one of the fourteen register selectors that never declares
`font-weight`. On the *reference* surface, `12-account.wide.png` shows STANDINGS
and MAP at 600 in the rail (`.facts dt`) and 400 in the manifest, same words,
same size, same colour, ~430px apart. This is the exact collision the register
block was written to close.
**Fix:** add it to the register list at `globals.css:373-391` and delete four
duplicated properties.

---

### 18 — Two disclosure controls change their accessible name every 30 seconds

**Severity:** Moderate
**Where:** `admin/access-lists/page.tsx:217-231` (out of scope) **and
`admin/sync/page.tsx:435-449`** via `globals.css:4142` (in scope)
**Cost:** The `<summary>`'s name is computed from contents that include
`RelativeTime`, which re-renders on a shared 30s ticker. A screen-reader user who
opens a drawer and navigates back finds the control renamed; a voice user loses
the target mid-utterance. SC 4.1.2 / 3.2.4.
**Fix:** pass `ariaLabel={label}` — `Disclosure` already supports it and documents
the label-in-name constraint at `disclosure.tsx:40-43`. Both candidate strings
start with the visible text, so 2.5.3 holds.

---

### 19 — Four page-level disclosures take the 28px in-row grade

**Severity:** Moderate
**Where:** `.disc > summary { min-height: 1.75rem }` — `globals.css:3799-3807`;
call sites `payouts/[id]/page.tsx:135`, `:833`, `:1148`, `appraise-form.tsx:183`
**Cost:** The settled rule is explicit: *"A disclosure drawer is not in-row for
this purpose and takes 36px."*
**Fix:** `2.25rem` at `globals.css:3806`. Same class of defect, out of scope:
`StopWatching` inside the access-lists drawer (`page.tsx:256`), where
`globals.css:2827-2836` already documents the exact two-class buy-back for
`InlineEdit` and it was not extended.

---

### 20 — Eight docblocks make claims the code contradicts

**Severity:** Minor each, but they are how the *next* regression gets written.

| Claim | Reality |
|---|---|
| `focus-heading.tsx:56-58` "No focus ring appears… programmatic focus does not match `:focus-visible`" | **Verified false in Chromium.** `.focus()` on `h1[tabindex="-1"]` returns `matches(":focus-visible") === true` and paints. The belief has already propagated to `confirm-notice.tsx:102`. Measured 120→1035px on a ~260px word. **Fix the comment first, then decide the ring — `width: fit-content` — do not suppress it.** |
| `confirm-submit.tsx:248-249` "No caller now keeps the same class in both states" | Three callers on `/payouts/[id]` do |
| `submit-guard.ts` "a redirecting form's navigation is the feedback" | Seven actions on that route revalidate without redirecting |
| `globals.css:2986-2991` `.btn-row--controls` "follows the data it operates on" | Applied above everything at `access-lists/page.tsx:139` |
| `globals.css:1521-1524` `--ink-faint` on `--hull` = 5.58:1 | Measured **5.18:1** (both pass) |
| `globals.css:2706` disabled pair 4.85:1; DESIGN.md:350 4.85, DESIGN.md:63-64 4.63 | Measured **4.61:1** |
| `globals.css:1031` 4.11/3.72/3.24 | Measured 4.23/3.90/3.47 |
| `nav-items.ts` `navFromPath` "serves three boundaries" | Only `error.tsx` calls it |
| `payouts/new/page.tsx:46-51` + `globals.css:3205+` credit the panel's ground | `--hull` on `--void` is **1.08:1**; the 1px `#787370` border does all the work |

---

### 21 — Record-only corrections (no code change)

- DESIGN.md:130-131 says gold is rationed to **two** uses; DESIGN.md:103 and
  `globals.css:2925` say **four**. The app is consistent with four — **fix the
  record, not the code.**
- `--signal-ok` has zero consumers and `.notice--ok` (DESIGN.md:105,
  `globals.css:2505-2507`) does not exist. `--dur-move` also dead.
- DESIGN.md:132 "No decorative gradients at all" vs `.scroller-fade--start`
  (`globals.css:1108-1124`), whose own docblock says "Decorative and inert".
- DESIGN.md:236-240's nav rule omits `Access lists` (5 listed, `navFor` returns 6).
- Raw `0.12em` should be `--track-label` at `globals.css:2654` and `:3700`.
- PRODUCT.md principle 5: `.closing--compact` at `min(260px, 100%)` is a 4.3×
  downscale of a 1120px asset while `account/page.tsx:1382-1384` says otherwise.

---

## Cross-cutting notes for whoever works this

**A recurring shape: measure a defect, fix one instance, name the sibling, skip
it.** Six instances, every one with the fix already in-repo —
`globals.css:4583` (names `.pool-items`, fixes `.drawer__crew`);
`globals.css:1817-1819` (declines to share `/admin/accounts`' cap with
`/admin/audit` on a premise that measures identical, 426px both);
`globals.css:2827-2836` (`InlineEdit`'s 36px buy-back, not extended to the
access-lists drawer); `sync-audit` F1 (five paired selectors, pairing dropped in
the one media query that decides reflow); `login-audit` F8
(`overflow-wrap: anywhere` one element away); and `removeWatch`
(`services/access-lists.ts:133-153`) which reads the list's name for the audit row
and withholds it from the operator, one return value away.

**The e2e suite's assertions systematically cannot fail in the bug's direction.**
`payouts.spec.ts:3813` is a ceiling with no floor. `error-boundary.spec.ts:239`
asserts `toContainText`/`toBeVisible` on `code.mono`, both of which pass while the
digest sits anywhere on the page. Four `/payouts/new` error codes have no test
because none can exist. Plus the two already on record: `toBeVisible()` is vacuous
against `.visually-hidden`, and bare row-count assertions pass whether or not a
filter worked. **This belongs on the backlog as its own item.**

**`white-space: nowrap` inherited into prose** is the mechanism behind two of the
three worst reflow findings — `.btn-row--tight` on `/payouts/[id]` and `.st` on
`/admin/sync`.

**The narrow viewport is where the sweep's worst findings live.** Counter-examples
that measured clean: `/login` (`scrollWidth` 305 against 320), all three
boundaries (`scrollWidth` 320 and 200% zoom at 640px CSS), `/payouts/new` (320px
and 200% both hold).

**`/payouts/[id]`'s roster borrows `.log--dense` from `/admin/accounts` and
inherits rules whose stated preconditions are false here** — `vertical-align:
middle` ("cells are never multi-line"), `scroll-margin-left: 10rem` ("scoped per
table"; measured pin is 169px). That class is now shared by a table it was never
measured against.

**Two closed Aug-5 items legitimately re-opened, each naming why its premise
expired:** `SYNTHESIS.md:338-350`'s "they arrive through a navigation" died when
`appraise-form.tsx:111-115` moved to a same-route `router.replace` (six
`&&`-mounted `Notice`s on `/payouts/[id]`); and `/admin/audit`'s UUID recital —
the visible one was fixed, the AT one **doubled**, because `RawId`'s hidden span
*joins* `title` rather than replacing it.

**Colour and the freeze.** The instruction was "do not change colour tokens" and
it is respected throughout. Three items are argued to sit *outside* it and the
owner should rule:
- `themeColor: "#080f1f"` (`src/app/layout.tsx:52`, found independently by two
  reviewers) — a stale hard-coded literal from the retired navy palette, not a
  token; paints Android Chrome / PWA chrome navy above a neutral-black page.
- `.st--ok` on `/payouts/[id]`'s roster — `paid` and `unpaid` render at the *same*
  colour. Proposal is a token **assignment** change, not a value change.
- `.escalation`'s border is `--rule` `#373533` on `#0a0a0a` = **1.62:1**; swapping
  to `--rule-strong` (4.23:1) is a token **use** change.

**There is no missed AA anywhere in the palette.** `#787370` is `--rule-strong`, a
non-text boundary measured 4.24 / 4.23 / 3.94 / 3.47 / 4.23 / 3.90 / 5.64 by seven
reviewers against a 3:1 floor (SC 1.4.11). The text token `--ink-faint` `#90877e`
is 4.61:1 worst case. `sync-audit`'s verdict stands for the whole sweep: *"Nothing
on this surface is close to a floor. Do not touch the tokens."*

**One whole-app finding the freeze forecloses, surfaced rather than dropped:** the
`#0a0a0a` ground is PRODUCT.md's anti-reference #3 verbatim, and `whole-app` ranks
it third by cost. Its thesis: *"The words are authored. The layout is generated."*
Composite: *"A well-written flight manual laid out by a build script."* Five of
fifteen surfaces are h1 + sentence + button, top-left.

**A whole-app claim I disproved and dropped:** an app-wide kerning bug eating the
space after k-final words. No `word-spacing` declaration exists anywhere, and the
only negative letter-spacing is on headings (`-0.02em`, `-0.01em`, `-0.03em`). It
is a PNG text-extraction artifact.

---

## What the sweep could not see

Five capture gaps, **all now closed** — see the two sections below.
`capture.spec.ts.txt` and `capture-gaps-124.spec.ts.txt` are preserved so any of
it can be re-shot.

1. ~~**A weighted payout split.** The fixture writes `amount` directly
   (`capture.spec.ts.txt:210-222`) and never runs `recalculate`, so every share is
   flat. `core/payout-split.ts:73` is correct — this is a fixture artifact, not a
   bug — but item 12's roster fix needs re-checking against a real split.~~
   **Closed** — shot `29`.
2. ~~**`/admin/audit`'s Details column at real density** — the fixture seeds action
   names absent from `PARTS`.~~ **Closed** — shot `30`.
3. ~~**`/login?error=…`** in its three tones.~~ **Closed** — shots `16`–`20`.
4. ~~**`/payouts/new`** with a populated `Notice`, and at 320px.~~ **Closed** —
   shot `31`.
5. ~~**Six of `/admin/access-lists`' seven states.**~~ **Closed** — shots `21`–`28`.

Also: the Next dev overlay reported **real console/hydration errors** — `1 Issue`
on shots `08` and `11`, `2 Issues` on `13`. Worth one click if a fix pass has the
dev server up.

And: **the `/account` reference surface is not proven at narrow**, and item 17
shows it breaks the one typographic rule DESIGN.md states in absolute terms.

---

## Re-shoot: gaps 3 and 5 (shots `16`–`28`)

One temporary spec, twelve cases, 26 PNGs at 1440x900 and 390x844. `git status`
before the boot was empty; after it, exactly the PNGs plus the spec — no
`tsconfig.json` or `AGENTS.md` rewrite this time. Spec deleted.

### Gap 3 closes clean — no finding

`/login?error=` renders as `loginErrorTone` argues it should, and the pixels are
the evidence the docblock could not be.

- `oauth_failed`, `oauth_expired` → red-bordered notice, `!` glyph, between the
  motto and the sign-in button.
- `oauth_denied`, `session_expired` → neutral box, `·` glyph, same slot.
- `?error=not-a-real-code` → **no box at all**, not an empty bordered region.

That is PRODUCT.md principle 4 honoured: a cancelled sign-in and an expired
session are not painted as faults the user must fix. **Nothing to work here.**

### Gap 5 produces four findings, three of them the brief's own patterns

**A. Every fault state is an unshaped field** (pattern 1). Shots `22`–`26`. All
six non-`normal` states share one silhouette: lede, one gold button, a
full-width `WATCHED LISTS` rule (~1200px), and beneath it a ~545px notice, with
the lower ~500px of a 900px viewport void. The rule is the widest object on the
page and it labels the emptiest.

**B. The empty watched-lists region renders during holder faults.**
`showsObservations` (`view.ts:160-162`) excludes only `grant-needed` and
`designate-needed`, so `scope-dropped`, both `holder-no-token` variants,
`holder-needs-reauth` and `catalog-empty` all print a section heading plus *"No
lists are being watched yet."* directly under a lede that already said why
nothing is happening. It restates the fault in weaker words and takes the fold
to do it. Cost: the admin's eye goes to the largest structure on the screen and
learns nothing. Fix: gate the region on the same predicate as the remedy —
if the monitor cannot read, the observation region has nothing to say.

**C. Total enumeration in the missing-access table** (pattern 2), shot `28`.
"Null Harvest Inc" appears identically on 8 of 10 rows; the other two are `—`.
Four broad-grant lines all end in the identical clause *"plus an unknown number
of others"*. `crewNorms` is the fixing pattern: state the shared fact once
(*"all but two are in Null Harvest Inc"*), show only the deviation per row.
At 390px this table is two columns of which one is a constant.

**D. `STOP WATCHING` is the quietest thing on the row** (pattern 3). It renders
at the same weight and colour as the `BROAD GRANTS (1)` rule labels above it,
bottom-left of each drawer, identical on every row — a caption, not a control,
and it is the only destructive action on the page. Nothing directs the eye, and
what little direction exists points away from it.

### And one plain defect, not a design finding

**The never-read row renders as `#4104` with no name** (shots `27`, `28`), even
though the catalog holds "Capital umbrella" and `catalog` is already in scope at
`page.tsx:67`. `getWatchedListViews` (`access-lists.ts:215`) takes `name` from
the snapshot alone, and a list watched but never read has no snapshot row.

The service layer already contains the fix: `watchedListName`
(`access-lists.ts:88-103`) tries the catalog first and the snapshot second, with
the docblock *"a missing name must never cost the row"* — and it is wired only
to the two audit writes (`:127`, `:142`), never to the display path. The rule is
written, implemented, and not applied where a human reads it.

---

## Sequencing constraints

Violating any of these produces a red suite or an undone fix.

- `/payouts`: scope `.log--payouts tbody th` off `.log th`'s nowrap **before**
  promoting the Name cell.
- `/admin/sync`: the name track must be **capped** (`minmax(7rem, 13rem)`), never
  reverted to `1fr`.
- `/payouts/[id]`: nothing may add a second gold; `AppraiseForm`
  (`page.tsx:782-790`) must not be split back into two call sites — that
  reintroduces a silent data-loss notice; item 12's roster fix needs the re-shoot
  first.
- `/payouts/new`: `defaultOpen={paste !== ""}`; fields stay controlled; the loot
  label must not contain "name".
- Boundaries: do not inflate the two 404s; decide the focus ring rather than
  suppressing it; do not add `"use client"` to `ui.tsx` (it would make the
  client-graph problem worse — measure first); price `.escalation`'s ground and
  border together.
- `/admin/access-lists`: `monitorRemedy`'s two hrefs (`view.ts:135-151`) must not
  be unified — the bare `/auth/eve/link` is what *drops* the ACL scope, so
  offering it as the remedy sends the admin round the loop that caused the fault.
  `rowHasDetail`'s asymmetry (`view.ts:232-236`) must not be made uniform.
- `/admin/audit`: do not widen the shared `.scroller--tall`. Do not let a fix pass
  collapse `summarize.ts`'s `Part.keys`, or shorten `summarizeDetails`' line.

---

## What is good and must survive a fix pass

Recorded because fix passes delete things.

- **`/payouts/[id]`'s focus-restoration architecture** — "the best work in this
  codebase and none of the fixes above should touch it." `useOptimistic` rejected
  for a money ledger, on the record. No arm timer, refused on 2.2.1 grounds.
- **`error.tsx`'s copy, all of it** — "That's a fault on this end, not something
  you did." And `Notice live={false}` on the error boundary — easy to "fix"
  backwards.
- **`/login`'s scope copy** — the best writing in the app.
- **`/admin/access-lists`' `monitorState` cascade** and `"plus an unknown number
  of others"` — the difference between a true statement and a false one.
- **`/admin/audit`'s `summarizeDetails`** and its `Part` vocabulary; `(UTC)` said
  once and restored per row — the model, not a target.
- **`/admin/sync`'s `overdue` exclusion from auto-open** (`view.ts:99-105`) and
  `groupTone` refusing green.
- **`/payouts`' three-way empty state** (`page.tsx:380-407`) and `complete` vs
  `shown` (`:114-120`).
- **`/payouts/new`'s controlled-input construction** and the operator redirect.
- **`.cell-link`'s explicit 28px floor with a written refusal of 2.5.8's inline
  exception.**
- **`navFromPath`** producing three different bars from one rule — a fix pass must
  not hand-edit any of those lists.

---

## Scope note

`/admin/access-lists` was reviewed unrequested. Both its reports carry an explicit
out-of-scope banner and every finding lifts out cleanly. Items **8**, **11**, and
parts of **13**, **18** and **19** are its. Two are strong enough to be worth
taking anyway: the inert skip link (one attribute, WCAG 2.4.1) and the fault
sentence rendered at boilerplate weight on a monitor page.

---

## Re-shoot: gaps 1, 2 and 4 (shots `29`–`31`)

`capture-gaps-124.spec.ts.txt`, three cases, seven PNGs at 1440x900, 390x844 and
one at 320x800. Deleted after the run; the tree was clean before and after
(`docs/design-sweep-2/shots/` is gitignored at `.gitignore:25`).

Two fixture corrections did the work. Gap 1's split now goes through the real
`recalculate` from `src/services/payouts.ts:670` with shares varying 0.25 → 3.00
and one participant excluded, instead of `amount` written by hand. Gap 2's rows
now use only action names declared in `PARTS` (`src/app/admin/audit/summarize.ts:253`),
so the Details column renders through the declarative path that ships rather than
the generic key=value fallback the old fixture forced it into.

### Gap 1 closes clean on its stated question — no finding

With a genuinely weighted split — 8 rows at par 1.00, 7 deviating — the roster's
deviation channel is doing what item 12 wanted it to. Enumeration is warranted
here; there is no shared fact being recited. **Nothing to work.**

Three secondary observations, report-only, none of them defects:
- AMOUNT prints `219,652,173.91 ISK` identically on 8 of 15 rows. It is
  mechanically derived from shares, and eliding the money each person is owed
  would be a worse page than repeating it.
- `- UNPAID` + `COPY AMOUNT` + `MARK PAID` repeat on all 15 payable rows while the
  header already says `0/15 paid` — pattern 3, but every one of those buttons acts
  on a different person, so nothing here is a shared fact stated fifteen times.
- The excluded participant sorts first alphabetically, so the one person getting
  nothing sits at the top of the roster.

### Gap 4 produces one finding

**F1 — the rejection `Notice` pushes the form 88px away, and only when it has
something to say.** Measured at the DOM: `#new-operation-error` bottom to
`.form-stack .rule-head` top is **0px** when the slot is empty and **88px** when
it is populated. The empty case was already handled — `.notice-slot` is
`position: absolute` (`globals.css:3551`) and `globals.css:3284` resets the
following `.rule-head`'s margin — but a populated notice carries class `.notice`,
which that selector does not match, so three spacings stack: `.notice`
`margin-bottom: var(--s-5)` 24px + `.form-stack` `gap: var(--s-4)` 16px +
`.rule-head` `margin-top: var(--s-7)` 48px.

Cost: on a rejection — the one moment the operator most needs the error tied to
the form it is about — the error floats alone with the form pushed below it.
Worst at 320px, where the vertical space is scarcest.

Fix: extend the existing reset at `globals.css:3283-3285` to `.form-stack >
.notice + .rule-head`, and add `.form-stack > .notice { margin-bottom: 0 }` so
the grid gap alone spaces it, matching every other sibling pair in the form.

### Gap 2 produces three findings

**F2 — the Details column prints raw character IDs.** `account.created`,
`account.main_changed` and `admin.main_changed` render `main → 90000002` /
`main 90000002`. The Target column, three cells to the left, resolves the same
class of referent to `Probe Kid` on the same row. `resolveAuditIdentities`
(`src/services/audit.ts:~300-415`) already builds `nameByCharacterId`, and already
has a `DETAIL_ACCOUNT_KEYS` mechanism for account uuids appearing inside
`details` — there is simply no character equivalent. Fix is a parallel
`DETAIL_CHARACTER_KEYS` plus a resolving part helper in `summarize.ts`. Real
scope: new key map, new part, widened fetch, tests.

**F3 — `payout.deleted` clips mid-number.** Renders `deleted Tama gatecamp,
occurred 2026-07-30, roster 1…` at 1440px — four declared parts exceed the
column. Not data loss (the `+` disclosure recovers it), but truncating inside a
numeral reads as broken rather than deliberate.

**F4 — at 390px the Details column is entirely off-screen** behind the `Scroller`,
and action names truncate mid-word (`account.main_chang`, `payout.item_repric`).
The column gap 2 existed to prove out is unreachable on a phone.

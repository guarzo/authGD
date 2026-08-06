# audit — /admin/sync

Register: **product**. Read in full: `src/app/admin/sync/page.tsx` (768),
`view.ts`, `actions.ts`, `src/core/run-summary.ts`, `_components/{ui,scroller,
disclosure,relative-time,submit,format-ago}`, the `.strip*` / `.log--runs` /
`.worker` / `.notice` / `.btn*` / `.only-*` / token blocks in `globals.css`, and
`e2e/sync.spec.ts`. Contrast ratios below are computed from the OKLCH tokens,
not eyeballed.

## Findings

### 1. The queued marker's words and the last-run age collide in the row's accessible name

- **Severity:** serious
- **Where:** `src/app/admin/sync/page.tsx:274-339`, `src/app/admin/sync/view.ts:333-338`
- **Cost:** In the two minutes after an admin presses "Sync now" — the only
  window the marker exists in for a healthy fan-out — a screen-reader admin
  hears `membership ok, queued 3m ago every 30m next 14:30` and reads "3m ago"
  as the age of the queue entry, when it is the age of the last run; the fact
  they pressed the button to establish is the one the row now misstates.
- **Principle:** none (WCAG 4.1.2 is satisfied — the name exists; it is the
  ordering that lies)
- **Fix:** The summary's name is a bare four-value concatenation because
  `.strip__head` is `aria-hidden`, and three of the four values are
  self-describing (`ok`, `every 30m`, `next 14:30`) while the fourth is not.
  Insert a visually-hidden `, last run ` immediately before the `<RelativeTime>`
  at `page.tsx:336`, inside the summary. That yields
  `membership ok, queued, last run 3m ago, every 30m next 14:30` in the common
  case and `… ok, queued 5m ago, last run 3m ago, …` in the escalated one,
  which is the only form where the two elapsed times are separable. Note the
  collision is *worst* in the sub-`QUEUED_AGE_NOTABLE_MS` branch, where
  `queuedMarkerText` returns the bare `", queued"` — precisely the branch
  `view.ts:320-332` argues should stay quiet, and the branch every press
  produces. Adding the label to the age rather than the marker keeps that
  argument intact.

### 2. None of the three enqueue controls confirms itself within a screenful of where it was pressed

- **Severity:** serious
- **Where:** `src/app/admin/sync/page.tsx:160` (the notice), `733-765` (the two
  page controls), `712-719` (the per-row Re-run)
- **Cost:** An admin who scrolled past seven job rows and two open drawers to
  press "Re-run wanderer" sees the label flip to "Queueing…" and back, and
  nothing else — the confirmation renders at the top of the page, off-screen,
  and the only nearby change is a 0.5em `--ink-faint` outlined ring in the
  summary row above the drawer, which carries no visible word at all; so the
  press that did work and the press that silently failed look the same from
  where the admin is standing.
- **Principle:** none (the enqueue is real and audited; this is a feedback-siting
  problem, not a correctness one)
- **Fix:** Not polling — `page.tsx:749-761` settles that and it should stay
  settled. Two cheap, local options, either of which closes it: (a) render a
  second, per-row confirmation inside the open drawer next to `.strip__act`
  when `?queued=` names this job, derived from the same `queuedNotice` inputs
  (`view.ts:214`), so the row that was acted on says so where the action was;
  and (b) give `.strip__queued` a visible companion word in the drawer body
  rather than only in the fixed 7.5rem health track — the track-width argument
  at `globals.css:2505-2515` is about the *summary row* and does not bind
  inside the drawer, which is full-width. The two page-level buttons at
  `733-765` are a weaker case than the per-row one (their scroll distance is at
  least predictable), but they share the shape: the page's one gold button
  reports its outcome at the opposite end of the document.

### 3. The three group labels are the one thing only sighted users can navigate to

- **Severity:** moderate
- **Where:** `src/app/admin/sync/page.tsx:228-231`, `globals.css:2578-2596`
- **Cost:** An admin using heading navigation — the fastest way through a page
  of seven `h3`s — goes `Sync` → `7 jobs` → `membership` → `contacts` → … and
  reaches every row without ever hearing "Sweep", so the question the group
  labels exist to answer ("which four does Sync now cover?") is still
  unanswerable by ear, which is the failure `page.tsx:197-212` says the whole
  restructure was for.
- **Principle:** WCAG 1.3.1 / 2.4.6 (the visible section label has no
  programmatic heading role); PRODUCT.md principle 3, "scanning is the primary
  act"
- **Fix:** Make `.strip__group` an `<h3>` and `.strip__name` an `<h4>`. This is
  a pure element swap with no visual consequence: both classes are already in
  the label register (`globals.css:269-284`), which declares family, size,
  weight 600 and case at class specificity, so neither the `h1,h2,h3` reset at
  `:150-155` nor a UA `h4` default reaches either one. `aria-labelledby` on the
  `<ul>` keeps working — a heading is a valid labelling target — and
  `e2e/sync.spec.ts:155-158` (asserts `.strip__group` is not `aria-hidden`)
  still passes. The per-group `role="list"` should stay; this adds the second
  route to the same fact rather than replacing the first.

### 4. A collapsed group row announces two unseparated ISO stamps at desktop width

- **Severity:** moderate
- **Where:** `src/app/admin/sync/page.tsx:424-466`
- **Cost:** At any width above 40rem — which is every desktop, i.e. where an
  admin actually reads run history — a five-run collapsed row's Started cell
  reads as `2026-08-05 14:00:00 2026-08-05 18:00:00 5 runs`, because the en
  dash between the two stamps is dropped at default punctuation verbosity and
  nothing else separates them; the reader cannot tell a range from two adjacent
  cells, on the row that stands in for five.
- **Principle:** none (this is the same defect `Absent`'s docblock at
  `page.tsx:64-82` documents, in a cell `Absent` was not applied to)
- **Fix:** The hidden sentence that fixes exactly this —
  `started {from} UTC, ended {to} UTC` at `page.tsx:462-464` — is nested inside
  the `.only-narrow` span, which is `display: none` above 40rem
  (`globals.css:3024`, `:3188-3194`) and therefore out of the accessibility
  tree at the width where the ISO stamps are showing. Lift that
  `visually-hidden` span out of `.only-narrow` to be a direct child of the
  `<td>`, and mark the `.only-wide` stamp pair `aria-hidden="true"` so the
  values are not read twice at wide widths. The single-run branch at `:587-600`
  does not have this problem (one stamp, nothing to separate) and needs no
  change. Verify the lifted span stays `position: absolute` so it cannot inflate
  the `scrollWidth` the `Scroller` measures — the constraint at
  `page.tsx:79-81` applies to it too, and `.visually-hidden`
  (`globals.css:3013`) already satisfies it against `.scroller`'s
  `position: relative`.

### 5. Refresh is a link wearing a button's clothes, standing between two buttons

- **Severity:** moderate
- **Where:** `src/app/admin/sync/page.tsx:762-764`, `globals.css:1511-1535`
- **Cost:** A keyboard admin tabs across three controls that are pixel-identical
  (same `--hull-hi` ground, same `--rule-strong` border, same mono uppercase,
  same 36px, same gold hover) and presses Space on the third as they just did on
  the first two; the page scrolls a screenful instead, with no error and no
  refresh, and they have to work out that this one control wants Enter.
- **Principle:** WCAG 3.2.4 Consistent Identification (three controls presented
  identically, two of which enqueue work and one of which navigates); product
  register, "consistent affordances across the surface"
- **Fix:** Do not add a Space handler — the `<a>` is correct, it really is a
  navigation, and the eslint escape at the call site argues its case properly.
  Grade it apart instead: `className="btn btn--quiet"` puts it in the
  text-until-hovered colour grade the codebase already has, so it reads as the
  page's quietest control rather than as a third peer of the two gold/neutral
  action buttons, and the role difference the screen reader already announces
  ("Refresh, link") gets a visual counterpart. Leaving it in
  `.btn-row--controls` is fine once the grade differs. Note this does not touch
  the `?queued=`-dropping behaviour the anchor exists for.

### 6. The stale-worker notice is a `role="alert"` mounted with its text already inside it

- **Severity:** minor
- **Where:** `src/app/admin/sync/page.tsx:166-172`, `src/app/_components/ui.tsx:241-292`
- **Cost:** Nobody is announced the worker outage on the load that reveals it,
  because an alert region born holding text is the one shape the `Notice`
  docblock says AT will not reliably report — so the page's most consequential
  fact reaches a screen-reader admin only if they happen to read past it.
- **Principle:** none (the primitive's own documented contract, `ui.tsx:250-260`)
- **Fix:** The conditional mount here is the exact `{cond && <Notice>}` form
  `ui.tsx:250-256` names as defeating the region it asks for, and this page is
  cited in that comment as the reference implementation. Since no interaction on
  this page can flip `worker.fresh` mid-session (there is no polling, and
  `evaluateFreshness` carries 90 minutes of slack), the region can never fire
  from a mutation and only ever costs a false promise: pass `live={false}` on
  this one, which the primitive already supports for precisely "something else
  already announces this arrival". Do *not* mount it unconditionally to fix the
  region — that would put an alarm box around a healthy worker line, which
  PRODUCT.md principle 4 rules out. The visual treatment is right as-is.

### 7. Collapsed rows italicise the status token and the figure columns

- **Severity:** minor
- **Where:** `globals.css:3312-3314`
- **Cost:** An admin scanning the counters column down a runs table hits sheared
  glyphs on exactly the rows that stand for several runs, and the `.st` token —
  the system's one fixed value treatment, mono / uppercase / 600 / 11px with
  0.08em tracking — renders italic here and nowhere else in the app.
- **Principle:** DESIGN.md's value/control distinction (`globals.css:1340-1350`:
  every value in an admin table is the same dotted mono token)
- **Fix:** The intent — "this row stands for several without relying on the 'N
  runs' text alone" — is right and worth keeping. Narrow the selector so the cue
  lands on the row's prose without touching the two things the register owns:
  `.log--group td:not(.num)` at minimum, and better, drop `font-style` and mark
  the group instead with the treatment `.strip__group-count` is already doing
  the work of (`globals.css:3322`) plus a leading rule or a `--ink-faint`
  left-of-cell marker. `tabular-nums` keeps the advance widths equal under
  italic, so the digits still align at their origins; it is the optical column
  that goes ragged, not the grid.

## What is good and must survive

- **The `colSpan` arithmetic is correct in all four branches, including the
  empty-`cols` case.** `span = cols.length || 1` (`page.tsx:256`) pairs with a
  header that renders one literal `<th>Counts</th>` when `cols` is empty
  (`:380-382`), so the 1 is not a fallback, it is the true column count. Verified
  against all four body branches (`!counts` / `isNoChange` / per-column, in both
  the group and single-run paths): header cells and body cells sum equal in
  every one. A future "fix" that changes `|| 1` to `cols.length` or drops the
  literal header will silently break table semantics with no visual tell.
- **`Absent` coverage in the Took, counts and Raw cells of both branches.** Six
  distinct absences carry six distinct hidden strings — "not recorded", "not
  reported", "not reported yet", "nothing counted", "no payload", "still
  running" — and the distinctions are real, not decorative (`page.tsx:487-490`,
  `:528-537`, `:559-566`, `:601-607`, `:623-653`, `:680-688`). Do not collapse
  them to one shared word.
- **The `Scroller`'s conditional tab stop plus `ResizeObserver`.** The whole
  chain — 0×0 in a collapsed `<details>` → no stop → observer fires on open →
  stop returns — is load-bearing for keyboard access to every runs table, and
  the only thing holding it is `e2e/sync.spec.ts:220-221`. Any refactor that
  makes `scrollable` start `false`, or that measures once instead of observing,
  takes the tables away from keyboard users during the pre-hydration window or
  permanently.
- **The `at=` stamp on every redirect** (`actions.ts:24`, `:54`, `:64`). It is
  the only reason a second press of the same button produces a different string
  and therefore a live-region mutation. Removing it as "noise in the URL" makes
  the confirmation silently stop announcing on repeat presses, with no test
  failure that names the cause.
- **`RelativeTime`'s single shared 30-second ticker with a per-subscriber
  try/catch** (`relative-time.tsx:31-60`). Up to 42 instances on this page, most
  behind `display: none` or a collapsed drawer; the shared phase is also why the
  ages step together rather than at 42 offsets.
- **Contrast holds everywhere on this surface, including on hover.** Measured
  from the tokens: `--ink-faint` is 6.15:1 on `--void`, 5.58:1 on `--hull` (the
  `.strip__head` ground) and 4.85:1 on `--hull-hi` (the hovered summary row) —
  all above 4.5:1, so `.dim`, `.detail`, `.strip__cadence`, `.strip__group` and
  `.btn-row__stamp` are all AA as text, not merely as UI. `--rule-strong` is
  4.11 / 3.72 / 3.24:1 across the same three grounds, clearing 1.4.11 on each.
  A future "quieten the strip" pass has under 0.4:1 of headroom on the hovered
  row and should not spend it.
- **The 40rem `only-wide` / `only-narrow` swap is a visibility change, not a
  content change** (`globals.css:3184-3194`, `page.tsx:577-599`). The exact ISO
  instant stays in the accessibility tree at narrow widths via a
  `visually-hidden` sibling rather than a `title`. Finding 4 is a gap in this
  pattern's application, not an argument against the pattern.

## Could not evaluate

- **Whether the accessible names actually compute as written.** The explicit
  space before the `<br>` at `page.tsx:349` is documented against Chromium's
  accname behaviour; Firefox and WebKit differ on `<br>` in name computation and
  would produce a different (possibly correct-anyway) string. Settling it needs
  an AT run or `getComputedAccessibleName` across the three engines. Findings 1
  and 4 do not depend on the answer — both are about values that abut with no
  separator token at all, in any engine.
- **Actual screen-reader announcement of the two live regions on redirect.** The
  DOM shape is right (permanent region, text-only mutation) and `e2e` asserts
  the text, but whether NVDA/JAWS/VoiceOver report a polite region update
  reliably on an App Router server-action re-render is not knowable from source.
- **The runs table's real geometry at 320px.** With `min-width: 0` and 4px cell
  padding, a wanderer window that moved six counters is ten columns in a ~286px
  region; the `Scroller` handles it correctly by scrolling, but whether the
  `humanizeKey` headers ("would remove", "unblock failed") degrade to a readable
  ragged stack or to one-character-per-line needs a browser. The existing 320px
  specs cover the floor coming off, not the header wrapping.
- **Focus after a press.** Reasoning from the code, the `Submit` button element
  persists across the server-action redirect (same tree position, `Disclosure`'s
  `useState` keeps the drawer open, `<li key={g.jobType}>` is stable), so focus
  should be retained and no 2.4.3 issue arises — but nothing in `e2e/sync.spec.ts`
  asserts it, and a future change to `revalidatePath` scope or to the row keys
  could drop it without a failing test. Worth one assertion regardless of this
  audit.

## Contested

Nothing on the settled list is wrong. One adjacent note: `fmt()`'s bare `…` is
correctly out of scope, but its docblock's justification ("no run in the schema
reaches it with a null `startedAt`") is contradicted by the file 360 lines down
— `page.tsx:394-396` null-guards `entry.from`, and `CollapsedRun.from` is typed
`Date | null` precisely because `RunLike.startedAt` is. The exemption should
rest on "this is one glyph in a cell that has other text", not on an
unreachability claim the surrounding code does not believe.

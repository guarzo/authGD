# critique — the shell and the shared design system

Surface: `src/app/layout.tsx`, `src/app/admin/layout.tsx`, everything in
`src/app/_components/`, and all 3,331 lines of `src/app/globals.css`. Read in
full. Counts below were taken by opening every match.

## Findings

### 1. Three error notices are mounted with `&&`, which is the one shape `Notice` was built to prevent

- **Severity:** serious
- **Where:** `src/app/admin/accounts/page.tsx:154`, `src/app/account/page.tsx:231`, `src/app/payouts/[id]/page.tsx:251` — against `src/app/_components/ui.tsx:248-259`
- **Cost:** A screen-reader admin whose bulk action fails on `/admin/accounts` is redirected back to a page that looks unchanged and hears nothing, because the `role="alert"` element arrives already holding its text instead of receiving it.
- **Principle:** The component's own docblock, `ui.tsx:250-256`: "The `&&` form is the one shape that defeats the live region it just asked for … AT announces a *change* to a region far more reliably than a region born holding text." It then claims "the next caller cannot omit it by writing `&&`." Three callers did, and all three are `tone="bad"` — the only tone that interrupts.
- **Fix:** Drop the guard at all three sites: `<Notice tone="bad">{errorMessage}</Notice>`. `Notice`'s `empty` check already covers `undefined` and `""`, and an empty slot carries no `notice--bad` class and no glyph, so nothing renders. These three arrive via `searchParams` after a server-action `redirect()`, which is a soft navigation, so the reconciled-in-place `<p>` is exactly the case the empty slot buys. `payouts/[id]/appraise-form.tsx:43`, `payouts/new/page.tsx:85` and `admin/audit/page.tsx:527` are already correct and should be left alone.

### 2. The nav's item set changes membership between sections, so some destinations have no door

- **Severity:** moderate
- **Where:** `src/app/_components/admin-nav.tsx:14-19`, `src/app/error.tsx:40-56`, `src/app/payouts/page.tsx:49-52`, `src/app/payouts/new/page.tsx:60-63`, `src/app/payouts/[id]/page.tsx:155-158`, `src/app/account/page.tsx:140-142`, `src/app/not-found.tsx:42`, `src/app/payouts/[id]/not-found.tsx:47-50`
- **Cost:** An admin standing on `/admin/audit` who wants the payouts list has no link to it anywhere in the chrome; they click "Your account" and then hope "Payouts" is there, which on that page is gated behind `showPayoutsLink`.
- **Principle:** none. WCAG 3.2.3 governs relative *order*, and the order here is consistent; it is presence that is not, and presence is what costs the click.
- **Fix:** Decide one rule and apply it at all eight sites: either the bar always offers every section the viewer may enter (admin bar gains Payouts; the payouts/member bars gain Audit log and Sync when `isAdmin`), or it deliberately offers only the current section plus one door out, and that is written into DESIGN.md as a rule so the next page does not invent a ninth list. The eight arrays are hand-copied today; `error.tsx:37-39` already carries a comment asking a future editor to keep two of them in step by hand, which is the weakest possible enforcement of a rule that has already been broken across the other six.

### 3. `Tone` has five members and no definition, so `ok` and `off` both mean "fine" in one table

- **Severity:** moderate
- **Where:** `src/app/_components/ui.tsx:200` (`export type Tone`), rendered at `admin/accounts/page.tsx:469` (`tone="off"` for `active`) and `admin/accounts/page.tsx:877` (`tone="ok"` for `on`)
- **Cost:** An admin scanning forty rows sees the healthy value of the cryo column in grey and the healthy value of the Discord column in green, and has to learn per-column what "the colour of nothing wrong" is on this page.
- **Principle:** DESIGN.md's status-token section says colour appears "only when the state is actionable" (echoed at `globals.css:1341`). `active` follows that rule and `on` does not, but nothing in the shared vocabulary says which is right, so both survived.
- **Fix:** Add the missing half of the docblock to `Tone` at `ui.tsx:200`: one sentence per member saying when to reach for it — `ok` for a state that had to be *achieved*, `off` for a state that is merely the absence of a problem, `neutral` for a value with no health reading at all. Then reconcile the two sites above against it. This is a comment on the type, not a runtime change; do not turn `Tone` into a bound `{tone, label}` pair (see "must survive").

### 4. `.dim` changes font-size as well as colour, and the class written to fix that has zero call sites

- **Severity:** moderate
- **Where:** `src/app/globals.css:1315-1329`, applied 60 times across 11 files; the sharpest instance is `src/app/admin/audit/page.tsx:628`
- **Cost:** In the audit log's action column, `payout.` renders at 13px and `create` at 14px inside a single anchor, so one string breaks its own baseline run halfway through.
- **Principle:** none, beyond the file's own diagnosis. `globals.css:1322-1327` states it plainly: "The audit found several data cells reaching for `.dim` and getting a size change with it; this is the class they should take instead." The class is `.dim-ink`. It has **zero** references in `src/app/**/*.tsx`.
- **Fix:** Either finish the migration the comment describes (swap `.dim` for `.dim-ink` at the sites inside `.log` cells, starting with `admin/audit/page.tsx:89`, `:151`, `:628`, `:649`) or delete the size declaration from `.dim` and give the three prose call sites that actually want 0.8125rem an explicit class. Leaving an unreferenced fix in the stylesheet is the worst of the three states: the defect is live and the file reads as if it were closed.

### 5. The admin pending count renders in the prose face, at the one place the whole shell exists to point at

- **Severity:** moderate
- **Where:** `src/app/globals.css:407-411` (`.shell__badge`), markup at `src/app/_components/ui.tsx:145-150`
- **Cost:** The number telling an admin there is work waiting is set in 15px Archivo 400 immediately beside its own 11px IBM Plex Mono 600 uppercase label, and in `--ink-faint` where that label is `--ink-dim`, so the count is both the odd typeface out and the dimmest thing in the group.
- **Principle:** DESIGN.md, "prose is proportional, state is monospaced" — called the system's main typographic idea. A pending count is state.
- **Fix:** `.shell__badge` declares only `font-variant-numeric`, `letter-spacing` and `color`, so it inherits `body`'s `--font-sans` at `--t-body` (`globals.css:113-118`). Add `font-family: var(--font-mono), ui-monospace, monospace; font-size: var(--t-label); font-weight: 600;` and raise the colour to `--ink-dim` so the count is not quieter than the word it modifies. `--track-control` is already the right token per DESIGN.md's tracking table ("button and badge labels"); keep it. Do not add a filled pill — `globals.css:404-405` argues against that and the argument holds.

### 6. The type scale declares six steps and the stylesheet ships nine

- **Severity:** moderate
- **Where:** `src/app/globals.css:69-74` (tokens) against 14 raw `font-size` declarations at lines 174, 352, 362, 1235, 1317, 1336, 1774, 1785, 2029, 2332, 2661, 2681, 2899, 2924
- **Cost:** Whoever adds the next small caption picks whichever of 0.75rem, 0.8125rem, 0.6875rem or 0.625rem their nearest neighbour happened to carry, which is the exact failure the tracking tokens were introduced to end.
- **Principle:** DESIGN.md:128-129: tracking "is tokenised by the job the label is doing rather than left as a number at the call site." The same argument applies to size, and the type scale is a declared table.
- **Fix:** Three separate problems, and the first two are free:
  - **Duplicates.** `.shell__wordmark b` (352) retypes `--t-body`; `.btn--micro` (1774) and `.copy-result` (1785) retype `--t-label`. `.btn--micro`'s is inert — `.btn` already sets `font-size: var(--t-label)` (1522). Same for tracking: `.tier--lead` (1495) and `.launch__foot` (2333) retype `--track-label`'s 0.12em, `.copy-result` (1786) retypes `--track-value`'s 0.08em. Replace all six with the token.
  - **Undeclared steps.** 0.75rem appears five times (`.json`, `.detail`, `.filter-form__hint`, `.strip__cadence`, `.strip__window`) and 0.8125rem three times (`.dim`, `.table-note`, `.footnote`). Five uses is more than `--t-data` gets. Name them (`--t-data-sm`, `--t-prose-sm`) and add them to DESIGN.md's table, or collapse them onto `--t-data` and `--t-body`.
  - **Genuine one-offs.** `.shell__wordmark span` (0.5625rem) and `.launch__foot` (0.625rem) each carry a docblock arguing for a sub-label size; those arguments stand. Leave them raw or give them one shared token, but say which in the record. `code`'s `0.9em` (174) is relative and correct.

### 7. Five button colour grades exist against the three DESIGN.md sanctions

- **Severity:** minor
- **Where:** `src/app/globals.css:1511, 1600, 1621, 1635, 1653` against `DESIGN.md:183-186`
- **Cost:** A reader of DESIGN.md building the next destructive control does not know `--danger-quiet` exists and reaches for `--danger`, putting the loudest thing on the page on an action a member takes routinely — the exact mistake `globals.css:1646-1652` says was already made once and reverted.
- **Principle:** DESIGN.md:183, "three grades."
- **Fix:** The count in the CSS is `default` / `primary` / `quiet` / `danger` / `danger-quiet`, plus one size modifier (`--micro`) and two state treatments (`[aria-busy]`, `[aria-pressed]`/`[aria-current]`). Four of the five are legitimate: DESIGN.md's sentence "Destructive actions take `--signal-bad` on the border and text" covers `danger` without naming it a grade. Only `danger-quiet` is undocumented, and it is the one with the subtlest rule (red only on row-hover or focus; usage counted at 6 call sites). Add it to DESIGN.md's button bullet as a fourth grade with its condition, and say `--micro` is a size and not a grade so it stops being counted as one. This is a record fix, not a CSS fix.

### 8. DESIGN.md and this sweep's own preamble both report a defect that was fixed

- **Severity:** minor
- **Where:** `DESIGN.md:141-142` and `docs/design-sweep/PREAMBLE.md:103-106` against `src/app/globals.css:1358`
- **Cost:** Eleven reviewers in this sweep were briefed to treat `.st`'s missing `font-weight` as a known open bug. `.st` declares `font-weight: 600` at line 1358, and `.st--lead` at 1414-1417 already annotates itself as "redundant with `.st`'s own 600 now."
- **Principle:** none. The record's value is that it is true.
- **Fix:** Delete the parenthetical at `DESIGN.md:141-142` and replace it with the positive statement: `.btn`, `.tier` and `.st` all declare weight 600 themselves, which is why they can stay out of the shared register list. That is now the stronger version of the rule.

### 9. Two docblocks defend the sign-out hairline with a premise the CSS contradicts

- **Severity:** minor
- **Where:** `src/app/_components/ui.tsx:159-162` and `src/app/globals.css:392-394`
- **Cost:** The next person to touch the header reads "same size, same case, same colour as the four destinations beside it" twice and trusts it, so the drift it describes as impossible goes unnoticed for another pass.
- **Principle:** none. The claim is simply half false, and the codebase's comments are load-bearing enough that a false one is a real cost.
- **Fix:** Size and case do match (both 0.6875rem, both uppercase). Colour does not: `.shell__nav a` is `--ink-dim` (416) and `.btn--quiet` is `--ink-faint` (1624). Tracking does not: `--track-label` 0.12em (415) against `.btn--micro`'s `--track-value` 0.08em (1775). And on hover the button grows a `--rule-strong` border (1631) that the nav links never do, which already distinguishes it more loudly than the hairline. Either correct the comments to "same size and case, one step dimmer, with a border on hover," or make the claim true by giving the sign-out button `--ink-dim` and `--track-label` — the second is better, because sign-out is currently the faintest control in the bar and it is the only one that ends the session.

## What is good and must survive

- **`viewport.themeColor` and `--void` agree exactly.** `oklch(0.17 0.035 264)` converts to rgb(7.64, 14.83, 30.60), which rounds to `#080f1f`. I checked this by hand because it is the one place in the app where a palette token is duplicated as a literal with no comment tying the two together (`layout.tsx:52`). It is correct today. If the ground is ever retuned, this is the line that will silently disagree; a comment naming `--void` would cost nothing.
- **`Status`'s unbound `tone` and `children`.** The docblock's argument (`ui.tsx:205-219`) is confirmed by the call sites: across 57 of them, `ok` alone backs `ok`, `paid`, `finalized`, `valid`, `on` and a computed `3/5 paid`, and five sites pass a tone computed from an enum whose label is that same row's raw status string. Binding these into a `{tone, label}` pair would force every domain through a lookup table. The stance pays for itself. (The docblock says 56; there are 57. Not worth changing on its own, but do not restate the number when editing.) Finding 3 asks only for a comment defining the tones, which is compatible with keeping them unbound.
- **The skip link is wired all the way through.** `SiteHeader` hard-codes `href="#main"` (`ui.tsx:104`) and all ten pages that render it carry `id="main"`. A page added later that forgets it breaks this silently; there is no test for it.
- **Every `RuleHead` passes `as`.** All 17 call sites pass `h2` or `h3`, so the heading outline is intact on every route. The `as = "span"` default (`ui.tsx:188`) is therefore dead code — and it is the unsafe default. Changing it to require `as` would make the guarantee structural at zero cost.
- **The spacing scale is used as rhythm.** Counted across `globals.css`: `--s-1` 13, `--s-2` 37, `--s-3` 38, `--s-4` 33, `--s-5` 18, `--s-6` 13, `--s-7` 5, `--s-8` 2, `--s-9` 1. That is a healthy taper with no single step dominating, and every one of the nine is in use. No padding value has taken over. This is the part of the system that has drifted least; a fix pass tempted to "normalise" spacing should leave it entirely alone.
- **The label register holds.** Twelve selectors in the shared list (`globals.css:268-284`), one declaration of family, size, weight and case. Six mono-uppercase rules sit deliberately outside it (`.page__stamp`, `.shell__wordmark span`, `.btn-row__stamp`, `.launch__motto`, `.worker`, `.push__next`) and each carries a docblock arguing it holds a value rather than names a field. I checked all six; the argument is right in all six. The register is not the place drift is happening — size is (finding 6).
- **`.shell__nav a[aria-current]`** (`globals.css:459`) is already the widened bare-attribute selector the `SiteHeader` docblock at `ui.tsx:42-44` asks for, so the gold hairline survives the `page`/`true` token switch on `/payouts/new` and `/payouts/[id]`. That comment reads as an outstanding request; it is done.

## Could not evaluate

- Whether the `&&`-guarded notices in finding 1 actually go unannounced in practice. That depends on how each AT treats a `role="alert"` node inserted during a React reconciliation rather than at document load, and the repo has no jsdom, so it is a Playwright-plus-real-screen-reader question. The codebase already asserts the answer in two places (`ui.tsx:250-256`, `note-form.tsx:62-75`) and I have taken it as given; the fix is cheap enough that it is worth making regardless.
- Rendered heights in the header. `.shell__nav a` takes `--s-2`/`--s-3` padding on an 11px label with `body`'s 1.55 line-height, which computes to roughly 33px against the sign-out button's 28px `min-height`, but line-height on a mono label inside a flex row is not something I will assert from source. If it is 33px, DESIGN.md:231's "two sizes and no others" has a third. A screenshot settles it; screenshots are out of scope for this sweep.
- The three media queries (66rem, 46rem, 40rem) are the whole responsive story in 3,331 lines. Whether that is admirable restraint or a gap depends on what the admin tables do between 40rem and 66rem, which is the audit and accounts reviewers' surface, not mine.

## Contested

Nothing. The settled list held up everywhere I tested it, including the two items I expected to argue with: `.btn--quiet`'s join to the 28px grade is well reasoned at `globals.css:1615-1620` (30px was "a third size nobody had committed to"), and the fixed `--measure-page` on the shell bar is the third position on that question rather than the first, with the reversal history written out at `ui.tsx:50-69`. Finding 9 disputes a comment about the sign-out control, not the settled decision behind it.

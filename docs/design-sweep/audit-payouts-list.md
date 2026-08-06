# audit — /payouts and /payouts/new

Register: product. Read in full: `src/app/payouts/page.tsx`, `src/app/payouts/new/page.tsx`,
`payouts/actions.ts`, `payouts/errors.ts`, `payouts/access.ts`, `payouts/pending-link.tsx`,
`_components/{ui,scroller,submit,submit-guard,format-isk}`, `services/payout-view.ts`,
the `.log--payouts` / `.pager` / `.form-panel` / `.form-stack` / `.field` / `.st` / `.dim` /
`.notice*` / label-register / media-query regions of `globals.css`, `e2e/payouts.spec.ts`,
and `DESIGN.md` / `PRODUCT.md`.

## Findings

### 1. `max` on the date field is the only guard against a future date, and nothing stands behind it

- **Severity:** serious
- **Where:** `src/app/payouts/new/page.tsx:115`; `src/app/payouts/actions.ts:133-156`;
  `src/app/payouts/errors.ts:29-32`; `src/services/payout-view.ts:111`
- **Cost:** An operator who fat-fingers the year records an operation dated 2027; nothing
  refuses it, and because the list sorts `desc(occurredAt), desc(id)` it sits at the top
  of page 1 of every member's Payouts list until somebody finds the date editor on the
  detail page.
- **Principle:** The repo states the rule itself, in `e2e/payouts.spec.ts:622-629`
  (`bypassClientGuard`): "the server-side check standing behind them can only be reached
  by going around them… Without this, the server checks look covered and are not."
  `bypassClientGuard` strips `max` by name. Every other client guard on this flow has a
  server twin (`name` → `name_required`, date parse → `date_invalid`, shares → four
  checks, price → `price_invalid`). `max` is the one that does not.
- **Fix:** Add a `date_future` code to `NEW_OPERATION_ERRORS` and the matching check in
  `createOperationAction` after the NaN test; add the same code and check to
  `setOccurredAtAction` / `OPERATION_ERRORS`, since the detail-page editor has the same
  gap. The map entries are static strings that `lookupErrorMessage` reads verbatim, so
  the date cannot live in them — an entry reading "…today is `<date>`" ships that
  placeholder to the operator literally. Keep the map to the static half ("An operation
  cannot be dated in the future. EVE time is UTC.") and let the surface that renders the
  rejection append the day, from the same server-computed UTC date it already uses for
  `max` — the client's own clock is the wrong source here, since the whole point of the
  message is which day the *server* thinks it is.
- **And the `max` guard itself goes stale.** `today` is computed once, when the page
  renders, so a form left open across UTC midnight carries yesterday's `max` and the
  browser now blocks a submit dated today — the valid case. Either recompute it at
  validation time, or drop the native `max` and let the server check be the only guard.
  Either way the server-side `date_future` rejection is what has to hold, rendered as a
  persistent field error rather than a bubble that vanishes on the next keystroke.

Two sub-cases the same fix covers, both currently unaddressed:

- **Without sight, the refusal is a native validation bubble and nothing else.** The
  label reads "Date (required)" — there is no hint anywhere on the page saying operations
  cannot be dated forward. A screen-reader operator arrowing the date spinner to next
  month presses Create, `useSubmitGuard` correctly declines to latch
  (`submit-guard.ts:66`), the browser blocks the submit, and the entire feedback is a
  transient UA bubble that vanishes on the next keystroke. Nothing persistent renders.
  A `<span className="hint">` inside `.form-stack__field` (the slot its docblock at
  `globals.css:1909-1912` already describes) wired with `aria-describedby` would say the
  constraint before it is hit.
- **`today` is computed server-side in UTC at render** (`new/page.tsx:57`). A form left
  open across UTC midnight carries a `max` one day stale and refuses tonight's real date
  with a bubble that states a number, not a reason.

### 2. The same rejection twice in a row is announced to nobody, and a whitespace name makes that loop trivially reachable

- **Severity:** serious
- **Where:** `src/app/_components/ui.tsx:267-292`; `src/app/payouts/new/page.tsx:85`;
  `src/app/payouts/actions.ts:124-131`
- **Cost:** An operator who types spaces into Name gets a form that looks empty, an error
  saying it needs a name, presses Create again, and receives a pixel-identical page and —
  for a screen-reader user — total silence; the only escape is to guess that the visibly
  empty box is not empty.
- **Principle:** none (WCAG 4.1.3 is arguably satisfied on the first announcement).
- **Fix:** Two parts, both small.
  - `createFailed` echoes the raw field, so `" "` round-trips: `params.set(key, value)`
    at `actions.ts:128` receives the untrimmed string, `" "` is truthy, and `required`
    on the input is satisfied by a space. Trim before echoing (`const value =
    field(formData, key).trim()`), so a whitespace-only name comes back genuinely empty
    and the browser's own `required` catches the second press — which is where that
    rejection belongs.
  - Make a repeated identical message re-announce. `Notice` renders the same string into
    the same `<p role="alert">`, React commits no mutation, and no alert fires. The
    cheapest correct fix is a nonce the server already has: give `Notice` an optional
    `key`-bearing inner span, or have `createFailed` append an attempt counter to the
    query string so the rendered text differs. Worth doing in the primitive, not the call
    site — `Notice`'s own docblock makes exactly this argument about `&&` for the same
    reason ("AT announces a *change* to a region far more reliably than a region born
    holding text"), and it is one step short of the case where the region exists, is
    populated, and still says nothing.

The docblock's headline claim does hold on the *first* rejection: the mounted-empty slot
is the right shape, the `<p>` is reconciled in place across the soft navigation, and
`e2e/payouts.spec.ts:660-663` confirms Next's route announcer fires too. The gap is only
the repeat — and the repeat is the case a two-field form with a whitespace trap produces.

Related, and covered by the same pass: neither input takes `aria-invalid`, and the notice
is not `aria-describedby`-linked to the field it names. On two fields whose message text
names the field, that is survivable, so it is a fix to fold in rather than its own finding.

### 3. The five-column list has no pinned first column and no narrow tuning, so at 320px the operation name is off screen when you read Paid

- **Severity:** serious
- **Where:** `src/app/payouts/page.tsx:106-107`; `globals.css:894-905` (the only
  `.log--payouts` rules in the file); `globals.css:3126+` (the 40rem block, which names
  `.log--audit` and `.log--runs` and not this table)
- **Cost:** A member checking on a phone whether their fleet has paid out scrolls right
  to the Paid column and can no longer see which operation the "3/8 PAID" belongs to.
- **Principle:** PRODUCT.md, "Zoom and reflow… Wide data tables scroll within their own
  region" — satisfied — but the codebase's own answer to the second half of that problem
  is `.log--sticky-col`, whose comment at `globals.css:3268-3272` states it exactly: "The
  name an admin is about to change the tier of stays on screen through the scroll right
  to the controls."
- **Fix:** Three changes, cheapest first.
  1. Move the unit out of the cells. Every row renders `` `${fmtIsk(...)} ISK` ``
     (`page.tsx:154`) inside a column already headed "Total". Four mono characters × 14px
     ≈ 34px of a ~286px region, spent on every row to restate the header. Header becomes
     `Total (ISK)`; cells carry the figure alone. The dash branch already omits it, so
     this also removes an inconsistency.
  2. Add `.log--payouts` to the 40rem block with `padding: var(--s-2) var(--s-3)`, the
     same trade `.log--runs` and `.log--audit` already take there.
  3. Add `log--sticky-col` to the table's class list. The rules are already written,
     already exclude `.log__empty` cells (`globals.css:1155`, `1171`), and already
     suppress the contradictory start fade (`globals.css:749`).
- **Note on rigour:** the pixel figures above are derived from the token values
  (`--t-data` 14px, `--t-label` 11px, `--s-3`/`--s-4`/`--s-5` padding, mono advance ~0.6em)
  and from the region width this file measures for itself at 320px (286px,
  `globals.css:3247`). I could not run a browser. The direction is not in doubt — the four
  nowrap columns alone sum to roughly twice the region — but the exact overflow figure
  should be measured before the fix is tuned.

### 4. The pager's two links have no purpose in a link list

- **Severity:** moderate
- **Where:** `src/app/payouts/page.tsx:237-248`
- **Cost:** A screen-reader user pulling up the links on `/payouts` hears "Latest" and
  "Older" — two bare directions with nothing said about what they page through, on a page
  whose other fifty links are all operation names.
- **Principle:** WCAG 2.4.4. The audit page's `Pager` docblock states this decision
  verbatim (`src/app/admin/audit/page.tsx:182-185`): "'Older' alone is not a link purpose
  once the arrow is `aria-hidden`… a screen reader listing links off this page would
  otherwise get two bare directions." It carries `<span className="visually-hidden">
  entries</span>` on both halves. `/payouts` has the same shape, the same `aria-hidden`
  arrows, and no qualifier.
- **Fix:** ` operations` in a `.visually-hidden` span on both anchors, matching the audit
  pager's placement (inside the label, before the arrow on Older).

### 5. The only pager is below fifty rows

- **Severity:** moderate
- **Where:** `src/app/payouts/page.tsx:227-250`; `PAYOUTS_PAGE_SIZE = 50`
  (`services/payout-view.ts:25`)
- **Cost:** A keyboard operator walking back through payout history tabs through the
  Scroller stop and all fifty operation-name links before reaching `Older →`, once per
  page, in both directions.
- **Principle:** Same file, same decision, already made: `admin/audit/page.tsx:529-531` —
  "The bottom pager is roughly 300 tab stops past the top of a full page, so on a keyboard
  the only way to reach the next page was to traverse every link in every row." The
  `.pager--top` class exists in `globals.css:2064` with its own spacing comment and has
  exactly one caller.
- **Fix:** Render the same pager block above `<Scroller>` with `pager pager--top`. Lift
  it to a local `Pager` component first so the two copies cannot drift the way the audit
  page's docblock warns.

### 6. Two data cells take `.dim`, which drops a type step inside the one column that must not have two of them

- **Severity:** minor
- **Where:** `src/app/payouts/page.tsx:149`, `:164`; `globals.css:1315-1328`
- **Cost:** In a right-aligned, tabular-nums Total column, a draft's placeholder renders
  at 13px between rows rendering at 14px, so the column the design tunes for alignment
  carries two sizes.
- **Principle:** `globals.css:1319-1327` diagnoses this exact case and names the fix:
  "`.dim` also drops a step of size, which is right for a standalone metadata line and
  wrong for a span inside a data cell that has to keep the mono column's advance width…
  The audit found several data cells reaching for `.dim` and getting a size change with
  it; this is the class they should take instead." `.dim-ink` is declared and, as the
  comment says, unreferenced — because the pass that wrote it did not own `.tsx`. These
  are two of the call sites it was written for.
- **Fix:** `className="dim-ink"` and `className="dim-ink mono"` on the two absent-value
  spans. The aside at `page.tsx:102` is a standalone metadata line and correctly keeps
  `.dim`.

### 7. Form field labels are the one label family outside the label register

- **Severity:** minor
- **Where:** `src/app/payouts/new/page.tsx:99`, `:108` (and eight more in
  `payouts/[id]/page.tsx` and `appraise-form.tsx`); `globals.css:268-284`, `1913-1916`
- **Cost:** An operator moving from the account page (whose `dt` labels are 11px mono
  caps) to this form meets the same job done in a different vocabulary — 15px cream sans,
  larger and louder than the "OPERATIONS" section header above it — so the form reads as
  prose with boxes rather than as the ruled form the rest of the app is.
- **Principle:** DESIGN.md's tracking table defines `--track-label` as "**Form** and table
  labels. The register's default." No rule in `globals.css` applies it to a form label;
  `.log th` covers the table half and nothing covers the form half. The register's own
  comment enumerates its deliberate exclusions with reasons (`.btn`, `.tier`, `.st`,
  `.push__next`, `.btn-row__stamp`, `.worker`) and does not mention form labels at all,
  which reads as an omission rather than a decision.
- **Fix:** Add `.form-stack__field > label`, or a `.form-stack__label` class, to the
  register list, with `letter-spacing: var(--track-label)` and `color: var(--ink-faint)`.
  Copy needs one pass with it: "NAME (REQUIRED)" in caps is worse than "NAME · REQUIRED"
  or moving the requiredness marker out of the label into the hint slot. If that copy
  problem is the actual reason these were left out, DESIGN.md should say so, the way it
  says so for every other exclusion.

## What is good and must survive

- **The absent-value pattern.** The `aria-hidden` dash plus a `.visually-hidden` phrase,
  with the comment explaining that `aria-label` is silently dropped on a bare span, is
  correct and non-obvious. A later "simplification" to `aria-label` would produce a cell
  that reads as an unexplained punctuation mark. Only the `.dim` → `.dim-ink` swap in
  finding 6 should touch these lines.
- **Status contrast, measured.** I computed all four tones through OKLCH → sRGB against
  `--void`, `--hull`, `--hull-hi`, and the actual hover ground
  (`color-mix(in oklab, --hull-hi 55%, transparent)` over `--void`): `ok` 9.42 / 8.40,
  `warn` 9.43 / 8.41, neutral `--ink-dim` 9.57 / 8.53, `off` `--ink-faint` 6.15 / 5.49
  (rest / hover). Every tone clears AA for 11px text on both grounds with large margin.
  The `--signal-warn` hue-50 comment's own figures (9.43 / 8.54 / 7.44 / 8.41) reproduce
  exactly. Nothing here needs touching, and a future palette tweak should re-run these.
- **`tabular-nums` on Total is genuinely applied**, twice over: `.log td` sets
  `font-variant-numeric: tabular-nums` (`globals.css:808`) for every cell, and `.mono`
  sets it again (`:1195`). Combined with `.num`'s right alignment and `fmtIsk`'s
  always-kept `.00`, the column aligns on the decimal. Do not "clean up" the apparent
  duplication — `.log td`'s copy is what covers the non-`.mono` cells.
- **The pager's two halves navigate the same way.** Both are plain `<a>`; the lint escape
  exists precisely so the half the rule *can* see does not become a soft nav while its
  partner (a template-literal href the rule cannot see) stays hard. The comment at
  `page.tsx:232-236` argues this correctly and the argument still holds. Findings 4 and 5
  add to this block; neither touches the navigation kind.
- **`Notice` mounted unconditionally, and `Submit` not disabled while pending.** Both are
  load-bearing and both look like dead code / a missing guard to a casual reader. Finding
  2 builds on the first rather than replacing it.
- **`pastEnd`.** A cursor past the end renders "Nothing older than this point" plus a way
  back instead of "No operations recorded yet". Easy to lose in a refactor of the empty
  state; it is the difference between a dead end and a page.
- **`.log__empty-text`'s sticky/`100vw` calc** keeps the empty message on screen at every
  scroll offset. It is already documented as fragile against `.page`'s gutter; finding 3's
  narrow-padding change does not touch `.page`, but re-check the 11px slack it names if
  anything else does.

## Could not evaluate

- **Exact overflow and forced-scroll figures at 320px and at 200% zoom.** No dev server
  (out of scope, and it rewrites `tsconfig.json` here). Finding 3's numbers are derived
  from tokens and from this file's own measured 286px region. A Playwright run measuring
  `scrollWidth`/`clientWidth` on `.scroller` at 320px, with realistic operation names and
  billion-ISK totals seeded, would settle both the size of the problem and the tuning of
  the fix. The two admin tables already have exactly this pinned in `e2e/`.
- **Whether the native date-validation bubble is announced** by the specific
  browser/AT combinations this corp actually uses. It is a known-weak surface, and finding
  1's fix makes the question moot rather than answering it — but if someone wants to argue
  the bubble is enough, that argument needs a real test, and it still leaves the
  no-server-check half of the finding standing.
- **Whether `.form-stack__field` labels were left out of the register deliberately.** The
  register comment justifies six exclusions by name and is silent on this one. If there
  was a reason, it is not in the source, and finding 7 may be arguing with a decision
  rather than an omission.

## Contested

Nothing on the settled list. Two notes rather than objections:

- The known open defect (`.st` at weight 400) is **already fixed** at this commit:
  `globals.css:1358` declares `font-weight: 600`, and the register comment at `:237-240`
  records the fix. DESIGN.md:141 still describes it as present. The doc is now the stale
  half.
- `fmtIsk` always keeping `.00` is right for the per-participant columns it also serves,
  and I am not proposing to change it. But in the Total column of *this* table, at
  operation scale, three characters per row are spent on cents nobody reads — and dropping
  them uniformly across the column would not ragged the decimal point, which is the
  specific harm the formatter's docblock argues against. If finding 3's width budget turns
  out tight after measurement, a column-scoped whole-ISK rendering is the next cheapest
  ~25px, and it does not require touching the shared formatter.

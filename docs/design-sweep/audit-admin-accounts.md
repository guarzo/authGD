# audit — /admin/accounts

Register: product. Read in full: `src/app/admin/accounts/page.tsx` (890),
`actions.ts`, `_components/{disclosure,confirm-submit,note-form,tier,scroller,submit,submit-guard,ui,admin-nav}.tsx`,
`services/admin-accounts.ts` (tier lock), `e2e/admin.spec.ts`, and the `.log`,
`.log--dense`, `.log--sticky-*`, `.scroller*`, `.drawer*`, `.row-toggle`,
`.filters`, `.st`, `.tier`, `.btn*`, `.field` rules in `globals.css`.
Contrast figures below are computed from the OKLCH tokens through sRGB
relative luminance, not eyeballed.

## Findings

### 1. Eight of the nine row actions destroy focus; the codebase already names this bug

- **Severity:** blocking
- **Where:** `src/app/admin/accounts/page.tsx:708-716`, `:719-732`, `:749-765`,
  `:534-543`, `:616-635`; rule stated at `src/app/_components/submit-guard.ts:9-13`
- **Cost:** An admin working the twentieth row of a two-hundred-row table presses
  a tier, cryo, unlink, grant or revoke control, and focus is thrown to `<body>`
  — their next Tab starts at the skip link, above the page head, and they have to
  walk the whole table back to the row whose drawer is still sitting open.
- **Principle:** WCAG 2.4.3 Focus Order / 3.2.2 On Input; `submit-guard.ts:9-13`
  ("disabling the element the member just pressed moves focus to `<body>`, and
  because every one of these actions ends in a … client navigation with no
  document load — there is nothing afterwards that puts it back")
- **Fix:** The page violates its own rule five different ways, all on the success
  path. Each needs the pressed element to survive its own action:
  - **Set tier** (`:710`): `disabled={r.tierLocked && r.tier === t}`.
    `setTierManual` sets `tierLocked: true` unconditionally
    (`services/admin-accounts.ts:43`), so *every* successful tier set disables the
    exact button that was just pressed. This is 100% of tier changes, not an edge
    case. Drop `disabled` here and keep `aria-pressed` as the whole signal — a
    pressed-and-current toggle already reads correctly, and re-pressing the
    current tier is a no-op the service short-circuits at `:40`.
  - **auto** (`:719`): rendered only under `{r.tierLocked && …}`, so pressing it
    unmounts it. Render it always and disable-by-omission differently: leave the
    control mounted and make it a no-op when `!r.tierLocked` — or accept the
    unmount but move focus explicitly to the tier group's first button.
  - **freeze/wake** (`:749`), **grant/revoke** (`:616`), **unlink** (`:534`): each
    is a ternary that swaps one component (and for grant/revoke, one whole
    `<form>`) for a different one at the same position, so React unmounts the
    focused button. Render one stable `<form>`/`<button>` per cell whose
    `action`, label and names are computed from `r.status` / `r.isAdmin` /
    `r.discordLinked`, instead of branching the element itself.

  `NoteForm`'s save is the only control on the page that keeps its element and
  therefore its focus. It is the model; the other eight should match it.

### 2. Eight of the nine row actions confirm nothing, and the two notices that exist are mounted in the shape their own component forbids

- **Severity:** serious
- **Where:** `src/app/admin/accounts/page.tsx:154`, `:156-158`; contract at
  `src/app/_components/ui.tsx:246-257`
- **Cost:** An admin who presses "Approve as Alumni" gets a row that silently
  vanishes from the `?tier=pending` queue and no statement anywhere of who was
  approved or at what tier; a screen-reader admin who presses a tier button gets
  no announcement at all, on top of losing focus, so the press is indistinguishable
  from a dead click.
- **Principle:** WCAG 4.1.3 Status Messages; `ui.tsx:246-252` — "The `&&` form is
  the one shape that defeats the live region it just asked for: it inserts a
  `role="alert"` node with its text already inside it, and AT announces a *change*
  to a region far more reliably than a region born holding text."
- **Fix:** Two separate gaps.
  - Both `Notice` call sites on this page use exactly the `&&` mount the
    component's docblock was written to stop: `{errorMessage && <Notice tone="bad">…}`
    and `{params.queued === "account" && <Notice>…}`. Both arrive by
    `redirect()` from a server action, which is a soft navigation into an existing
    document — precisely the case the empty-slot mode exists for. Change to
    `<Notice tone="bad">{errorMessage}</Notice>` and
    `<Notice>{params.queued === "account" ? "Sync queued. …" : ""}</Notice>`, which
    is what `admin/sync` already does. The four race redirects (`not_admin`,
    `not_found`, `not_pending`, `last_admin`) are currently announced to nobody
    and painted at the top of a page the admin is scrolled two thousand pixels
    down.
  - Add one always-mounted `role="status"` region per row (or one per table, in
    `ConfirmArmScope`'s parent) that the tier / cryo / unlink / admin actions
    write to: "Zed set to Veterans", "Zed frozen", "Discord unlinked for Zed".
    `NoteForm`'s `.note-form__saved` span is the exact pattern and is already
    argued for at `note-form.tsx:62-78`; it should not be the only one.

### 3. The three tier buttons show nothing at all while in flight, and a second press hits a different button the guard cannot see

- **Severity:** serious
- **Where:** `src/app/admin/accounts/page.tsx:696-716`
- **Cost:** An admin on a slow link presses "Associate", sees the button not
  change in any way, presses "Alumni" 400ms later, and lands two `tier.set`
  writes and two audit entries on one account with last-write-wins deciding the
  outcome — the one control on this page where "derole, don't boot" says a wrong
  result matters most.
- **Principle:** PRODUCT.md principle 1 (state before action) / DESIGN.md's
  in-flight contract: `aria-busy` plus a swapped `pendingLabel` is the whole
  in-flight signal, and this control opts out of half of it.
- **Fix:** The docblock at `:696-702` correctly refuses `pendingLabel="setting…"`
  — erasing which of three tiers was pressed at the moment the admin is checking
  is worse. But it then claims "`disabled` plus `aria-busy` still report the
  in-flight state", and that is not true of this call site: the `disabled` here is
  `r.tierLocked && r.tier === t`, a state fact, not an in-flight one, so nothing
  visible changes between press and response. Keep the tier word and add a mark:
  `pendingLabel={<>{tierLabel(t)}<span aria-hidden="true"> ·</span></>}`. The
  accessible name is the explicit `aria-label` either way, so 2.5.3 is unaffected.
  Separately, `useSubmitGuard` is per-button and each tier sits in its own
  `<form>`, so it cannot stop the cross-button double-fire; a shared busy flag on
  the `.btn-group` (or `aria-disabled` on the siblings while one is pending —
  not `disabled`, see finding 1) is what closes that.

### 4. "sync now" is the one action that navigates, and it throws away the region's scroll position

- **Severity:** serious
- **Where:** `src/app/admin/accounts/page.tsx:636-644`;
  `src/app/admin/accounts/actions.ts:168-185`
- **Cost:** An admin who has scrolled to row 140 and pressed "sync now" is
  returned to the top of the table region with the row they were working no
  longer on screen, for the only action on the page that changes nothing about
  the row it was pressed on.
- **Principle:** none — this is a consistency defect. Every other mutation here
  ends in `revalidatePath` alone and leaves the reader exactly where they were;
  this one alone ends in `redirect()`.
- **Fix:** `syncAccountAction` redirects purely to set `?queued=account` so the
  page can render a confirmation banner. That banner is the wrong mechanism for a
  per-row action anyway (see finding 2 — the row is the thing that queued a sync,
  and the notice is 1500px away from it). Return the same shape `saveNoteAction`
  returns: a `useActionState` counter the row renders as a `role="status"`
  "· queued" beside the button, drop the `redirect()` and the `queued` search
  param, and the action becomes indistinguishable from the other eight.

  Also worth settling before this lands: whether the current `redirect()`'s
  same-route search-param navigation preserves `Disclosure`'s React `open` state.
  If it does not, every open drawer on the page closes on this one press. See
  "Could not evaluate".

### 5. At 200% zoom the table becomes a 288px porthole nested inside a page that also scrolls

- **Severity:** serious
- **Where:** `src/app/globals.css:1057-1060` (`.scroller--tall:has(.log--dense)`),
  reasoning at `:1032-1056`
- **Cost:** An admin at 200% browser zoom on a 1280×800 display sees roughly five
  member rows at a time through a fixed 288px window that itself starts below the
  fold, and has to work two nested scrollbars — the page's and the region's — to
  scan a list, on the surface PRODUCT.md principle 3 says is read far more than it
  is operated.
- **Principle:** WCAG 1.4.4 Resize Text (content remains usable); PRODUCT.md
  principle 3
- **Fix:** The formula is `min(80svh, max(18rem, 100svh - 29rem))`. At 200% zoom
  the viewport is 400 CSS px tall, so `100svh - 29rem` goes negative and the
  `18rem` floor takes over — 288px. The docblock at `:1050-1056` knows about the
  floor and argues "there the page is a long vertical scroll anyway, so tightening
  a nested scroll region past this point buys nothing and costs reach". That
  argument is right and the code does the opposite of what it concludes: it keeps
  a 288px cap on a page that is already scrolling, producing exactly the two
  scrollbars the open-drawer rule at `:1088` removes for the same reason. Drop the
  cap when the chrome no longer fits — `@media (max-height: 44rem) {
  .scroller--tall:has(.log--dense) { max-height: none } }`, mirroring the
  open-drawer rule's own conclusion that "the page's own scrollbar is the better
  one, because there is only ever one of it". The sticky header loses its travel
  there, which is the accepted cost and is already accepted when a drawer is open.

### 6. A screen-reader admin cannot tell which four of the ten columns sort, or which way a press will take them

- **Severity:** moderate
- **Where:** `src/app/admin/accounts/page.tsx:241-275`
- **Cost:** An admin using a screen reader tabs the header row, hears "Name,
  link", "Tier, link", "Cryo, link", "Tier changed, link", and has to press one
  and listen to the whole table re-read to discover what any of them does or
  which direction it just applied.
- **Principle:** WCAG 2.4.6 Headings and Labels / 4.1.2 Name, Role, Value
- **Fix:** The docblock at `:249-257` makes two claims. The first — that the `↕`
  is a real affordance for sighted keyboard and touch users — is correct and the
  glyph should stay. The second — "aria-sort on the header already carries the
  state" — holds only in table-reading mode, where a screen reader enters the
  column and hears the `th`. It does not reach the tab order, which is how the
  control is actually operated, and `aria-sort` never carried the *affordance* or
  what the next press will do. Give the anchor an `aria-label` that leads with the
  visible label so it stays a 2.5.3 match and names the destination state:
  `` aria-label={`${s.label}, sort ${nextDir === "asc" ? "ascending" : "descending"}`} ``
  where `nextDir` is the value already computed for the href at `:260-261`. Keep
  both glyphs `aria-hidden` and keep `aria-sort` — this adds the missing half, it
  does not replace what is there.

### 7. Tabbing to the crew table's nested Scroller parks it under the sticky header

- **Severity:** moderate
- **Where:** `src/app/globals.css:1126-1128`; region created at
  `src/app/admin/accounts/page.tsx:819`
- **Cost:** At narrow width or high zoom — where the 4-column crew table is
  372.5px inside a 262px drawer and so earns its tab stop — a keyboard admin tabs
  into an open row's crew region and the focus ring is drawn underneath the
  34px sticky header, invisible.
- **Principle:** WCAG 2.2 2.4.11 Focus Not Obscured
- **Fix:** `.log--sticky-head :is(a, button, summary, input, .row-toggle)` is the
  rule written for exactly this failure, and it enumerates element types. The
  nested `Scroller` is a `div` with `tabIndex={0}` (`scroller.tsx:93`) and matches
  none of them, so it is the one focusable in this table the rule misses. Add
  `.scroller` to the `:is()` list, or widen it to include `[tabindex]`. Same 3rem
  figure; the same `scroll-margin-top`-on-the-target argument in the docblock
  applies unchanged.

### 8. The whole per-row control surface is unreachable before hydration, with nothing saying so

- **Severity:** moderate
- **Where:** `src/app/_components/disclosure.tsx:82-137`
- **Cost:** An admin on a slow connection clicks a row toggle and gets nothing —
  no open, no marker change, no error — because in `as="row"` mode the toggle is a
  plain `<button>` with a React `onClick` and no native behaviour to fall back on,
  and every tier, cryo, note, unlink and history control on the page lives behind
  it.
- **Principle:** none — this is a degradation gap, not a criterion
- **Fix:** The tradeoff itself is forced and correctly documented (`:20-27`: a
  `<details>` cannot hold a `<tr>`), and the `everOpen` latch at `:104-128` is a
  sound performance call. But it makes `/admin/accounts` the one page in the app
  where the disclosure pattern's stated benefits — works with no JavaScript,
  find-in-page reaches collapsed text — are both false, and nothing on the page
  or in the settled record says so. Two cheap mitigations: mark the toggle
  `aria-disabled` / visually pending until mount so a pre-hydration press is not
  silent, and record in DESIGN.md that the row shape trades both properties away,
  so a future reviewer does not read the `Disclosure` docblock and assume this
  page inherits them.

### 9. The sort control is a 17px target inside a 41px cell

- **Severity:** minor
- **Where:** `src/app/globals.css:759-773`
- **Cost:** An admin aiming at the "Tier changed" header clicks the visible cell
  a few pixels above the word and nothing happens; the padding that makes the
  header look like a control belongs to the `th`, not to the link inside it.
- **Principle:** none — WCAG 2.5.8 is met via the spacing exception (nearest
  adjacent target is ~43px centre-to-centre); this is a Fitts cost, not a failure
- **Fix:** `display: block` on `.log th a` and move `.log th`'s `padding: var(--s-3)
  var(--s-4)` onto the link, so the hit area is the cell an admin is already
  aiming at. Six of the ten headers are not links and keep the padding on the
  `th`; scope the move to `.log th:has(a)`.

## What is good and must survive

- **The contrast work is genuinely finished, and a "simplification" would undo
  it.** Computed from the tokens: `.st--bad` 6.09:1 on `--void` / 5.43:1 on a
  hovered row; `.st--off` (`--ink-faint`, the most common token in the table —
  active, none, off, member) 6.15 / 5.49; `.st--ok` 9.42 / 8.40; `.st--warn`
  9.43 / 8.41. Tier badge text on its own 14% tint: member 8.74 / 7.52,
  associate 6.32 / 5.46, alumni 7.44 / 6.41, pending and unknown 7.53 / 6.48.
  Every one clears AA on both grounds with margin, at 11px. The `--ink-dim`
  choice for `.tier--pending` / `.tier--unknown` (`globals.css:1466-1485`) is the
  narrowest of these at 5.46–6.48 and was measured deliberately; reverting it to
  `--ink-faint` drops the unknown badge to 3.94:1 on hover, which is what the
  docblock says and what my numbers confirm.
- **`.st` now carries an explicit `font-weight: 600`** (`globals.css:1358`). The
  preamble lists the missing weight as a known open defect; at commit `e5d76df`
  it is fixed. Do not let a later pass "restore" the inherited 400.
- **`tokenState()` returning `{tone, mainDead}` as one pair** (`page.tsx:344-364`).
  The "main dead" line is the only thing distinguishing two byte-identical `4/5
  ok` cells, and splitting the derivation into two functions is exactly what would
  let them disagree.
- **`NoteForm`'s `role="status"` confirmation** (`note-form.tsx:76-78`) and its
  `dirty`/`seen` counter. It is the only honest feedback on the page; it is also
  the template findings 2 and 4 should be fixed against. The e2e test at
  `admin.spec.ts:294-347` pins the repeat-save case; keep it.
- **The `.visually-hidden` Discord unlink cost sentence** (`page.tsx:572-578`) and
  the argument for it at `confirm-submit.tsx:89-98`. Settled, correct, and my
  reading of `.discord-cell`'s `flex-wrap` confirms the reflow mechanism.
- **The pinned first column plus `scroll-margin-top: 3rem`** (`globals.css:1099-1128`,
  `:1155-1189`). A 28px control that changes someone's tier with nothing on screen
  saying whose is the failure "derole, don't boot" is built to prevent, and both
  rules are load-bearing for it. Finding 7 widens the second rule; it does not
  question it.
- **`listSearch` threaded into every mutation** (`page.tsx:141`, `actions.ts:47-56`).
  A race redirect rebuilds the filtered, sorted view the admin was actually
  scanning. This is the single best thing about the page's error handling and it
  is easy to drop by accident when refactoring the action signatures.

## Could not evaluate

- **Whether `Disclosure`'s `open` state survives `syncAccountAction`'s
  `redirect()`.** `revalidatePath` alone provably preserves it —
  `e2e/admin.spec.ts:265-288` and `:294-347` assert it directly. The redirect path
  is a same-route, different-searchParams soft navigation, and whether Next 15
  remounts the page segment there is not answerable from source. Settled by one
  Playwright assertion: open two drawers, press "sync now" on a third row, assert
  both drawers still visible.
- **Where focus actually lands after each action in a real browser.** The
  mechanism in finding 1 is certain from the code (a disabled or unmounted focused
  element blurs to `<body>`, and `submit-guard.ts` states it as established
  behaviour in this codebase), but no test in `e2e/admin.spec.ts` asserts focus
  after any mutation, and the repo has no jsdom. Nine `expect(x).toBeFocused()`
  assertions after nine actions would both confirm the finding and lock the fix.
- **The real height of the chrome above the table region at 200% zoom.** Finding 5
  is derived from the CSS formula and the measurements recorded in the docblock at
  `globals.css:1043-1056`, not from a rendered page. The 288px floor is arithmetic
  and certain; how far below the fold the region starts is not.
- **Whether `.st` at `--t-label` (11px) with `--track-value` is comfortable at
  the far end of a ten-column table.** Contrast passes everywhere; legibility at
  that size in mono uppercase is a judgement a screenshot would settle and source
  cannot.

## Contested

Nothing on the settled list. One note rather than a challenge: the settled entry
"Buttons are **not** disabled while a submit is in flight … Proposing `disabled`
here is proposing to lose focus" is stated as an in-flight rule, and the page
loses focus the same way through *state*-driven `disabled` and through unmounting
the pressed control (finding 1). The rule as written does not cover either case,
so a future reviewer can read the settled list, check that no button is disabled
while pending, and conclude the page is clean. Worth widening the entry to "the
control the admin pressed must still exist and still be focusable after the action
resolves."

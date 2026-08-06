# audit — /payouts/[id]

## Findings

### 1. Any rejected inline edit throws the operator to the top of the page, closes every panel, and eats what they typed

- **Severity:** blocking
- **Where:** `src/app/payouts/actions.ts:105-109` (`operationFailed`), consumed by
  `setItemPriceAction:262-278`, `setParticipantSharesAction:321-355`,
  `setNameAction:368-377`, `addParticipantAction:303-318`,
  `addFlatPoolAction:230-251`, `openInfoAction:579-630`;
  `src/app/payouts/[id]/page.tsx:665-748` (the pool-item disclosures),
  `src/app/_components/disclosure.tsx:61` (open state is `useState`)
- **Cost:** An operator repricing item 180 of a 200-item pool who types `0.004`
  (three decimals, refused by design) is navigated to `?error=price_invalid`,
  which scrolls to the top of the page, closes the pool disclosure they were
  working in, re-renders the input at its old `defaultValue` so the number they
  typed is gone, and drops focus on `<body>` — and they have to scroll back down,
  reopen the pool, and find row 180 again to make a one-character correction.
- **Principle:** none for the value loss; WCAG 2.4.3 for the focus, and
  `ClearStaleQuery`'s own docblock (`clear-stale-query.tsx:33-40`) states the
  remount and the scroll jump as established facts — it passes `{ scroll: false }`
  precisely because "clearing a query string should not jump the page to the top",
  and it uses `router.replace` precisely because "a route transition remounts it,
  silently closing whatever loot-pool or roster panel the operator had open".
- **Fix:** The code already knows the answer and applies it in exactly one place:
  `AppraiseForm` uses `useActionState` so "nothing ever replaced the DOM it is
  sitting in" (`appraise-form.tsx:9-20`). The `?error=` redirect is the right
  channel for a failure that arrives on page load, and the wrong one for a
  rejection of a control that is 2,000px down a page full of open panels. Convert
  the four field-level editors that reject on format — `setItemPriceAction`,
  `setParticipantSharesAction`, `addFlatPoolAction`'s `total_invalid`, and
  `addParticipantAction` — to return state through `useActionState` from a small
  client leaf, the way `AppraiseForm` and `NoteForm` already do, and render the
  message beside the field that produced it. `openInfoAction`'s five failure codes
  are the harder case (they can't be predicted client-side); at minimum they should
  not navigate, since the action persists nothing by its own docblock's argument.
  Keep the redirect only for failures that genuinely have no form still on screen.

### 2. Focus is destroyed on every control that removes itself — mark paid, finalize, unlock, remove, delete pool

- **Severity:** serious
- **Where:** `src/app/payouts/[id]/page.tsx:1002-1038` (mark paid → revert swap),
  `1119-1137` (Finalize/Unlock swap), `1055-1072` (remove), `554-573` (delete pool);
  `src/app/_components/submit-guard.ts:9-15` and
  `src/app/_components/focus-heading.tsx:12-16` both describe this exact failure
- **Cost:** An operator paying out a 60-name roster by keyboard presses "mark
  paid", the button unmounts and is replaced by "revert" in a different `<form>`,
  focus falls to `<body>`, and their next Tab restarts at the skip link at the top
  of a page with 60 rows and several hundred controls on it — sixty times.
- **Principle:** WCAG 2.4.3 Focus Order.
- **Fix:** The page already has both halves of the answer in the repo.
  `submit-guard.ts` was written specifically so that a submit does *not* destroy
  focus ("the button keeps `aria-busy`, keeps focus"), and `FocusHeading` is the
  established pattern for "the thing that was pressed is the thing that unmounts".
  For the row controls, the cheapest correct fix is to keep the pressed element
  mounted across the state change: render one form per row whose action and label
  switch on `paymentState` (mark paid ↔ revert) rather than two mutually exclusive
  forms, so React reconciles the same `<button>` and focus is never lost. Finalize
  and Unlock are the same shape in the same `btn-row`. `remove` and `delete pool`
  genuinely destroy their row and need the other half: move focus to a stable
  neighbour (the section's `RuleHead`, given `tabIndex={-1}`) after the row goes.

### 3. The five page-level disclosures — the page's primary structural device — carry no styling at all

- **Severity:** serious
- **Where:** `src/app/payouts/[id]/page.tsx:370`, `469`, `484`, `668`, `775`;
  `src/app/globals.css` has rules for `.log summary` (2340), `.json > summary`
  (2380) and `.strip__disc > summary` (2457, 2617) and **no** rule for a bare
  `details`/`summary`. `* { margin: 0 }` (globals.css:105) applies.
- **Cost:** An operator opening "Edit details" or "Pool 3 items" is clicking a
  browser-default black triangle in proportional body text, flush against the
  facts grid above it with zero space, in a system where every other disclosure in
  the app renders a mono `+`/`−` marker at a 28px target with a gold hover — so
  the one page where disclosures carry the whole workflow is the one page where
  they don't look like controls, and three consecutive "Pool N items" rows read as
  a solid block of body text rather than three things you can open.
- **Principle:** DESIGN.md, "Radii are near-zero… this is documentation, not
  software chrome" and the `+`/`−` marker vocabulary; impeccable product register's
  ban on "inconsistent component vocabulary across screens — if the save button
  looks different in two places, one is wrong". Also WCAG 2.5.8: the unstyled
  summary is a `--t-body` line box at 1.55, ~23px, under the 24px floor
  `.json > summary` and `.row-toggle` both take explicit min-heights to clear.
- **Fix:** `/admin/sync` passes `className="strip__disc"` and gets the full
  treatment; these five pass nothing. Add a base rule for the component's default
  shape — the marker, `cursor: pointer`, `list-style: none`, the `:hover` gold, a
  `min-height: 1.75rem`, and a `margin` block so consecutive disclosures and the
  content panel inside one are separated on the spacing scale. Put it on the
  `Disclosure` component's own default class rather than on bare `details`, so
  `.json` and `.strip__disc` keep their overrides.

### 4. The roster inherits the accounts table's chrome-subtracted height cap, whose premise is false here — at 200% zoom it becomes a nine-row porthole

- **Severity:** serious
- **Where:** `src/app/payouts/[id]/page.tsx:873-874` (`log--dense` +
  `tall={participants.length > ROSTER_TALL_THRESHOLD}`) meeting
  `src/app/globals.css:1057-1060`
  (`.scroller--tall:has(.log--dense) { max-height: min(80svh, max(18rem, 100svh - 29rem)) }`)
- **Cost:** An operator working a 200-name roster at 200% zoom on a 1080px monitor
  reads it through a 288px window — about nine rows — while the page around it
  scrolls independently, so they are scrolling two things at once to cross a list
  they could have read straight down.
- **Principle:** none cleanly (the region scrolls, so 1.4.10 Reflow is arguably
  met); the cost is the whole of it. But the CSS rule states its own scope in as
  many words: "The accounts table only… this narrows to the one table carrying
  `.log--dense`." The roster now carries `.log--dense` too, so the narrowing no
  longer selects what it says it selects.
- **Fix:** The `- 29rem` term is a measurement of `/admin/accounts`' chrome, taken
  so that region ends inside the viewport. On this page the roster sits below the
  facts grid, four disclosures, a loot table and up to four notices — it is never
  near the top, the operator has already scrolled to reach it, and subtracting
  464px buys nothing while costing 464px of reach. The rule's own comment already
  concedes this shape ("there the page is a long vertical scroll anyway, so
  tightening a nested scroll region past this point buys nothing and costs
  reach"). Re-narrow the selector to the accounts table specifically (a
  `.log--accounts` class, or `:has(tr.drawer-row)`), leaving the roster on the
  plain `.scroller--tall` 80svh bound.

### 5. Every notice on the page is `&&`-mounted, which defeats the live region the primitive was built to guarantee

- **Severity:** moderate
- **Where:** `src/app/payouts/[id]/page.tsx:251`, `257`, `605`, `632`, `827`, `848`;
  against `src/app/_components/ui.tsx:250-260`
- **Cost:** An operator using a screen reader pastes loot, the appraisal comes back
  with four items priced at 0.00, and the warning that the pool total is short —
  the one thing the page says an operator "MUST see before finalizing"
  (page.tsx:186-188) — appears silently, because the `role="status"` node is
  inserted with its text already inside it rather than filled after mounting.
- **Principle:** none as a WCAG SC; the `Notice` docblock states it directly: "The
  `&&` form is the one shape that defeats the live region it just asked for… AT
  announces a *change* to a region far more reliably than a region born holding
  text." The primitive grew an empty-slot mode specifically so call sites could
  mount unconditionally, and this page — the one with six of them — uses `&&` at
  all six.
- **Fix:** Mount all six unconditionally and pass the empty value:
  `<Notice tone="warn">{poolsWithUnresolvedItems.length > 0 ? <>…</> : ""}</Notice>`.
  The `errorMessage` one at line 251 is the exception worth arguing — it arrives by
  navigation, so the document is new either way — but the four derived warnings
  (unresolved items, the two roster clashes, and the `dropped` report after the
  `?dropped=` remount) all appear as a result of an action the operator just took
  on a page that did not reload, and those are the ones the region exists for.

### 6. The pool-items table is the one table on the page that runs to hundreds of rows, and it is the one that gets no sticky header

- **Severity:** moderate
- **Where:** `src/app/payouts/[id]/page.tsx:673-745` (`<Scroller>` with no `tall`,
  `<table className="log">` with no sticky modifiers) against `873-874` (the
  roster, which gets the full kit past 20 rows)
- **Cost:** An operator repricing item 180 of a 200-item pool is typing into a bare
  number box in a column whose header — "Unit price", the one that distinguishes it
  from "Line total" two cells away — scrolled off the top 170 rows ago, on the
  control whose own action comment calls a mistyped zero "the expensive error on
  this page" (globals.css:1838-1841).
- **Principle:** DESIGN.md, "Wide tables scroll inside a focusable, labelled
  region"; PRODUCT.md principle 3, "scanning is the primary act… optimize for the
  eye moving down a column".
- **Fix:** Give the item table the same treatment the roster gets and on the same
  terms — `log--sticky-head` plus `Scroller tall={pool.items.length > N}`. Do not
  add `log--dense` unless finding 4 is fixed first, or it inherits the accounts
  cap. The per-item `aria-label`s already carry the column name for AT
  (`Unit price for ${item.name}`), so this is specifically the sighted operator's
  gap.

### 7. `PaymentHistory`'s summary is a ~22px target in a table cell, the exact case the codebase already fixed for `.json`

- **Severity:** moderate
- **Where:** `src/app/payouts/[id]/payment-history.tsx:36-39` rendering into
  `src/app/globals.css:2340-2350` (`.log summary`, which sets no `min-height`),
  against `2371-2384` (`.json > summary`, which takes 28px and says why)
- **Cost:** An operator on a laptop trackpad checking who paid whom on a 60-row
  roster is aiming at a 22px-tall "payments (2)" control, one per row, in a table
  whose rows are 30px apart — so a miss lands on the row instead and nothing opens.
- **Principle:** WCAG 2.5.8 Target Size (Minimum). The `.json > summary` comment
  makes the argument verbatim for an identical shape: "It is a control in a table
  cell, not a link in a sentence, so the inline-target exception does not cover it."
- **Fix:** Widen the `.json > summary` rule to cover both, or give `PaymentHistory`
  a class of its own taking the same `min-height: 1.75rem; padding: 0.2rem 0`.
  Note the `align-items: center` in that rule is the right call here too, since
  "payments (2)" never wraps.

### 8. Four "save" buttons that confirm nothing, on a page that has the confirmation pattern already

- **Severity:** moderate
- **Where:** `src/app/payouts/[id]/page.tsx:375-447` (the four detail forms),
  against `src/app/_components/note-form.tsx:6-19`
- **Cost:** An operator editing the operation notes types their text, presses
  "save", and gets nothing back: the textarea already held what they typed, the
  button does not change, and the fact it updated is a `<dd>` in the facts grid
  that is scrolled off the top by the time they are on the fourth field — so a
  successful save and a save they forgot to press look identical.
- **Principle:** none; `NoteForm`'s docblock is the repo's own statement of the
  case ("a successful save changed nothing else on screen… a click read as dead").
- **Fix:** Same shape `NoteForm` uses — `useActionState` returning a counter, a
  `role="status"` span rendered unconditionally beside the button holding "· saved",
  cleared on the next keystroke. Failing that, at minimum give the four `Submit`s
  a `pendingLabel="saving…"`, which is one prop and is what every other
  side-effecting control on this page that takes any time already does.

### 9. The appraisal leaves the paste in the box and says nothing on success

- **Severity:** moderate
- **Where:** `src/app/payouts/[id]/appraise-form.tsx:30-53`;
  `src/app/payouts/actions.ts:224-226` (`revalidateOperation` then `return { ok: true }`)
- **Cost:** An operator pastes 200 lines of loot, waits several seconds for triff
  and ESI, and gets back a form holding the same 200 lines, a button that has gone
  from "Pricing…" back to "Appraise", and no statement that anything happened — so
  the natural read on a slow connection is that it didn't, and the second press
  creates a second pool with the same loot in it and doubles the payout.
- **Principle:** none. `AppraiseActionState` already carries `{ ok: true }`
  specifically so "a client leaf can tell that apart from either of those"
  (actions.ts:160-163), and nothing consumes it.
- **Fix:** Consume the `ok: true` the action already returns: render a
  `role="status"` confirmation naming what was added ("pool 3 added, 4.82b ISK"),
  and clear the textarea on success — the paste is persisted as `rawPaste` on the
  pool by then, so nothing is lost by dropping it from the form, and an empty box
  is the strongest available signal that the submit landed.

### 10. The notices name the affected items in the faintest, smallest type on the page

- **Severity:** minor
- **Where:** `src/app/payouts/[id]/page.tsx:616-625`, `838`, `861`, `266-277`;
  `src/app/globals.css:1315-1318` (`.dim` is `--ink-faint` at `0.8125rem`)
- **Cost:** An operator who needs to know *which* items are unpriced reads a
  semicolon-run of "Pool 1: Item A ×3, Item B ×1; Pool 2: …" set 13px in the page's
  faintest ink, wrapped across a 68ch paragraph — while the bold headline above it,
  which only carries a count, gets the full ink. The page's own comment
  (page.tsx:190-194) says "naming the items, not just a count, is the part that
  actually matters", and the styling says the opposite.
- **Principle:** DESIGN.md's ink scale — `--ink-faint` is documented for "labels,
  metadata, timestamps", and this is neither.
- **Fix:** Give the payload line `--ink-dim` at `--t-data` rather than `.dim`, and
  break the per-pool groups onto their own lines rather than joining with "; ".
  `.dim-ink` (globals.css:1327) already exists for exactly "colour only, keep the
  size" and is the closer fit.

## What is good and must survive

- **`ConfirmArmScope` wrapping each `<tbody>` rather than each row.** The roster's
  scope (page.tsx:893) and the pools' (535) mean arming "remove" on one row disarms
  "delete" two rows up. A refactor that pushes the scope down to the row for
  "cleanliness" silently reintroduces the half-armed control the component exists
  to prevent.
- **`ConfirmCost` at page level, below a `btn-row`, not in a `td`.** The reasoning
  at page.tsx:1193-1208 and confirm-submit.tsx:88-98 is empirical (#111/#112) and
  the placement is the whole of why it is safe to reveal here. Do not move the
  delete control into a table, and do not "align" the cost sentence beside it.
- **`fmtIsk` + `.num` + `tabular-nums` on every money column.** `.log td` sets
  `font-variant-numeric: tabular-nums` (globals.css:808) and `fmtIsk` groups from
  the string rather than through `Number()`. Every ISK figure on this page — facts
  grid, pool values, line totals, roster amounts, payment history, the delete cost
  sentence — goes through it. A fix pass that formats one of them inline breaks the
  column alignment and, for a large `numeric(20,2)`, the value.
- **`CopyAmountButton`'s clear-then-set.** `setResult("")` followed by a `setTimeout`
  to `"copied"` (copy-amount-button.tsx:58-63) is what makes copying the same row
  twice two announcements instead of one, and the synchronous
  `navigator.clipboard?.writeText` check is what stops an insecure context silently
  doing nothing. Both look like noise and are not.
- **`ClearStaleQuery`'s capture-phase, submit-time clearing.** The timing is the
  design and the docblock says so; a "simplification" to clear on mount destroys
  every error notice on the page instantly.
- **`ROSTER_TALL_THRESHOLD` itself.** The idea — don't cap a twelve-row table for
  the sake of a sticky header that has nothing to scroll over — is right. Finding 4
  is about which cap it opts into, not about the threshold.
- **Per-row accessible names naming the subject.** `save ${p.displayName} shares`,
  `Unit price for ${item.name}`, `delete pool ${index + 1}`, `confirm revert payment
  for ${p.displayName}`. These are the difference between a speech-input operator
  addressing one of 200 controls and addressing "save".
- **Finalize sitting below the roster it freezes**, and the neutral (not `warn`)
  tone on `unpaid` and on `frozen`. Both are argued in place and both are right.

## Could not evaluate

- **Whether the `?error=` redirect actually scrolls to top in this Next version.**
  I inferred it from `ClearStaleQuery`'s own `{ scroll: false }` rationale, which
  only makes sense if the default scrolls. A Playwright assertion on `scrollY`
  after a rejected shares edit would settle it. The remount and the disclosure
  collapse are independent of that and hold either way.
- **Actual column widths at 320px**, and therefore whether the roster's pinned Name
  column can ever exceed the scrollport and put columns 2-5 permanently out of
  reach. The cell holds `displayName` plus a comma list of every source character,
  which is unbounded; auto table layout should keep it near min-content, but that
  is a browser measurement, not a source reading.
- **Whether the `Scroller` inside a collapsed pool-items disclosure gets its tab
  stop back when the disclosure opens.** The children are eager (deliberately —
  disclosure.tsx:119-123), so the region measures 0×0 and starts at
  `tabIndex={-1}`; restoring it rests entirely on the `ResizeObserver` firing.
  `scroller.tsx:87-92` says a missed observation "costs keyboard access to the
  table" and names `e2e/sync.spec.ts` as the thing pinning it. There is no
  equivalent assertion in `e2e/payouts.spec.ts`, which opens `Pool 1 items` three
  times and never checks the region.
- **The hydration weight.** Countable but not measurable from source: a draft
  operation with three pools of 70 items and a 60-name roster ships roughly 210
  `Submit` leaves (each a `useFormStatus` + a `useSubmitGuard` ref and effect), 60
  more for shares, 60 `ConfirmSubmit`, 4 `Scroller` (each with a `ResizeObserver`
  on two nodes), and — once finalized — 60 `CopyAmountButton` and up to 60
  `PaymentHistory` disclosures. The item tables hydrate whether or not their
  disclosure is ever opened, which `disclosure.tsx:119-123` argues for explicitly
  on find-in-page and no-JS grounds. That argument is sound; whether it survives
  200 items rather than the handful it was written against needs a profile.

## Contested

Nothing on the settled list looks wrong to me. Two notes for the synthesis rather
than arguments:

- **The `.st` weight defect appears already fixed.** DESIGN.md and the preamble
  record `.st` as declaring no `font-weight` and rendering at 400;
  `globals.css:1358` declares `font-weight: 600`. If that landed since the doc was
  written, the doc is the thing that is now stale.
- **`.copy-result`'s comment describes a placement it no longer has.**
  `globals.css:1778-1781` justifies its 5rem width reservation on the grounds that
  "it sits in a right-aligned row of buttons"; page.tsx:938-949 moved it into the
  Amount cell. In its new home the reservation adds ~80px to the narrowest useful
  column on every finalized roster row, at 320px, where the table is already
  scrolling. Not a settled item, and too small to spend a finding slot on — but the
  next person to read that comment will be reading about a layout that is gone.

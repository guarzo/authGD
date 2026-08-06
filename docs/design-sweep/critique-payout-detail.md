# critique — /payouts/[id]

Register: **product**.

The page's order *is* the order of the work, and deliberately so — Add loot above
the table it fills, Finalize below the numbers it freezes, Delete last. That part
is right and the comments prove it was thought about. What is wrong is narrower
and more expensive: the two presses that close doors permanently say nothing
about it before they are pressed, the roster table cannot support the fix its own
warnings prescribe, and the member — who is half this page's traffic and can
reach every draft in the corp — is served a number the service layer refuses to
show them one route over.

## Findings

### 1. The first "mark paid" freezes the operation forever, and the page only says so afterwards

- **Severity:** serious
- **Where:** `src/app/payouts/[id]/page.tsx:1002-1017` (the press), `:210-223` (`firstPayment`), `:1109-1117` (the sentence that explains it)
- **Cost:** An operator who marks the first person paid before noticing a wrong share has permanently frozen the pools, the roster, every share and the corp cut, and the only sentence on the page that would have told them so renders for the first time immediately *after* the press that made it true.
- **Principle:** PRODUCT.md principle 2, "state before action"; and `confirm-submit.tsx:62-70`'s own rule for `ConfirmCost` — "arming is the moment the sentence becomes load-bearing".
- **Fix:** The page already knows the exact condition (`operation.status === "finalized" && !locked && access.isOperator`). Render the counterpart of the `locked` paragraph *before* the fact, as a `.dim` sentence between the roster warnings and the roster `Scroller` (`:865`): "The first payment recorded here freezes the loot pools, the roster, shares and the corp share permanently. Unlock is gone from that point on — check the numbers before the first one." Do **not** reach for `ConfirmCost` on the button itself: it lives in a `<td>`, and #112 established that a reveal inside a table cell disarms the control it describes.

### 2. Members are shown live draft amounts that `payout-view.ts` deliberately refuses to show them

- **Severity:** serious
- **Where:** `src/app/payouts/[id]/page.tsx:935-960`; the documented refusal at `src/services/payout-view.ts:376-394`; reachability at `src/app/payouts/page.tsx:78-84`
- **Cost:** A member opens Tuesday's draft from the Payouts list, reads 42M against their name, comes back after the operator adds two more people, reads 31M, and concludes someone took a cut — the exact failure `listAccountPayouts` is finalized-only to prevent.
- **Principle:** none for the citation; the repository's own evidence is stronger. `listAccountPayouts`'s docblock argues in as many words that a draft amount "states a commitment the operation has not made — and a member who checks twice would see two different figures with no explanation." Any Member-tier account reads every operation (`payouts/page.tsx:78-84`, deliberate), so this page hands them exactly that figure with no caveat. The docblock is right and the page contradicts it.
- **Fix:** When `operation.status === "draft" && !access.isOperator`, render a `.dim` line under the Roster `RuleHead`: "Draft. These amounts are recalculated on every roster or loot change and nothing is owed until the operation is finalized." Suppressing the Amount column instead would be worse — transparency is the design's stated reconciliation mechanism (`payouts/page.tsx:78`). The caveat, not the concealment.

### 3. The roster table renders no resolved/unresolved state, so the cross-state clash warning prescribes a fix the table cannot support

- **Severity:** serious
- **Where:** `src/app/payouts/[id]/page.tsx:896-902` (the name cell), `:848-864` (the notice), `roster-warnings.ts:26-36`
- **Cost:** An operator told "Bob is both linked and unlinked — check before finalizing" scrolls to the roster and finds two rows reading exactly `Bob`, pixel-identical, and has to guess; removing the linked one silently drops that pilot from their own /account payout history, which is the one row that would have shown up there.
- **Principle:** none. This is what a real read produces: the warning is correct, actionable, and lands the operator on a table with no discriminator.
- **Fix:** Render the row's resolution state in the Name cell — a neutral `<Status>unlinked</Status>` when `p.accountId === null`. Neutral, not warn: an unlinked row is the ordinary case per `roster-warnings.ts:26-36` and colouring it would alarm the common path. This also explains the other unexplained asymmetry in the same table: `open info` is absent on exactly these rows (`:989`), currently with no visible reason.

### 4. The page never marks the viewer's own row

- **Severity:** moderate
- **Where:** `src/app/payouts/[id]/page.tsx:894-1078`; `access.accountId` is in hand at `:140`, `p.accountId` is on every row
- **Cost:** A member who followed their operation name from /account to check one number reads a facts grid about the corp's cut, a loot table, two roster notices addressed to somebody else, and then scans forty alphabetical rows for their own name — on a page that knows which row is theirs.
- **Principle:** PRODUCT.md, "Members … want to confirm state and leave."
- **Fix:** Mark the viewer's row. Not a colour: add a `.visually-hidden` "you" plus a small `(you)` in `--ink-faint` after `p.displayName` when `p.accountId === access.accountId`. One line, no new component, and it survives the `log--sticky-col` pin because it is inside the first cell.

### 5. Both roster notices give operator instructions to an audience that is mostly members

- **Severity:** moderate
- **Where:** `src/app/payouts/[id]/page.tsx:827-841` ("remove one before finalizing"), `:848-864` ("Check before finalizing"), `:605-628` ("The pool total is short")
- **Cost:** A member checking their share reads two blocks telling them to remove roster rows and check things before finalizing, has no control that does either, and cannot tell whether they are being asked to do something or being told the payout is broken.
- **Principle:** the page's own precedent, argued at `:296-304`: the frozen notice was demoted precisely because "it rendered for every reader regardless of role, so a member checking their own share read editing rules … that never applied to them." The same argument applies verbatim here and was not carried across.
- **Fix:** Split each notice's copy at the imperative. The *fact* ("two rows named Bob are each drawing a full share") is worth showing everyone — that is the transparency the list page's lede promises. The *instruction* ("remove one before finalizing", "check before finalizing") should be a trailing clause gated on `access.isOperator`, the same shape the `locked` paragraph already uses at `:1109`. The unresolved-items notice at `:605` needs the same treatment on its last sentence only; "the total is short" is a fact a member is entitled to.

### 6. "Mark paid" is an armed two-click control on the first row and a bare one-click control on every row after

- **Severity:** moderate
- **Where:** `src/app/payouts/[id]/page.tsx:1006-1015`; the reasoning at `:210-223`; `confirm-submit.tsx:122-127`
- **Cost:** An operator paying twelve people arms and confirms row one, then — same button, same size, same place, one row down — single-clicks row two, and a stray click while scanning a 28px-control dense table marks the wrong pilot paid.
- **Principle:** none; this is a direct tension with `ConfirmSubmit`'s own stated purpose. The docblock at `:210-223` argues the arm only from consequence-permanence: "every later mark paid is a click behind a door already shut." That is true about the *lock* and beside the point about the *misfire*. `ConfirmSubmit` exists because a destructive row action is "too easy to hit by accident scanning a dense table" (`confirm-submit.tsx:125-126`), and this table is `.log--dense` with the 28px in-row grade — the exact case. The argument is documented and, on this specific point, wrong.
- **Fix:** Keep `ConfirmSubmit` on every "mark paid", not just the first. Cost is one extra click per participant on an action performed once per person per operation; the thing it prevents is paying the wrong person real ISK. If the extra step is genuinely unwanted, the alternative that keeps the protection is to leave rows 2..N one-click but make them visually distinct from the armed-capable first row — worse, and I would not.

### 7. A finalized operation that this operator cannot unlock explains nothing

- **Severity:** moderate
- **Where:** `src/app/payouts/[id]/page.tsx:1118-1149`; the sentence that already exists, in the wrong place, at `:643-657`
- **Cost:** An operator who is not the creator opens a finalized operation to fix a share, finds the shares read-only, no Finalize, no Unlock, and an empty control row where the buttons should be — with nothing on the page saying who can reopen it.
- **Principle:** none.
- **Fix:** The page has already written this sentence — "Only this operation's creator or an admin can unlock it" — but only inside a notice gated on `poolsWithUnresolvedItems.length > 0` (`:632-657`), which is the narrowest possible case. Add the `finalized && !locked && !canUnlock` branch to the paragraph block at `:1144`, so the control row is never rendered empty and silent. Same three-branch shape the block already has for `locked` and for `canUnlock`.

### 8. The paid-progress signal is weaker on the page where the paying happens than on the list page

- **Severity:** moderate
- **Where:** `src/app/payouts/[id]/page.tsx:753-767` (`.dim mono` "2/12"); compare `src/app/payouts/page.tsx:168-191`
- **Cost:** A stalled payout — finalized, some rows still unpaid — is amber on the list page and turns neutral grey the moment the operator clicks through to the page where they would fix it, so the one screen dedicated to finishing the job is the one screen that stops flagging that it is unfinished.
- **Principle:** DESIGN.md, "Colour only when the state is actionable"; the list page's own comment at `:172-177` names finalized-with-unpaid as "the one genuinely stalled case", and the detail page is where it is actionable.
- **Fix:** Make the Roster `RuleHead` aside a `Status` carrying the list page's exact rule: `ok` when `paid === owed`, `warn` when `finalized && paid < owed`, neutral for a draft. The list page's comment at `:157-161` already argues the token over a bare fraction ("a bare fraction asks the reader to do the comparison; the token has already done it"). Note this also settles the third reading of the same fact: the account page renders a member's unpaid row `warn` (`account-payouts.tsx:91`), which is the one place the member cannot act — worth a look in that surface's own pass.

### 9. The roster's tall cap inherits /admin/accounts' chrome subtraction, which does not describe this page

- **Severity:** moderate
- **Where:** `src/app/payouts/[id]/page.tsx:120-127`, `:873`; `src/app/globals.css:1032-1075`
- **Cost:** An operator paying a thirty-name roster gets roughly ten rows in a nested scroll box, on a page that is already several thousand pixels tall — two scrollbars under one wheel, at the exact moment they are moving between a row's copy button and its mark-paid button.
- **Principle:** none; the CSS's own comment is the evidence. It says "The accounts table only … this narrows to the one table carrying `.log--dense`", and this roster now carries `.log--dense`. The `100svh - 29rem` term is a *measured* subtraction of /admin/accounts' page head, lede, pending notice and filter row, so that the region "ends inside the viewport". Above this roster sits a facts grid, up to three notices, a loot table and N item disclosures — the subtraction is not merely wrong here, it is subtracting the wrong page's furniture. At 900px tall it yields 436px where the shared `.scroller--tall` bound would give 720px. `ROSTER_TALL_THRESHOLD`'s comment names the cap as accounts-tuned but does not engage the narrowing.
- **Fix:** Scope the narrowing to the accounts table specifically rather than to `.log--dense` — add a `.log--accounts` class at that call site and change the selector to `.scroller--tall:has(.log--accounts)`. This roster then falls back to the shared `80svh`, which is what the threshold comment was reasoning about in the first place.

### 10. Half the facts grid restates the page head four lines above it

- **Severity:** minor
- **Where:** `src/app/payouts/[id]/page.tsx:229-245` (head) and `:308-311` (Name, Date)
- **Cost:** The three facts an operator actually opens this page for — is it finalized, what is the total, what is the corp taking — sit below three rows that repeat the H1 and the lede verbatim, so every visit costs a skip.
- **Principle:** impeccable shared law, "no restated headings"; PRODUCT.md principle 2, the grid's job is "what is true right now."
- **Fix:** Drop the Name and Date rows. The H1 is the name and the lede's `.mono` span is the date, both immediately above. Leave Battle report — the code argues that duplication explicitly at `:314-317` (a clickable full URL for a reader vs. a short link in the lede) and that argument holds; the Name and Date rows carry no such case.

## What is good and must survive

- **The two deliberate reorderings.** Add loot sits *above* the pools table (`:462-473`) and Finalize/Unlock sits *below* the roster (`:1091-1097`). Both were moved from the opposite side and both comments say why. A layout pass that "gathers the primary actions at the top" would silently undo the single best thing about this page.
- **`ClearStaleQuery`'s `router.replace` on submit** (`clear-stale-query.tsx:31-41`). Converting the success paths to a server `redirect()` — the obvious "simplification" — remounts every `Disclosure` and closes whatever loot pool or item panel the operator had open. The `data-navigates` opt-out on the appraise and delete forms is load-bearing for the same reason.
- **`CopyAmountButton` writes raw `p.amount`, never through `fmtIsk`** (`:940-941`). A consistency pass that routes it through the formatter puts thousands separators into an EVE transfer field.
- **`ConfirmArmScope` wrapping each `<tbody>`** (`:535`, `:893`) so exactly one destructive control is armed at a time across the whole table.
- **The unresolved-items notice naming the items, not a count** (`:186-194`, `:616-625`). "12 items unpriced" and "Pool 2: Sin ×1" are not the same information and the comment says so.
- **`ROSTER_TALL_THRESHOLD` existing at all** (`:120-127`). Do not restore unconditional `tall`.
- **Neutral `unpaid` in the roster State column** (`:966-972`). Finding 8 asks for tone on the *section aside*, which is a summary an operator scans; the per-row token staying neutral is correct and the comment's reasoning is right.

## Could not evaluate

- **Whether `Battle report` wraps the `.facts` label column.** `.facts` fixes the `dt` column at `6rem` = 96px, sized when the longest label in the app was "Standings" (9 characters). "Battle report" is 13, and at `--t-label` (11px) in IBM Plex Mono plus `--track-label` (0.12em) the advance is about 7.9px per character — roughly 103px, over the column. `align-items: baseline` would then align the `dd` to the first of two lines. That is arithmetic, not a measurement; a browser at 1280px settles it. If it does wrap, the fix is `6.5rem`, not a `max-content` column (the comment at `globals.css:596-600` argues correctly against that).
- **The real rendered height of the roster region** under finding 9, at 768px / 900px / 1080px viewports with the item disclosures open and closed. The numbers above are computed from the CSS, not observed.
- **Whether the one-click "mark paid" of finding 6 has actually misfired in production.** The `payout_payment` table records `reverted` events with an actor and an instant; a count of reverts landing within a few seconds of the payment they undo would settle it either way.

## Contested

Nothing on the settled list. Every item I checked against it — the arm-without-timer, the two hit-target sizes, disabled controls keeping `opacity: 1`, `Disclosure` on `<details>`, `.btn-row--controls` below its data — is correct here and several of them are why the page works at all.

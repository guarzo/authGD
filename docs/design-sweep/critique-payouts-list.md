# critique — /payouts and /payouts/new

Register: **product**. Read in full: `src/app/payouts/page.tsx`,
`src/app/payouts/new/page.tsx`, `src/app/payouts/access.ts`,
`src/app/payouts/actions.ts`, `src/app/payouts/errors.ts`,
`src/app/payouts/pending-link.tsx`, `src/services/payout-view.ts`,
`src/app/_components/format-isk.ts`, `src/app/_components/ui.tsx`,
`src/app/_components/scroller.tsx`, `src/app/account/account-payouts.tsx`, the
facts grid of `src/app/payouts/[id]/page.tsx`, the pager of
`src/app/admin/audit/page.tsx`, and the `.log`, `.log--payouts`, `.log__empty`,
`.pager`, `.page__head-row`, `.form-panel`, `.form-stack`, `.link-pending`
rules in `globals.css`.

Traced end to end: operator presses **New operation** → `/payouts/new` →
`createOperationAction` → `redirect('/payouts/' + id)`. Note the trace does not
end on the list: a successful create lands on the detail page, and the list is
only ever re-rendered by `revalidatePath` behind the operator's back.

## Findings

### 1. The list cannot answer "was I paid?", which is the question its name promises

- **Severity:** serious
- **Where:** `src/app/payouts/page.tsx:93-98`, `:107-117`, `:157-192`; `src/services/payout-view.ts:15-23`
- **Cost:** A member who opens /payouts to check whether last Tuesday's fight paid them reads a five-column table in which not one cell is about them, has to notice a link buried mid-sentence in the lede, navigate to /account, and re-orient in a second table with different column names before getting the answer.
- **Principle:** PRODUCT.md principle 2, "State before action. Every screen answers 'what is true right now?'… A member should be able to leave without clicking." Also PRODUCT.md's user model: the member session is "short and interruptive… they want to confirm state and leave."
- **Fix:** Add a sixth column, **Yours**, rendered only for a viewer who has a row in the operation. The query already exists in shape: `listAccountPayouts` does `payoutParticipant.accountId = me`; the list needs the same predicate scoped by `inArray(payoutParticipant.operationId, pageIds)`, which is a `where` clause added to the participants query `listPayoutOperations` already issues at `payout-view.ts:135-139` — zero extra round trips. Render `<Status tone="ok">paid</Status>` / `<Status tone="warn">unpaid</Status>` / an em-dash-plus-visually-hidden "you were not on this roster", matching `account-payouts.tsx:88-94`. Honour that file's own honesty rule: a draft's `amount` moves on every recalculate, so a draft row shows "not final yet", never a figure. If the column is judged out of scope, the minimum is to stop the current columns implying otherwise (see finding 5) and to promote the /account pointer out of the lede's third clause into its own line.

Note what this is *not*: the `complete`/`quantity` split, the `pastEnd` exit,
the cursor hardening and the three-tone Paid token are all careful work. The
problem is not craft, it is that the craft is spent on the operator's
reconciliation view while the page's lede, its title, and its position in the
member nav all promise the member's own view. Every member sees this page;
roughly four people need what it currently renders.

### 2. `/payouts/new`'s lede promises an editor that was deleted

- **Severity:** moderate
- **Where:** `src/app/payouts/new/page.tsx:72-77`
- **Cost:** An operator is told "battle report, corp share, and notes can all be added on the operation once it exists", creates the operation, and then hunts the detail page for a corp-share control that is not there — the fact renders as plain text at `[id]/page.tsx:326-340` and the inline editor was removed on purpose.
- **Principle:** none (a copy/reality mismatch; nothing to cite beyond the lede being false).
- **Fix:** Drop "corp share" from the sentence: "Give it a name and a date; battle report and notes can be added on the operation once it exists." If the corp share is worth stating here at all, state it as the fixed fact it now is — `getConfig().payoutCorpSharePct` is available to this server component, so "The corp takes {pct}% of every operation" is a true sentence and a better one, because it is the number the operator would otherwise go looking for.

### 3. The pager is the audit page's pager minus both fixes the audit page already made

- **Severity:** moderate
- **Where:** `src/app/payouts/page.tsx:227-250`, against `src/app/admin/audit/page.tsx:183-217` and `:529-538`
- **Cost:** A keyboard reader on a full 50-row page tabs through 50 operation-name links to reach **Older**, then lands at the top of the next page and does it again; a screen-reader user listing this page's links hears "Latest" and "Older" with no object, because both arrows are `aria-hidden`.
- **Principle:** WCAG 2.4.4 Link Purpose (In Context) — cited verbatim in the audit `Pager` docblock, which fixed exactly this with `<span className="visually-hidden"> entries</span>`.
- **Fix:** Two edits, both already written next door. Add `<span className="visually-hidden"> operations</span>` inside each anchor, after the visible word and outside the `aria-hidden` arrow. Render the same pager block a second time above the `<Scroller>` with `className="btn-row pager pager--top"` — `.pager--top` exists in `globals.css:2062-2067` for this and currently has one caller. The payouts page-size is 50 and every row's first cell is a link, so the audit page's "roughly 300 tab stops" argument applies here at a smaller but still disqualifying scale.

### 4. The date default silently mis-dates any operation from a late-night fleet

- **Severity:** moderate
- **Where:** `src/app/payouts/new/page.tsx:56-57`, `:108-118`
- **Cost:** An operator recording a fleet that fought at 23:00 and pasting loot at 01:30 gets today's UTC date pre-filled, submits without looking (the field is pre-filled and correct most of the time, which is exactly what stops it being read), and the operation is filed one day after the fight — where it sorts wrong in a date-ordered list and disagrees with the battle report it links to.
- **Principle:** none. The docblock argues correctly that `yyyy-mm-dd` parsed as UTC midnight is EVE time; it does not argue that "now, in UTC" is the right *day*, and for a US-timezone fleet it routinely is not.
- **Fix:** Keep the default and make it legible. `<input type="date">` renders in the browser's locale (mm/dd/yyyy for en-US), so the operator does not even see the ISO string every other surface in the app shows them. Add a `.dim` hint below the field inside `.form-stack__field` — the slot the CSS comment at `globals.css:1909-1916` says it exists for — reading the resolved value in words plus its frame of reference: "Tuesday 5 August (EVE time). Fleets that ran past midnight EVE belong to the previous day." Nothing about the parse changes; the wrong default just stops being invisible.

### 5. "Total" does not say whose total, on a page a member is reading for their own number

- **Severity:** minor
- **Where:** `src/app/payouts/page.tsx:113-115`, `:147-156`; the same fact is "Total loot" at `[id]/page.tsx:341-342`
- **Cost:** A member scanning a row reads "Total 4,821,430,000.00 ISK" beside "12/40 paid" and has no cue that the first number is the whole pot before the corp's cut and the second is everyone else's progress, not their own.
- **Principle:** UX-writing "Consistency: the terminology problem" — one fact, two names, one click apart.
- **Fix:** Rename the header to **Total loot**, matching the detail page's `<dt>`. It is one word and it removes the reading in which the column is about the reader.

### 6. "50 shown" tells you the page is not the list, but never which part of the list it is

- **Severity:** minor
- **Where:** `src/app/payouts/page.tsx:56-65`, `:100-105`
- **Cost:** A member looking for a fight from three months back clicks **Older** blind, four or five times, with the aside reading "50 shown" identically on every page and nothing on screen saying which stretch of history is in front of them.
- **Principle:** Nielsen 1, visibility of system status.
- **Fix:** Extend the aside with the page's own date span when it is not the whole list — `ops[0].occurredAt` and `ops[ops.length - 1].occurredAt` are both in hand, so this costs nothing: `50 shown · 2026-04-02 – 2026-05-18`. Keep the `complete` branch as it is; "12 total" needs no span. This is the cheap half of a jump-to-date control the page probably wants eventually and does not have to build today.

### 7. The table region and its heading announce the same word

- **Severity:** minor
- **Where:** `src/app/payouts/page.tsx:100-107`
- **Cost:** A screen-reader user moving to the table hears "Operations, heading level 2" then "Operations, region", and the region's label — the thing that should distinguish it in a landmark list — adds nothing.
- **Principle:** none beyond in-repo precedent: `account-payouts.tsx:58-61` documents avoiding exactly this ("both otherwise announce 'Your payouts' and a screen-reader user hears the same words twice in a row"), and `audit/page.tsx:541` adds a `<caption className="visually-hidden">` on top of its distinct region label.
- **Fix:** `<Scroller label="Operation list">` (or "Payout operations"), and add `<caption className="visually-hidden">Payout operations</caption>` to the table, matching the audit table. Note the current `Scroller` also takes a tab stop only while the region actually scrolls, so on a wide desktop this label is heard mainly in the landmark list — which is precisely where a duplicate is least useful.

### 8. Two of the page's four soft navigations have no press feedback, including the one the lede tells a member to press

- **Severity:** minor
- **Where:** `src/app/payouts/page.tsx:96` and `:200-201`, against `pending-link.tsx:6-31`
- **Cost:** A member follows the lede's "your account" link on a cold server, nothing paints, and they press it again — the exact failure `PendingLink` was written to prevent, on the one link that leads to the answer they came for.
- **Principle:** Nielsen 1, visibility of system status. Also an internal inconsistency: `PendingLink`'s docblock asserts "the three soft navigations in the app are all on /payouts — the New operation control, every operation name in the list, and the empty state's way back", and the empty state's way back is a plain `next/link` `<Link>`, not a `PendingLink`. The lede's link is a fourth the docblock does not count.
- **Fix:** Swap both `<Link>`s for `PendingLink`. `PendingLink` already accepts `className` and children and adds no props these call sites lack. Then correct the docblock's count to four, or restate it as "every soft navigation on /payouts", so the next reader does not have to diff it against the file.

### 9. The name field has no length bound, and the echo contract assumes one

- **Severity:** minor
- **Where:** `src/app/payouts/new/page.tsx:99-107`; `actions.ts:124-131`
- **Cost:** A pasted fleet description lands in the Name field and becomes an operation title that widens the list's first column for every reader on that page; and on a rejected submit `createFailed`'s `value.length <= 500` guard silently drops the name while `NEW_OPERATION_ERRORS.date_invalid` still says "The name is still filled in."
- **Principle:** none. Low likelihood in a deployment with a handful of operators, and the `Scroller` contains the layout damage rather than breaking the page — filed because the fix is one attribute and the lying error message is the kind of thing that is only ever found by reading.
- **Fix:** `maxLength={200}` on the name input, and the matching `if (name.length > 200) createFailed(formData, 'name_too_long')` with an entry in `NEW_OPERATION_ERRORS`. That makes the 500-char echo guard unreachable rather than merely unlikely, which is what stops the message from ever being false.

## What is good and must survive

- **The `complete` / `quantity` split** (`page.tsx:56-65`). "N total" only when the page provably is the whole list is a genuinely rare piece of honesty and costs no `COUNT(*)`. A later pass that "simplifies" this to a single label will make the page assert a total it does not know.
- **The three-tone Paid column** (`:157-192`), specifically the reasoning that a draft mid-payment is `neutral` and only a *finalized* operation with unpaid rows is `warn`. This is PRODUCT.md principle 4 applied correctly, and the obvious "simplification" (warn whenever `paid < total`) is the exact regression the comment records having already been made once.
- **The em dash plus `.visually-hidden`** at `:147-156` and `:162-167`. The dash is a data glyph for absence, not prose, and the reasoning about `aria-label` being dropped on a bare span is correct. A pass applying the "no em dashes" copy rule mechanically would break both cells.
- **`pastEnd`** (`:70`, `:198-202`). A cursor past the end getting a distinct message and an exit is the difference between a dead end and a page.
- **The `.form-panel` refusing registration ticks** (`globals.css:1926-1931`). The reasoning holds; a later pass adding them to make the two panels rhyme spends the login panel's one deliberate mark.
- **`/payouts/new` redirecting non-operators rather than rendering a form that will reject** (`new/page.tsx:39-43`), and the list hiding the button rather than disabling it. This is the operator/member split done right: a member spends attention on exactly zero controls that will never be theirs.

## Could not evaluate

- **Whether the member's own answer is reachable at all for many members.** `listAccountPayouts` matches on `payout_participant.account_id`, which its own docblock says is NULL for anyone whose name did not resolve at paste time. If unresolved names are common in practice, finding 1's fix would render an em dash for people who *were* in the fleet, and the real defect is upstream in name resolution. Settled by a production count of `payout_participant WHERE account_id IS NULL`.
- **Whether operation names are short in practice** (finding 9). Settled by `SELECT max(length(name)) FROM payout_operation`.
- **Column-width behaviour under real data.** `.log--payouts` sets no `table-layout: fixed` and no `colgroup` (unlike `.log--audit`), so all five columns are content-sized. I could not judge the resulting rhythm at 320px without rendering, and the sweep excludes a dev server.
- **Whether an operator ever returns to `/payouts` after creating.** The action redirects to the detail page, so the list is not on the create path at all — which is part of why finding 1 reads the way it does, but I cannot tell from source how often an operator uses the list as a work queue versus a record.

## Contested

Nothing on the settled list. One adjacent observation offered without asking to
reopen anything: the `/payouts/new` page does justify being a route rather than
an inline disclosure on the list, and the reason is in `actions.ts:111-131` —
`createFailed` needs a destination that is not the list, and the create path's
real terminus is the detail page, so an inline form would still navigate away
on both the success and the failure branch. But the page is currently carrying
two fields and one button on a full narrow page with no secondary escape from
the panel. The nav's "Payouts" item is the only way out, and it does not read
as a cancel. If a later pass wants to strengthen the page rather than remove
it, that gap is the place to spend the effort.

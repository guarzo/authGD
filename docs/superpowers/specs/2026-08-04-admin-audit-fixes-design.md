# Audit log: say what happened, and stop 500ing

Date: 2026-08-04
Branch: `worktree-fix+admin-audit-critique-fixes`, off `main` at `53097bf`

## Problem

A design critique of `/admin/audit` was run against the page actually rendering
— `next dev` on a seeded database with 102 audit rows, driven by Playwright —
rather than against source. Rendering it found things reading it did not, and
overturned two conclusions the static pass had reached. The full report and
screenshots are in `/tmp/reports/admin-audit-critique.md`; this spec covers the
findings that have a defensible right answer.

PRODUCT.md sets the bar: an admin can answer "why is this person's role wrong?"
from the audit log in under a minute. Three things currently bite into that.

**The page 500s on a duplicated query parameter.** `searchParams` is annotated
`Promise<{actor?: string; action?: string; target?: string; before?: string}>`
(`src/app/admin/audit/page.tsx:222-227`), but Next passes `string | string[]`.
`?actor=a&actor=b` reaches `raw.actor?.trim()` with an array and throws. The
annotation is narrower than the runtime contract, so TypeScript never flagged
it. Measured: HTTP 500, full-page error.

**The brightest text on the page is machine noise.** Measured ink distribution
across the table body is 1199 dim / 399 faint / 99 at `oklch(0.94 0.012 85)` —
the same lightness as the `<h1>`. All 99 are the details `<summary>`. So the
emphasis budget is not missing; it is spent, and on rows like
`discord.role_changed` it lands on
`+["112233445566778899"] -["998877665544332211","111222333444555666"] (green)`.
An operator asking which roles changed gets a JSON array of Discord snowflakes,
rendered brighter than anything else on screen.

**Two summary lines silently drop the field that answers the question.**
`status.changed` seeded as `{from: "active", to: "cryo", cause: "manual"}`
renders `→ cryo`. The adjacent `tier.changed` row, seeded the same shape,
renders `flygd → green`. Same column, same grammar, and only one says where the
account came from — so "when did this account stop being active" is
indistinguishable from a first-time set. Separately, `admin.promoted` has no
case at all and falls to a default branch that shows the first three payload
keys, which silently ate `scope: "full"` off a privilege-grant row.

Both are the same root cause: every case in `summarizeDetails` is a bespoke
template string, so `tier.changed` grew a `from` branch and `status.changed`
never did.

Three smaller findings ride along, listed in their sections below.

## Approach

Four independent changes. None depends on another, so they can land in one PR
or four; the ordering below is by risk, highest first.

### 1. Widen the searchParams type, normalize through one helper

Annotate the four params as `string | string[] | undefined` — the actual Next
contract — and normalize each through a `one()` helper before anything reads
them.

`one()` takes the **last** value of an array. A duplicate arises in practice by
appending `&actor=x` to a URL that already has one, so the appended value is
the intent. This is a convention, not a discovered requirement; it is written
down here so the test asserts a decision rather than an accident.

This also covers `before`, which today throws at `raw.before ? Number(...)`
before ever reaching its `Number.isFinite` guard on line 271.

Rejected: catching the error and rendering a fallback. It turns a 500 into a
different wrong answer while leaving the type lying about the runtime contract,
which is the actual defect.

### 2. Replace the template switch with a field declaration

Extract `summarizeDetails` and `fmt` from `page.tsx` into
`src/app/admin/audit/summarize.ts`. It needs unit tests that do not render, and
`page.tsx` is already 489 lines.

Declare, per action, which payload keys matter and how they read:

```ts
"tier.changed":         [transition("from", "to")],
"status.changed":       [transition("from", "to")],
"admin.promoted":       [scalar("scope"), scalar("note")],
"discord.role_changed": [roles("added", "removed")],
```

`transition(fromKey, toKey)` renders `flygd → green`, or `→ green` when `from`
is absent from the payload. `status.changed` gets its missing `from` by sharing
tier's renderer, not by someone remembering to duplicate a branch — which is
the point of the change. The two bugs were drift between hand-copied templates,
so the fix is to stop hand-copying templates.

`roles(addedKey, removedKey)` renders `+green −flygd`. Ids resolve through a
reversed `config.discord.roleIds` map (`src/config.ts:117-121`), which already
exists as a three-entry object. Unresolvable ids — a manually-added guild role,
or a role id that changed since the row was written — degrade rather than lie:

| Payload | Renders |
| --- | --- |
| added `[green]`, removed `[flygd]` | `+green −flygd` |
| added `[green]`, removed `[flygd, <unknown>]` | `+green −flygd, −1 other` |
| added `[]`, removed `[<unknown>]` | `−298471…` |

An unresolvable id shown on its own truncates to its first six characters plus
an ellipsis, and carries the full id in a `title`, matching how the actor,
target and action cells already handle overflow.

The role map is **passed in as a parameter**, not imported inside the module.
`summarize.ts` stays a pure function of its arguments, testable without env,
matching how `src/core/` is kept free of config. `page.tsx` reads config once
and passes it down.

The fallback for actions with no declaration keeps a three-key cap — the column
is narrow and the full payload is one disclosure click away — but appends
`+N more` when it cuts. The summary's job is not completeness; it is to not
lie about being complete. That distinction is what the current
`.slice(0, 3)` gets wrong.

Rejected: patching the three broken cases in place. A roughly ten-line diff
that fixes exactly what was found, and leaves the next action added to the app
free to drift the same way, silently. The class of bug is worth more than the
instances.

### 3. Empty state: fix behaviour, keep the row

`globals.css:568` styles `.log tbody tr:hover` with no exclusion, so hovering
the empty row paints `oklab(0.27 -0.00439019 -0.0417699 / 0.55)` — byte-identical
to a real data row under the same pointer. The one moment a user tests whether
a thing is interactive is the moment it lies to them.

Add `:not(.log__empty)` to that rule. Lines 709, 722 and 739 already carry
exactly that exclusion for the sticky-column rules; 568 is the one that was
missed. This is following an established local pattern, not inventing one.

**The 320px overflow is the worse half.** `colSpan={5}` inherits the colgroup's
summed rem widths, so the cell lays out at 561px inside a 304px scroller
(`cellRight: 561`, `scrollerRight: 304`, `overflowsRight: true`). On screen the
only content on the page reads:

> No account or character na

Cut mid-word. To read a sentence explaining there is nothing to read, the
operator scrolls horizontally.

The fix is an inner element pinned to the scroller's visible left edge and
capped to its inline size, so the message wraps within view while the cell
keeps its table-layout width. **The exact declarations are deliberately not
specified here.** `position: sticky` interacts with `table-layout: fixed` and
`colSpan` in ways worth verifying rather than asserting. The requirement and
its acceptance test are what this spec fixes:

> At a 320px viewport, with the empty state showing, the geometry probe reports
> `overflowsRight: false` and the full message is visible without horizontal
> scrolling.

The probe used in the critique is reusable for this.

Rejected: rendering the empty state as a sibling block outside the table. It
would kill the overflow, the hover and the reads-as-a-real-event problem at
once, because the message would stop being a row. But `.log__empty` is shared
with `/admin/accounts` (`src/app/admin/accounts/page.tsx:244`), so it either
touches a page this critique never examined or leaves two sibling admin tables
rendering empty differently under one shared class name. It also rewrites the
`.log__empty` selectors in `e2e/audit.spec.ts:327-345` and
`e2e/admin.spec.ts:504`, and loses the screen-reader association between the
message and the table. The structural argument is real and is recorded here in
case the accounts page is ever revisited; it is not worth that blast radius for
this change.

### 4. The pager overrun, and the unnamed table

`filtered` (`page.tsx:280`) counts `actor`, `action` and `target` but not
`before`. So `?before=1` against a 102-row log renders "Nothing has happened
yet." — the log is not empty, the cursor is simply past its end, and the page
says the opposite. Measured.

Add a third case to `emptyMessage` (`page.tsx:311-317`): when `beforeId` is set
and no rows came back, say there is nothing older than this point, and link
back to the unpaged view. That state currently has no exit at all — the `Older
→` button is gone, because it renders only when `rows.length ===
AUDIT_PAGE_SIZE`.

Separately: the table has no `<caption>`, no `aria-label` and no
`aria-labelledby`. Add a visually-hidden `<caption>`.

## Testing

**Unit** — `tests/audit-summarize.test.ts`, new. Vitest collects
`tests/**/*.test.ts` only (`vitest.config.ts:6`), so unit tests are not
colocated; this sits alongside the existing `audit-filter`, `audit-query` and
`audit-resolve` suites:

- one case per declared action, asserting the rendered line
- `status.changed` with and without `from` (the regression this exists to hold)
- `admin.promoted` renders `scope`
- the `+N more` marker appears when the fallback cuts, and does not when it fits
- an unresolvable role id degrades to `−1 other` / truncated id, not a throw
- a malformed payload (`null`, a string, a cyclic object) returns a string

**E2E** — `e2e/audit.spec.ts`:

- `?actor=a&actor=b` returns 200 and applies one of the two values
- `?before=<id past the end>` shows the older-than message and the link back
- the empty state is fully visible at a 320px viewport

**Watch item.** `e2e/audit.spec.ts` carries 29 `tbody tr` references, eleven of
them count assertions, plus three `.log__empty` assertions and a family of
`tbody tr:first-child td:first-child` locators; `e2e/admin.spec.ts:504` locates
`td.log__empty`. This design keeps the empty state as a `td` inside `tbody`
specifically so none of them need touching. **If one of them does need
touching, that is a signal the change went further than intended** — stop and
re-read this section rather than updating the assertion.

Related, and worth knowing before writing new assertions: the empty state is
itself a `<tr>`, so a bare `toHaveCount(1)` passes whether or not a filter
worked. New row-count assertions should filter by content.

**Commands** — per the working agreement, `npm test`, `npm run typecheck` and
`npm run test:e2e` all run and their output is quoted before any completion
claim. Note that the unit suite defaults to the shared `:5433` database and is
not worktree-safe; e2e is.

## Out of scope

The critique's pacing and hierarchy findings are subjective redesign and want
their own shape pass with mockups rather than being specced blind. They are not
in this branch:

- 96 consecutive identical `token.needs_reauth` rows with nothing grouping,
  collapsing or marking a day boundary
- the Target column truncating to "Maximilian Wint…" at 1440px while visible
  gutter sits to the right of the table, because the fixed rem colgroup never
  adapts upward
- `AT` being the widest column and the most redundant — 96 rows reading
  `2026-07-31`
- the count heading ("100+ entries") being an `<h2>` at 11px
  `oklch(0.66 0.02 264)`, and the "as of 11:09 UTC" aside being the only
  absolute clock on a page of relative times, rendered smaller than the
  relative stamps it qualifies
- the pager sitting at tab stop 310 of 311 — dead last on the page

Appendix A is a ready-to-run prompt for that pass.

## Appendix A: prompt for the pacing and hierarchy pass

```
$impeccable shape src/app/admin/audit/page.tsx

Route: /admin/audit. Scope is pacing and visual hierarchy only — correctness
bugs are handled separately in docs/superpowers/specs/2026-08-04-admin-audit-fixes-design.md,
which is landing on its own branch. Do not restate or re-fix those.

Measured facts from a rendered page (102 seeded rows, screenshots in
/tmp/reports/shots/, full report in /tmp/reports/admin-audit-critique.md):

- 96 consecutive rows read `token.needs_reauth` / `2026-07-31`. Nothing groups,
  collapses, or marks a day boundary. Scrolling it is scrolling wallpaper.
- The AT column is the widest in the table and carries the most repeated string
  on the page.
- At 1440px the Target column truncates to "Maximilian Wint…" on nearly every
  row while empty gutter sits to the right of the table. The colgroup uses
  fixed rem widths that never adapt upward.
- Ink distribution in the table body is 1199 dim / 399 faint / 99 ink. All 99
  ink-level elements are the details <summary>.
- The count heading "100+ entries" is an <h2> at 11px oklch(0.66 0.02 264),
  and carries an "as of HH:MM UTC" aside — the only absolute clock on a page of
  otherwise relative timestamps, rendered smaller than the stamps it qualifies.
- The pager is tab stop 310 of 311: the last focusable element on the page.
  A keyboard user reaches "next page" only after every row.

Constraints:
- Register is product. PRODUCT.md's bar is that an admin can answer "why is
  this person's role wrong?" from this log in under a minute.
- The table must stay operable at 320px — see PR #38, which is what made the
  three admin tables work there.
- /admin/accounts shares .log, .log__empty and the sticky-column rules in
  globals.css. Say explicitly whether a proposed change is audit-only or
  applies to both, and price it accordingly.
- Timestamps: src/app/_components/relative-time.tsx renders relative in the
  narrow layout and absolute in the wide one. Both are already there; the
  question is which earns the column and when, not whether to build something.

Judge proposals on whether an operator scanning 100 rows can find the one that
explains a lost role — not on whether the page looks calmer.
```

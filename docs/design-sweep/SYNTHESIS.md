# Design sweep — synthesis

Worktree `design-sweep-2026-08-05`, base `e5d76df`. Eighteen reviewers over nine
surfaces plus the shell: `critique` and `audit` on each of `/login`, `/account`,
`/payouts` (+ `/payouts/new`), `/payouts/[id]`, `/admin/accounts`,
`/admin/audit`, `/admin/sync`, the boundaries (`error.tsx`, both
`not-found.tsx`), and the shared primitives (`_components/`, `globals.css`).

One list, sorted by what the problem costs a user. Recurrence is recorded per
item as fix leverage, never as the sort key.

---

## Correction to the brief, before anything else

The shared preamble told all eighteen reviewers that `.st` renders at weight 400
and that this is a known open defect. It does not. `globals.css:1358` declares
`font-weight: 600`, `.st--lead` at 1414-1417 annotates itself as redundant with
it, and the label-register comment at `globals.css:236-240` records the fix.
Five reviewers independently checked and pushed back; I have verified it
directly.

`DESIGN.md:141-142` is the stale half. Nothing in this backlog may "restore" the
documented state — the fix is to the document. It is item 24.

---

## The backlog

### 1. A successful re-authorization tells the member it failed, and hands them the button again

**Cost.** A member whose EVE token died fixes it, comes back, and reads "This
character's EVE token is dead" with a fresh re-authorize link underneath. The one
thing the page exists to let them do reports as not done, so they do it again.

`src/services/accounts.ts:127-144` — `reauthCharacter` writes token fields, an
audit row and an `enqueueSync`, and never touches `contact_sync_state`.
`account/page.tsx:581` flips `showReauth` true the moment the token goes valid.
Verified by reading the service. Source: `critique-account` #1 (blocking).

**Fix.** The remedy has to clear the condition it remedies, or the page has to
stop reading a stale state as a live one. Not a schema change; the state row
already exists.

---

### 2. A dead worker reads as healthy for ninety minutes, and the page says so in prose

**Cost.** An admin opens `/admin/sync` during an outage, sees green, and reads a
sentence telling them the worker picks jobs up within a few seconds. They close
the tab. The page exists to answer exactly this question and answers it wrong for
an hour and a half.

Rows escalate at cadence + `OVERDUE_GRACE_MS` (5 min, `core/run-health.ts:32`)
while the worker line holds fresh until `STALE_AFTER_MS` (90 min,
`core/health.ts:10`). Both constants verified. The assertion is at
`admin/sync/page.tsx:145-149`. Source: `critique-admin-sync` #1 (blocking).

**Fix.** Let the worker line inherit the escalation the rows already computed: if
any row is overdue, the worker is not fresh. Constants stay.

---

### 3. A rejected inline edit throws away what was typed and closes the whole page

**Cost.** An operator repricing item 180 of a 200-item pool makes a
one-character mistake, and the rejection scrolls them to the top, closes every
disclosure, and eats the value. They start the scroll again.

`operationFailed` → `redirect(?error=)` is a full re-render.
`AppraiseForm`'s `useActionState` is the in-repo pattern that fixes it.
Source: `audit-payout-detail` #1 (blocking).

**Leverage.** Same shape governs items 5 and 4's silent-action half.

---

### 4. Eight of nine row actions on `/admin/accounts` drop focus, and the tier buttons disable themselves

**Cost.** A keyboard admin working a page of pending accounts is returned to
`<body>` after every single press, and the tier button they just pressed goes
disabled — `disabled={r.tierLocked && r.tier === t}` with
`services/admin-accounts.ts:43` setting `tierLocked: true` unconditionally. On
the one table where a wrong press deroles the wrong person.

The rule is written at `submit-guard.ts:9-13`. Source: `audit-admin-accounts` #1
(blocking), #3.

---

### 5. All four `/account` actions land in silence with focus on `<body>`

**Cost.** A member sets a main character, and nothing tells them it worked. The
control they pressed has unmounted, focus is gone, and the only evidence is a
table they have to re-read.

`setMainAction`, `unlinkAction`, `wakeSelfAction`, `unlinkDiscordAction` all end
in `revalidatePath("/account")` and all four unmount the pressed control.
`focus-heading.tsx:14-19` documents this exact failure. Source: `audit-account` #1
(blocking).

**Leverage.** Focus-destroyed-on-action is 17 actions across `/account` (4),
`/admin/accounts` (8), `/payouts/[id]` (5). The shared cause is the ternary
component swap, not a shared component — so it is 3 page-level fixes, not 17.

---

### 6. The first "mark paid" freezes the operation forever, and the page explains that only afterwards

**Cost.** An operator marks one member paid to test the flow and discovers the
operation is now immutable. The sentence warning them renders after the press.

Source: `critique-payout-detail` #1.

---

### 7. `/payouts` cannot answer "was I paid?"

**Cost.** A member opens the payouts list to check on their share and the list
does not carry their own row. They open operations one at a time.

The fix is a `where` clause on the participants query already issued at
`payout-view.ts:135-139`. Source: `critique-payouts-list` #1.

---

### 8. Searching an alt's name returns a fraction of the history, and the page calls it none

**Cost.** An admin investigating an incident searches the character name they
have, gets "No account or character named 'Zed'", and concludes nothing happened.

`audit.ts:427-432` builds `ids` from `displayAccountIds` only; the actor side
returns `{kind:"none"}`. Source: `critique-admin-audit` #2.

---

### 9. No Discord role-sync failure is recorded anywhere an admin can find it

**Cost.** Roles stop applying for one member. The audit log — the system of
record — contains no trace, because `discord-roles.ts:147` logs and skips, and
the non-transient catch at `:190-196` pushes into a local array that `/admin/sync`
truncates to five.

Source: `critique-admin-audit` #1. **Decision point:** writing new audit rows is a
persisted-data change. Flagged for the gate, not decided here.

---

### 10. Members are shown live draft amounts the service deliberately refuses them

**Cost.** A member reads a number on `/payouts/[id]` and treats it as their
payout. `payout-view.ts:376-394` exists specifically to withhold it.

Source: `critique-payout-detail` #2. Adjacent: the roster renders no
resolved/unresolved state, so its clash warning prescribes an impossible fix
(#3), and both roster notices give operator imperatives to a member audience (#5).

---

### 11. "Try again" may be structurally unable to clear a server-side error, and has never been tested succeeding

**Cost.** A member hits an error, presses the one control offered, and gets the
same screen. `reset()` re-renders the errored RSC payload; every existing retry
test keeps the table renamed away, so the success path has never run.

Fix is `router.refresh()` + `reset()`; `audit-boundaries` #1 supplies the missing
test. `critique-boundaries` #1 independently reaches the same place from the
design side. A successful retry is also silent and drops focus to `<body>` (#3).

---

### 12. Three `tone="bad"` notices are mounted with `&&`, defeating the live region they asked for

**Cost.** A screen-reader user whose action fails is returned to a page that looks
unchanged and hears nothing.

Verified: exactly three sites — `admin/accounts/page.tsx:154`,
`account/page.tsx:231`, `payouts/[id]/page.tsx:251` — against the rule at
`ui.tsx:248-259`. All three are `tone="bad"`, the only tone that interrupts.
Source: `critique-shell` #1, `audit-shell` "must survive".

**Leverage.** Three deletions. Several page reviewers described *other* notices as
`&&`-mounted; those are block-level conditionals around content that genuinely
does not exist, which is a different question — see Contradictions.

---

### 13. The Discord unlink can disarm itself under a stationary mouse

**Cost.** A member at a 641–851px window arms the unlink, the revealed cost
re-centres the button out from under their pointer, `pointerLeave` fires, and the
control disarms. This is the #112 mechanism, in the row the settled list declared
safe.

`.facts__lead` reserves no wrapping line; `align-items: center` does the rest. Fix
is `flex-basis: 100%` on the revealed cost. Source: `audit-account` #2.

---

### 14. `/login`'s scope list is the one thing on the page for the consent moment, and a member cannot read it

**Cost.** Someone deciding whether to grant access reads raw scope identifiers set
*fainter* (`--ink-faint`, 5.65:1) than the prose above them (8.79:1) — an inverted
hierarchy on the page's only real content. `esi-ui.open_window.v1` is in
`EVE_SSO_SCOPES` and is never named in the prose at all.

Fix is to invert the `<dl>`: `dt` the identifier, `dd` the plain-English sentence.
Sources: `audit-login` #2, `critique-login` #1, #4.

---

### 15. `/admin/accounts` has no way to find a person

**Cost.** An admin with forty accounts and a name cannot search for it, and
find-in-page cannot reach alts — `Disclosure`'s `as="row"` gates children on
`everOpen` and marks the row `hidden`.

Source: `critique-admin-accounts` #1.

---

### 16. At 200% zoom the accounts table and the payout roster become nine-row portholes

**Cost.** A low-vision admin gets `min(80svh, max(18rem, 100svh - 29rem))`
flooring to 288px and reads the table through a slot.

One selector, two surfaces: `.scroller--tall:has(.log--dense)`. Sources:
`audit-admin-accounts` #5, `audit-payout-detail` #4. Adjacent and separate: at
320px `/account`'s actions column sits ~550px off-screen with no
`.log--sticky-col` (`audit-account` #4), and `/payouts`' five-column list has
neither sticky column nor 40rem block (`audit-payouts-list` #3).

---

### 17. The pinned first column hides the focus ring on body-row controls

**Cost.** An admin Shift+Tabbing back to a row's `unlink` button lands on a
control parked under the pinned name column, with nothing on screen saying what is
focused — on the table where a wrong press deroles the wrong person.

The vertical axis is handled for every control; the horizontal only for header
links (`globals.css:1129-1147`). Source: `audit-shell` #1, with the widened
selectors written out.

---

### 18. None of `/admin/sync`'s three enqueue controls confirms itself, and the queued marker misattributes its own age

**Cost.** An admin presses "sync now", sees nothing near where they pressed, and
presses again. Separately, a hidden `", queued"` abuts the last-run
`RelativeTime` with no separator, so AT reads `ok, queued 3m ago` — the age
belongs to the last run, not the queue.

Fix for the second is a visually-hidden `, last run ` before `page.tsx:336`.
Sources: `audit-admin-sync` #1, #2.

---

### 19. `/admin/audit` recites a UUID two hundred times and loses the exact instant below 1056px

**Cost.** A screen-reader admin paging the log hears every row's raw id read
inside its anchor, and one destination announced under three names (WCAG 3.2.4). A
sighted admin below 1056px cannot recover the absolute timestamp at all — no
`title`, and the comments claim the breakpoint is 40rem.

Sources: `audit-admin-audit` #3, #2, #1 (Details truncates to ~14 mono characters
below 640px with no `title`), `critique-admin-audit` #6.

---

### 20. `/payouts`' future-date guard is client-only, and a repeated rejection is announced to nobody

**Cost.** `e2e/payouts.spec.ts:622-629`'s `bypassClientGuard` strips `max` by
name, so nothing server-side stops a future-dated operation; `today` is computed
in UTC, which mis-dates late-night fleets. A member retrying the same bad input
gets a region that never changes.

Sources: `audit-payouts-list` #1, #2, `critique-payouts-list` #4.

---

### 21. The nav's membership changes between sections, so some destinations have no door

**Cost.** An admin on `/admin/audit` who wants the payouts list has no link to it
anywhere in the chrome.

Eight hand-copied arrays; `error.tsx:37-39` already asks a future editor to keep
two of them in step by hand. Source: `critique-shell` #2.

---

### 22. `.dim` changes font size as well as colour, and the class written to fix that has zero callers

**Cost.** In the audit log's action column, `payout.` renders at 13px and
`create` at 14px inside one anchor.

Verified: `.dim-ink` is declared once (`globals.css:1327`) and referenced nowhere;
`.dim` is applied 60 times. Source: `critique-shell` #4, wanted independently by
`/admin/audit`, `/payouts`, `/payouts/[id]`.

---

### 23. Typographic drift in the shell: nine shipped sizes against six declared, a third hit-target height, a 17px sort link, a prose-faced state badge

**Cost.** Each is small on its own; together they are the system quietly ceasing
to be a system. Sharpest: the admin pending count — the number the whole shell
exists to point at — renders in 15px Archivo 400 beside its own 11px mono 600
label, and dimmer than it.

Sources: `critique-shell` #6, #5, #3; `audit-shell` #2 (33.05px nav link against
28px sign-out, both measured), #5.

---

### 24. Record fixes

- `DESIGN.md:141-142` — the `.st` weight defect is fixed; delete the parenthetical.
- `--danger-quiet` (6 call sites) exists in CSS and in no document.
- `globals.css:2073-2077` — the reduced-motion comment states a mechanism the
  stylesheet does not implement. Harmless today, a trap for the next author.
- `ui.tsx:159-162` / `globals.css:392-394` — the sign-out hairline comment claims
  a parity that is half false.
- `e2e/admin.spec.ts:735-737` is stale against the same `.st` fix.

---

## Deferred as cosmetic (named, not deleted)

Oversized images without `sizes`/priority on `/account` and `/login` (the 82 KB
seal is the LCP element); `<caption>` prose length on `/account`;
`.launch__foot`'s sixth type size; `.escalation`'s 1.00:1 ground; `Tone`'s missing
docblock; `RuleHead`'s dead `as="span"` default; duplicate pagers on `/admin/audit`.

---

## Contradictions between reviewers

**The `&&`-mounted `Notice` count.** Five page reviewers reported notices as
`&&`-mounted; `critique-shell` says three, and I verified three. Both are
describing something real: the three inline `{x && <Notice>}` sites defeat a live
region that would otherwise pre-exist its text. The block-level conditionals the
page reviewers flagged wrap notices whose *content* genuinely does not exist
otherwise, and the reserved slot cannot help those. `critique-shell` is better
argued and is the one to act on; the page-level version is a real but different
finding — those notices arrive through a navigation, and `audit-shell` names
settling that as unresolved.

**Whether the missing `loading.tsx` is a defect.** My Phase 0 brief implied it was.
`critique-boundaries` #7 overturns that with an argument I accept: no page render
makes an external HTTP call, and a root `loading.tsx` would blank the chrome
because `SiteHeader` is per-page. The exception it names — `/admin/*`, whose chrome
lives in `admin/layout.tsx` — stands as the only real gap.

**Unadjudicated, carried to the gate:** whether the nav should offer every section
or deliberately offer one door out (item 21). Both are defensible; the harm is the
current third state. This is a DESIGN.md decision, not a CSS one.

---

## What nobody covered

`src/app/page.tsx` and `src/app/admin/page.tsx` (pure redirects) and eight route
handlers, excluded in Phase 0 as having no rendered output. Rendered glyph
metrics and WebKit's `scroll-margin` behaviour during sequential focus navigation
— both need a browser the sweep excluded. Whether any `role="alert"` inserted
during reconciliation is actually announced: no jsdom, so it is a Playwright plus
real-AT question, asserted by the codebase in two places and taken as given.

---

## Proposed command chain

The top of this backlog is not command-shaped, and that is worth saying plainly:
items 1, 2, 3, 4, 7, 8, 9 and 11 are logic defects, not design ones. No impeccable
command fixes them. They go to the catalog agents. The impeccable commands come
after, once the shared call sites have stopped moving.

Shared primitives first, since every later pass touches those call sites.

| # | Step | Clears |
|---|---|---|
| 1 | Delete the guard at the three `&&` `Notice` sites | 12 |
| 2 | `$impeccable harden` on `_components/` + `globals.css` core | 17, 22, part of 23 |
| 3 | `frontend-dev` + `sync-engine-dev`: `/account` re-auth round trip | 1 |
| 4 | `frontend-dev`: `/account` four silent actions, unlink self-disarm | 5, 13 |
| 5 | `sync-engine-dev`: `/admin/sync` worker freshness inherits row escalation | 2 |
| 6 | `frontend-dev`: `/admin/sync` enqueue confirmations + queued/last-run separator | 18 |
| 7 | `frontend-dev`: `/payouts/[id]` rejected edit via `useActionState` | 3 |
| 8 | `frontend-dev`: `/admin/accounts` tier disable + focus on 8 actions | 4 |
| 9 | `$impeccable harden` on `/admin/accounts` and `/admin/audit` | 15, 19 |
| 10 | `$impeccable responsive-design` on the porthole surfaces | 16 |
| 11 | `$impeccable typeset` on `globals.css` | 23 |
| 12 | `$impeccable ux-writing` + `bolder` on `/login` | 14 |
| 13 | Record fixes to `DESIGN.md` and the stale e2e comment | 24 |

`npm run typecheck && npm run lint && npm run format:check` between every step;
`npm test` after each code step. A failure stops the chain where it broke.

**Left for a second pass, deliberately:** items 6, 10, 20, 21 (blocked on the nav
decision), and everything under Deferred. Item 9 needs the persisted-data
decision before it can be scheduled at all.

All of these, plus what the post-chain `my:polish-core` pass found and left, are
consolidated in **`SECOND-PASS.md`** — read that rather than reconstructing the
open set from this document. The heaviest item there is not from this backlog at
all: `discord-roles.ts` drops the audit record of role changes that succeeded
before a mid-loop failure, found only by reviewing the chain's own diff.

**Stop-and-ask points already identified:** item 9 (new audit rows), item 21 (the
nav rule), and anything in step 3 or 5 that turns out to want a schema change.

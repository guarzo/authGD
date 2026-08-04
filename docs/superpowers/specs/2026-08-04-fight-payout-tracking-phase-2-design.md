# Fight payout tracking — phase 2

**Status:** designed, not implemented
**Date:** 2026-08-04
**Follows:** `2026-08-03-fight-payout-tracking-design.md` (phase 1, shipped as PR #65)

Phase 1 made the numbers recorded. Phase 2 makes them pleasant, and pays down
what phase 1 knowingly deferred. One PR, matching how phase 1 shipped.

## What phase 1 left, and what is actually left

The phase-1 handover listed six phase-2 items. One of them is already done.

**Multiple pools per operation already works end to end.** `addAppraisedPool`
and `addFlatPool` (`src/services/payout-loot.ts:38`, `:101`) plain-`INSERT` a new
`loot_pool` row on every call with no uniqueness check; the detail page renders
both add-pool forms unconditionally under `canEdit`
(`src/app/payouts/[id]/page.tsx:277`, `:301`) and maps over every pool (`:180`);
`recalculate` sums all of them (`src/services/payouts.ts:333`), as does
`getPayoutOperationDetail` (`src/services/payout-view.ts:165`). It is a test gap,
not a feature gap. Phase 2 adds the missing multi-pool test and builds nothing.

So the remaining work is: manual/type-ahead participant entry, per-item price
override, revert-a-payment, the account-page "your payouts" section, the
open-info express path, and all nine deferred defects.

## Invariants inherited from phase 1

Unchanged, and enforced by tests that fail loudly on regression. Constraints, not
preferences.

1. Money is exact end to end — native `bigint` ISK-cents against
   `numeric(20,2)`. `Number()` never touches a money value on read or write.
2. Round once at the line total, never per unit before multiplying.
3. The service layer is the authorization boundary. `requirePayoutOperator` is
   the first statement inside each mutating export's transaction.
4. Lock, then read. Anything deciding on a row re-reads it after
   `SELECT … FOR UPDATE`.
5. Finalization freezes; one recorded payment freezes the roster permanently.
6. Every state change writes an audit row targeting the operation uuid.
7. `src/core/` stays pure. Migrations are generated, never hand-written.

Phase 2 amends exactly one phase-1 decision — the immutability of `paidAmount`
on the revert path. That amendment is argued in full below.

## Derived payment state: `paidAmount`, not a fold of events

The phase-1 design says a participant's state is "the fold of its events"
(`…-design.md:310`), and `payout-view.ts:73-79` carries a comment saying the
existence check it uses today holds only until `reverted` rows exist. The
obvious phase-2 move is to implement that fold, ordering by
`payout_payment.at`.

**That fold, ordered by the `at` column as it stands today, is unsafe.**

`payout_payment.at` is `defaultNow()` (`src/db/schema.ts:327`), and Postgres'
`now()` is *transaction start* time, not commit time. Two transactions touching
one participant serialize on the operation row lock, but a transaction that
starts earlier can acquire the lock later:

```
T_pay    starts 0.60, takes the lock, inserts at=0.60, commits
T_revert starts 0.50, blocks on the lock, then proceeds, inserts at=0.50

fold by `at`  ->  revert(0.50), pay(0.60)  ->  reads "paid"
what happened ->  paid, then reverted      ->  is unpaid
```

`payout_payment.id` is `defaultRandom()` (`schema.ts:321`), so it is no tiebreak
either.

**The fix is the timestamp, not a sequence column.** `defaultNow()` is only a
*default*. Both writers can supply `at` explicitly, and both already hold the
operation row lock when they insert, so phase 2 writes `at` as
`clock_timestamp()` from inside the lock. Replaying the trace above, `T_revert`
takes its clock reading *after* it acquires the lock, which is after `T_pay`
committed — so it records the later time. Any two payment rows ever compared
belong to the same operation and are serialized by that same lock, which makes
this ordering total everywhere it is used.

Residual risk, stated rather than hidden: a backwards system-clock step could
still invert two events, and two rows could in principle land in the same
microsecond. **Display order is `(at asc, id asc)`, and among exact ties it is
arbitrary.** Rows written before phase 2 used `now()`, but no participant can
have more than one of them — `recordPayment` short-circuits on
`paidAmount !== null` (`payouts.ts:440`) and nothing cleared it until revert
existed — so no pre-existing pair can be mis-ordered against each other.

This needs no migration, and it does make the fold *possible*. Phase 2 still does
not fold.

**Decision.** `paidAmount` is the source of truth for derived payment state.
`recordPayment` sets it, `revertPayment` clears it, both under the operation row
lock, so it cannot disagree with itself. `payout_payment` remains the
append-only history of who did what and when: displayed in the order above, never
folded into a decision. The fold would now be correct, but it is a per-participant
ordered scan to answer what one already-locked column answers directly, and
carrying both invites them to drift apart.

Both existing call sites change from "has a paid row" to `paidAmount !== null`
(`payout-view.ts:77` and `:161`). This is also what keeps `recordPayment`'s
idempotence check (`payouts.ts:440`) correct after a revert — without clearing
`paidAmount`, a reverted participant could never be paid again, which defeats
the entire feature.

**What this gives up.** Phase 1 called `paidAmount` immutable. It is no longer
immutable on the revert path. Its purpose was to stop *recalculation* rewriting
what was paid, and that still holds absolutely: `recalculate` writes only
`amount` (`payouts.ts:350-356`) and never touches `paidAmount`. A revert is a
deliberate, audited, operator-initiated correction — the one case where "what
was paid" genuinely changed, because it turned out nobody was paid.

## Revert does not un-freeze

`hasPayments` (`payouts.ts:51`) keeps counting **every** `payout_payment` row
regardless of `kind`. Once money has moved, loot pools, participant `shares`,
`excluded`, and `corpSharePct` stay frozen forever. Reverting corrects the
record of who was paid; it does not reopen the numbers.

This is deliberate, and it costs nothing operationally, because **paying is not
an edit**: `recordPayment` never calls `assertEditable`. The case revert exists
for — "I marked the wrong person paid" — is fully served by reverting the wrong
participant and paying the right one, both of which work while frozen.

The alternative considered and rejected: making `hasPayments` a fold so that
reverting everyone reopens the operation. That would let an operation which took
real ISK have its loot total rewritten afterwards — the aa-payout failure mode
phase 1 was built to prevent, reached through a different door.

The detail page must say this, since it is permanent and not obvious: reverting
does not reopen editing.

## New service exports

Three, each opening with `requirePayoutOperator` inside the transaction, then
`lockOperation`. Each joins the authorization loop in
`tests/payouts-service.test.ts`, taking it from 11 mutating exports to 14.

### `addParticipant(dbtx, actor, operationId, entry)`

In `src/services/payouts.ts`. Additive — `setRoster` deletes the entire roster
and reinserts (`:218-233`), so it cannot be reused to add one person. Calls
`assertEditable`.

Two behaviours the paste path gets for free and this one must reproduce:

- **Collapse alts.** If the resolved account already has a participant row on
  this operation, append the new name to `sourceCharacters` instead of inserting
  a second row. Otherwise one human draws two full shares. This is
  `resolveRosterNames`' `entryByAccountId` collapse (`:185`) applied against rows
  already in the table rather than within one paste.
- **Reject duplicate unresolved names** (defect 6), case-insensitively. Phase 1
  only *warns* about this on the page (`[id]/page.tsx:86-97`). Manual entry is
  what makes it reachable, so manual entry is where it gets prevented. The page
  warning stays as a backstop for rosters that predate the guard.

### `revertPayment(dbtx, actor, participantId)`

Appends a `payout_payment` row with `kind: 'reverted'` and the amount being
reverted, clears `paidAmount`, writes a `payout.payment_reverted` audit row.

Requires the operation `finalized` and the participant currently paid
(`paidAmount !== null`), both re-read after `lockOperation`. Deliberately does
**not** call `assertEditable` — a revert is not an edit, and calling it would
make revert impossible, since the first payment freezes the operation.

### `setItemPrice(dbtx, actor, itemId, unitPrice)`

In `src/services/payout-loot.ts`, next to the pool writers it has to keep
consistent. Sets `priceSource: 'manual'`, recomputes the item's `totalValue`,
then re-derives the pool's `totalValue` from its items exactly as
`addAppraisedPool` does (`payout-loot.ts:35`), then `recalculate`.

Calls `assertEditable`: it moves money.

**Precision: manual prices are exactly two decimals.** `unitPrice` is
`numeric(20,2)` (`schema.ts:280`), so two decimals is what the column can hold.
The action parses the operator's input to a cents `bigint` with `iskToCents` and
**rejects more than two decimal places with a readable message** rather than
silently rounding a number someone typed deliberately.

The payoff is that invariant 2 has nothing to round: `totalValue` is
`unitPriceCents × qty`, an exact `bigint` product. Rounding once at the line total
is the rule for *derived* prices; a manual price is already at cent precision, so
per-unit and line-total rounding coincide and there is no error to scale.

This leaves manual and appraised items deliberately inconsistent, and the
inconsistency is worth naming so nobody "fixes" it: for an appraised item,
`unitPrice` is a lossy 2-decimal rendering of a sub-cent market price while
`totalValue` is computed from the full-precision one, so `unitPrice × qty` does
**not** reproduce `totalValue` (this is what phase 1's sub-cent warning,
`[id]/page.tsx:194`, is telling the operator). For a manual item the two agree
exactly.

**Consequence, accepted:** a sub-cent unit price cannot be entered by hand. An
operator repricing a heap of near-worthless ammo at 0.004 ISK has no way to say
so, and entering 0.01 would inflate it 2.5×. The escape hatch is the flat-total
pool, which takes a pool value directly and does not go through per-item pricing.
Overrides exist mainly for items the appraisal could not resolve — which are
typically valuable, not sub-cent — so this is the rare case, and supporting it
properly would mean a wider column, a migration, and a second stored
representation of "the price the operator typed".

**Bound:** reject a computed line total, or a re-derived pool total, that would
fall outside `numeric(20,2)`'s range, with a readable message. See defect 9's
magnitude bound below — this is the same failure reached from the other side.

`rawPaste` is kept verbatim precisely so re-appraisal stays possible
(`…-design.md:87`), and an override does not disturb it.

## Pagination

`listPayoutOperations` (`payout-view.ts:29-33`) issues four queries, three of
which have **no `where` clause at all** — every `loot_pool`, every
`payout_participant`, every `payout_payment` in the database, folded in memory.
The handover calls this the single most likely thing to bite in production.

**Phase 2 leaves three queries, not four.** Once list state comes from
`paidAmount` rather than "has a paid row" (above), the participant rows already
carry the answer and the `payout_payment` query has nothing left to contribute:
it is deleted, not scoped. That is also the convenient outcome, because
`payout_payment` has no `operationId` column (`schema.ts:320-330` — only
`participantId`), so scoping it would have meant a join back through
participants to bound a query whose result is no longer read.

The remaining two child queries — `loot_pool` and `payout_participant` — are
constrained with `inArray(operationId, pageIds)`. The primary fix is that
scoping; pagination is what bounds `pageIds`.

`src/services/audit.ts:388-394` already establishes this repo's pagination
pattern — keyset, `lt(auditLog.id, beforeId)` with `orderBy(desc(id))`, a
`before` query param, and a page-size constant. Phase 2 follows it rather than
introducing offset pagination alongside it.

One difference matters. `auditLog.id` is a monotonic serial; `payoutOperation.id`
is a `defaultRandom()` uuid and the list orders by `occurredAt desc`
(`payout-view.ts:42`), which is **not unique**. A bare `occurredAt` cursor would
skip operations sharing a date across a page boundary. The cursor is therefore
composite:

```
occurredAt < cursor.occurredAt
  OR (occurredAt = cursor.occurredAt AND id < cursor.id)
```

Postgres' uuid ordering is arbitrary but stable, which is all a tiebreak needs.

`src/app/admin/audit/page.tsx:36` records a lesson that carries over: a cursor
from a wider query is meaningless once the query narrows. Phase 2 adds no filter
to this list, but any future one must drop `before`.

## The open-info express path

Phase 1 deferred this as a stop-and-ask. **Decision: add
`esi-ui.open_window.v1` to `EVE_SSO_SCOPES` globally.** This was raised with the
rollout cost below stated explicitly, and reaffirmed.

The scope belongs to the token making the call — the **paying operator's**
character, not the recipient's. So the Open-info control is gated on the
operator's own persisted `character.scopes` (`schema.ts:69`), never on config:
existing tokens do not carry the new scope and will not until their holder next
logs in.

### Rollout consequence, stated so it is not a deploy-day surprise

Four places compare a character's granted scopes against `cfg.eveSso.scopes`.
Adding a scope makes all four fire for every existing character:

- `src/jobs/token-health.ts:103` — `covered` goes false for every character,
  flipping each to `needs_reauth` and writing one `token.needs_reauth` audit row
  (`:115-121`).
- `src/services/accounts.ts:106` — `tokenFields` reports the same for every
  character it loads.
- `src/services/account-view.ts:169,182` — every member's account page shows a
  re-authorize warning.
- `src/services/account-view.ts:250,275` — every row in the admin table is
  flagged. The comparison lives here, not in the page:
  `src/app/admin/accounts/page.tsx:285` only renders the field this computes.

**Sync does not break.** `src/jobs/contacts.ts:13-29` gates per job, and
`tests/contacts-job.test.ts:90-92,203-210` pin that a `needs_reauth` character with
contact scopes granted still syncs. This is a fleet-wide false alarm that
self-heals as members log back in, not an outage.

An alternative was considered and declined: splitting `EVE_SSO_SCOPES` into
required and optional sets, so the new scope is requested at login but excluded
from those three predicates. It would have avoided the false alarm at the cost
of three predicate changes and a new config var. Recorded here so the choice is
revisited on evidence rather than re-litigated from scratch.

**No change to the OAuth state flow, the callback, or PKCE handling.**

### The call itself, and a second architectural exception

`POST /ui/openwindow/information/?target_id=` is called from a server action,
using the operator's **main character's** token via the existing decrypt-and-
refresh path in `src/services/tokens.ts`. A window opens on whichever client
that character is logged into; if they are not logged in, ESI returns an error
and the page says so.

This extends the "enqueue, don't execute" exception phase 1 recorded for
appraisal (`…-design.md:366`), and the extension needs stating because the
original justification was *read-only and idempotent*, and this call is neither
by the strict reading — it is a `POST`.

It is safe on the same grounds regardless: it mutates **no persisted state**, at
CCP or here. Its entire effect is a window appearing on a game client. A
duplicated call opens the window twice; a lost call opens nothing and the
operator clicks again. There is no record to corrupt. The sync jobs the rule
exists to protect are, once again, none of those things.

The control renders only when the operator's main character's persisted
`scopes` include `esi-ui.open_window.v1`, and only alongside Copy amount on a
finalized operation. Copy amount and Mark paid remain scope-free, so an
operator without the scope loses nothing phase 1 gave them.

## UI surfaces

All in `src/app/`.

**`/payouts`** — an "older" link driven by the composite cursor, matching the
audit page's.

**`/payouts/[id]`, loot** — per-item override needs an item table that does not
exist yet. The page currently reads `pool.items` only to compute the unresolved
(`:186`) and sub-cent (`:194`) warnings; no item is ever rendered. Phase 2 adds a
per-pool item table with an inline price form per row, behind the existing
`Disclosure` component so a 200-line paste does not bury the roster. Both
warnings stay — they are the fast path for "what needs attention"; the table is
the fix.

**`/payouts/[id]`, roster** — an add-participant form beside the paste form,
with a `<datalist>` of known character names. The browser does the filtering:
no endpoint, no client component, no new authorization surface, and it works
without JavaScript. This fits a codebase whose only client components are
`copy-amount-button`, `submit`, `scroller`, `disclosure`, `confirm-submit`,
`admin-nav`, and `relative-time` — none of which fetch data.

**Assumption, flagged for checking against production:** character count is in
the hundreds, not tens of thousands. The name list ships with the page. The
implementation caps the datalist and falls back to plain free text past the cap,
so exceeding it degrades rather than breaks — but if the real count is large,
the design should move to a server action behind a client component.

**`/payouts/[id]`, payments** — a revert control on paid participants, plus each
participant's payment history, which is currently stored and never shown. History
renders in `(at asc, id asc)` order, which the `clock_timestamp()` rule above
makes causally correct for any two rows on the same operation. The freeze notice
must state that reverting does not reopen editing.

**`/account`** — the "your payouts" section: operation name, date, amount owed,
paid state.

**Finalized operations only.** A draft's roster and loot are still being edited,
so its `amount` moves — and the phase-1 `recalculate` rewrites it on every roster
or pool change. Presenting a moving number to a member under the heading "amount
owed" states a commitment the operation has not made, and a member who checks
twice would see two different figures with no explanation. Finalization is
already the point at which the numbers stop moving, and it is already the
precondition for payment (`revertPayment` and `recordPayment` both require it),
so it is the honest cutoff. The cost is that a member cannot see a payout coming
before it is final, which is the correct trade: nothing is owed yet.

Rows link through to `/payouts/[id]` **only** when the viewer passes
`canReadPayouts` (`payouts.ts:33`, tier `flygd`, any status); otherwise the row
renders as plain text.

This asymmetry is from the phase-1 design (`…-design.md:400`): reading your own
history needs only a session, but reading an *operation* needs `flygd`. A member
demoted to `blue`/`green` or moved to `cryo` still gets the answer to "did I get
paid for that Thursday roam" without regaining access to the operation. Always
linking would give them a link that silently redirects to `/account`.

**Known limitation, by construction.** Matching a viewer to their rows goes
through `payoutParticipant.accountId`, which is `NULL` for anyone whose name did
not resolve at paste time. A member pasted under an unlinked alt spelling will
not see their own payout. This is inherent to a model that must record people who
have no authGD account at all (`…-design.md:114`), and phase 2 does not change
it.

## Deferred defects

All nine from the handover are in scope.

| # | Defect | Fix |
| --- | --- | --- |
| 1 | `listPayoutOperations` does four unbounded queries | Drop the payment query, scope the other two, keyset pagination (above) |
| 2 | `shares` is `numeric(6,2)`; >9999.99 is a raw Postgres error | Reject `shares > 9999.99` with a readable message in `setParticipantShares` and its action, beside the existing `<= 0n` guard (`actions.ts:224`). **Not** a column widening — that would need a migration for a message |
| 3 | Zero-quantity paste lines dropped silently | Keep dropping them (phase 1's lenience is deliberate and matches blank-line handling), but return them so the page can name what it ignored |
| 4 | `computeSplit` does no input validation | Reject negative `totalCents` and `corpSharePct` outside 0–100 |
| 5 | `recordPayment` / `loadParticipantOperationId` throw bare `Error` | `PayoutNotFoundError`, joining `PayoutForbiddenError` / `PayoutLockedError` |
| 6 | Identical unresolved names not deduped | Prevented in `addParticipant` (above) |
| 7 | `perShareCents` returned and consumed nowhere | Drop it from `SplitResult` |
| 8 | `loot_item_qty_ck` / `loot_item_price_ck` only partly tested | Phase 1 already covers both **through `addAppraisedPool`** (`tests/payout-loot.test.ts:374-428`), so the original "untested" reading was stale. What is left: direct-insert coverage matching `payout-schema.test.ts`'s style, and the `totalValue < 0` half of `loot_item_price_ck`, which nothing currently reaches |
| 9 | Parser edge cases | See below — three parts: one fixed, one bounded, one deliberately left |

Defect 4 is defence in depth — the DB check constraints already catch it at
persist time.

**Defect 9, in three parts.** A line that is only a quantity (`"12"`) is currently
absorbed as an item named `12`, which is a silent wrong answer: it becomes a
zero-priced unresolved row rather than an obvious mistake. It joins defect 3's
reported-and-dropped set.

**An absurd-magnitude quantity is bounded.** A long digit run parses through
`parseQty` (`loot-paste.ts:10-12`, a bare `Number()`) to a finite but non-safe
integer, and today it dies downstream as a raw Postgres overflow rather than a
readable error. Two distinct bounds, because they fail differently:

- **Quantity — `Number.MAX_SAFE_INTEGER`.** `lootItem.qty` is
  `bigint(… { mode: "number" })` (`schema.ts:278`), so beyond 2^53 the value is
  already wrong in JavaScript before Postgres ever sees it. This is a
  correctness bound, not a taste bound, which is why it is that number and not a
  game-flavoured cap. Over it, the line joins the reported-and-dropped set.
- **Line and pool totals — the `numeric(20,2)` range.** A safe-integer quantity
  can still overflow `totalValue`, and the sum of items can overflow the pool's.
  Both are checked in `payout-loot.ts` and rejected with a readable message, in
  the same place as `setItemPrice`'s bound above.

The regexes only ever match digits (`loot-paste.ts:4-8`), so nothing but
magnitude can get through this path.

`"12xFoo"` with no space is **left as a literal name, deliberately.** Reading it
as "12 of Foo" guesses at intent, and `x` without a separator is genuinely
ambiguous against real EVE type names. Phase 2 documents this rather than
changing it; a paste in that shape is not a format the game produces.

Defects 3 and 9's first two parts feed one mechanism: `parseLootPaste` returns its
dropped lines alongside its items, and the appraisal form renders them as "N lines
ignored", naming each and why. Nothing is rejected wholesale, so a mostly-good
paste still appraises — matching phase 1's choice not to fail a whole paste on one
bad line.

## No migration

Everything phase 2 needs already exists in the schema. `priceSource: 'manual'`
and `payout_payment_kind: 'reverted'` are both already enum members — phase 1
anticipated both behaviours without building them. Defect 2 is fixed with a
readable guard rather than by widening the column.

Two decisions above were each the point where a migration would otherwise have
been reached for, and each was answered without one: payment ordering takes
`clock_timestamp()` under the existing lock instead of a monotonic sequence
column, and manual prices are held to the two decimals `numeric(20,2)` already
provides instead of widening it. Both are recorded with what they give up.

`drizzle/` is untouched. There is nothing to run against production data, and
the release-command migration step on deploy is a no-op for this PR.

## Code layout

Modified:

- `src/services/payouts.ts` — `addParticipant`, `revertPayment`,
  `PayoutNotFoundError`
- `src/services/payout-loot.ts` — `setItemPrice`
- `src/services/payout-view.ts` — keyset pagination, scoped child queries,
  `paidAmount`-derived state
- `src/core/payout-split.ts` — input validation, drop `perShareCents`
- `src/core/loot-paste.ts` — return dropped lines alongside items (defects 3, 9)
- `src/services/appraisal.ts` — carry the dropped lines through to the caller
- `src/lib/esi/client.ts` — add `openInformationWindow`, following the
  injectable-`fetch` pattern `resolveIds` and `postAffiliation` already use
- `src/config.ts` — `esi-ui.open_window.v1` in `EVE_SSO_SCOPES`
- `src/app/payouts/page.tsx`, `src/app/payouts/[id]/page.tsx`,
  `src/app/payouts/actions.ts` — the UI surfaces above
- `src/app/account/page.tsx` — "your payouts"

Unchanged: `src/db/schema.ts`, `drizzle/`, `src/worker/`, `src/jobs/`,
`src/app/auth/`. No new runtime dependencies. No new secrets.

## Testing

Grouped by what would otherwise regress.

**Money**

- `setItemPrice` computes `totalValue` as an exact `unitPriceCents × qty` product,
  asserted against a hand-computed value at a quantity large enough that a
  floating-point route would drift.
- `setItemPrice` rejects an input with more than two decimal places, rather than
  rounding it.
- `setItemPrice` and the pool writers reject a line or pool total outside
  `numeric(20,2)` with a readable error, not a Postgres one.
- `computeSplit` input validation (defect 4).
- `loot_item_qty_ck` / `loot_item_price_ck` reject as intended on **direct
  insert**, and `loot_item_price_ck` rejects a negative `totalValue` — the two
  gaps phase 1's through-`addAppraisedPool` tests leave open (defect 8).

**Freeze and revert**

- Revert clears `paidAmount` and the participant can then be paid again.
- Revert does **not** reopen editing — `assertEditable` still rejects. This pins
  the decision above so a later change has to argue with a test.
- `recalculate` after a revert still never writes `paidAmount`.
- A pay → revert → pay sequence on one participant yields three history rows with
  strictly increasing `at`, ordered as they happened. This is the test that pins
  `clock_timestamp()`; reverting to `defaultNow()` inside one test transaction
  collapses all three to the same instant and fails it.

**Authorization**

- The loop in `tests/payouts-service.test.ts` covers 14 mutating exports.

**Roster**

- `addParticipant` collapses an alt into an existing participant rather than
  creating a second share.
- `addParticipant` rejects a case-insensitively duplicate unresolved name
  (defect 6).
- Zero-quantity paste lines produce a signal (defect 3).
- Parser edge cases (defect 9).

**Pagination**

- Page 2 does not drag page 1's pools or participants into memory — asserted
  against the scoped queries, not just the returned shape.
- The list reports paid state correctly with no `payout_payment` query in play,
  including for a participant whose only rows are a `paid` and a later
  `reverted` — the case the deleted query got wrong.
- The composite cursor does not skip operations sharing an `occurredAt`.

**Account view**

- A draft operation the viewer is on does **not** appear in "your payouts"; it
  appears once finalized.
- Payment history renders oldest-first for a pay → revert → pay participant.

**Multi-pool**

- Two pools on one operation sum correctly through `recalculate` and
  `getPayoutOperationDetail` — the test that should have existed in phase 1.

**Express path**

- `openInformationWindow` via msw: the success path, a non-2xx, and a timeout,
  matching how `tests/` already covers the triff client.
- The control is hidden when the operator's main character lacks
  `esi-ui.open_window.v1`, and shown when it has it — driven by the persisted
  `character.scopes` row, not by config.

**E2E**

- Override an item price, finalize, pay, revert, pay again.
- The account-page section for a member who is no longer `flygd`: row visible,
  no link.

## Environment notes for implementers

- `npm test` shares one database across worktrees. Use
  `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_<name>`.
- `npm run test:e2e` self-isolates, but its derived port can collide with
  another worktree's stale container; `E2E_DB_PORT=<port>` is the override.
- Running the dev server, including the one Playwright boots, rewrites the
  tracked `tsconfig.json` and `AGENTS.md`. Both are tracked — recover with
  `git checkout`, never delete. Never `git add -A` after an e2e run.
- CI runs `format:check` (`prettier --check .`) over the whole repo; checking
  only changed files will pass locally while CI fails.

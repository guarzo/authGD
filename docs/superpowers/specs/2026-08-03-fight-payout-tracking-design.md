# Fight payout tracking

**Status:** design approved, not yet implemented
**Date:** 2026-08-03

## The gap

After a fight, someone loots the field, appraises it, splits it by headcount, and
pays everyone. Today that split happens in **PayGD**, a tkinter desktop
calculator: paste the loot, type the headcount, tick a box if there was a scout,
read the per-person number off the screen. It works. It stores nothing.

The moment the window closes there is no record of who was owed what, no record
of who was actually paid, and no way for a line member to check either. The FC
keeps it in their head or in a Discord message. That is the gap — **recording,
not calculating**.

Alliance Auth's `aa-payout` plugin does record it, and this design borrows its
data model while deliberately not borrowing its architecture. It is the prior art
this spec reacts to, not a template to port.

### What we take from aa-payout

- Corp share taken off the top before the per-person split.
- Scouts as a share *multiplier* (its migrations 0006/0007 replaced an earlier
  "+10% flat" bonus with `scout_shares`, defaulting to 1.5 — its own README and
  CLAUDE.md still document the flat version, two designs behind the code).
- Payment state tracked per person, not just per operation.
- Exact decimal arithmetic throughout with an explicit rounding mode.

### What we deliberately reject

| aa-payout behaviour | Why we don't |
|---|---|
| `helpers.py:122-130` — if a share falls under `AAPAYOUT_MINIMUM_PER_PARTICIPANT`, return `[]` and silently give 100% to corp, logged only | A payout that silently becomes zero for everyone is indistinguishable from a bug. We have no minimum. Small shares are small. |
| `helpers.py:302-306` — `create_payouts()` deletes **all** `Payout` rows, including ones already marked paid and verified, then rebuilds. The `regenerate_payouts` view calls it directly. | Recalculating must never be able to erase who was paid. We prevent this structurally (see *Recalculation safety*). |
| `helpers.py:501` — `get_main_character_for_participant()` can hit live ESI inside the dedup loop (N+1 during calculation) | authGD already knows alt→main via `character.accountId` → `account.mainCharacterId`. Dedup is a local join. |
| ESI fleet import (`ESIFleetImport` model) | `GET /characters/{id}/fleet` only returns data while the character is *currently* in a fleet. By payout time the fleet is disbanded. It cannot work, independent of the OAuth cost. |
| `views.py` — 2256 lines of HTTP and business logic in one module | Split math lives in `src/core/`, pure and table-tested. |
| Wallet-journal reconciliation (`services/esi_wallet.py:86`) — matches on `ref_type == 'player_donation'` + `second_party_id` + amount within 24h, first match wins | Two people owed identical amounts collide. Out of scope; mark-paid is manual and honest about being manual. |

## Scope

**In:** recording an operation, valuing one or more loot pools, building a
per-person roster, computing the split, and tracking who has been paid.

**Out:** ESI fleet import (impossible, above), wallet reconciliation (unreliable,
above), automated ISK transfer (no ESI endpoint exists — the API is read-only for
wallets), Janice as a price source (see *Pricing*).

## Model

### Operation

One fight. Named, dated, optionally linked to a battle report.

```
payout_operation
  id, name, occurredAt, battleReportUrl, createdBy,
  corpSharePct, status, notes, createdAt
```

`status` is `draft | finalized`. Draft is freely editable; finalizing is what
makes the numbers a commitment (see *Recalculation safety*).

### Loot pools — N per operation

An operation can have several pools valued differently: the wreck field
appraised at Jita sell, plus a capital kill sold privately for a flat negotiated
number.

```
loot_pool
  id, operationId, rawPaste, pricingMode, stationId, regionId,
  totalValue, valuationSource, appraisedAt
```

`valuationSource` is `appraised | flat`. **Flat** means someone typed a total
they negotiated; it requires a note and is displayed as manual so nobody later
mistakes it for a market number. The operation's total is the sum of its pools.

`pricingMode`, `stationId`, and `regionId` are nullable and meaningful only when
`valuationSource = appraised`; a flat pool has no market context to record. A
flat pool likewise has no `loot_item` rows — `rawPaste` may still hold what was
in the field, but nothing was priced line by line.

`rawPaste` is kept verbatim. It is the only way to re-appraise later at a
different price point, and the only evidence of what was actually in the field.

```
loot_item
  id, poolId, typeId, name, qty, unitPrice, totalValue, priceSource
```

`priceSource` is `triff | manual | unresolved`. PayGD lists unresolved items and
then **silently excludes them from the total** — a genuine money bug. Here an
unresolved item is a visible zero-priced row with a per-item price override, so
the operator either prices it or consciously leaves it out.

### Participants — per person, not a headcount

```
payout_participant
  id, operationId, accountId, recipientCharacterId, displayName,
  sourceCharacters (jsonb), shares, excluded,
  amount, paidAmount
```

`amount` is recomputed on every recalculation. `paidAmount` is null until
payment, then immutable — see *Recalculation safety*. Who paid and when live in
`payout_payment`, not here.

`accountId` is **nullable**: not everyone in a fleet has an authGD account, and
the payout must not be blocked on them signing up. A row with a null `accountId`
is a name and an amount, which is enough to owe someone ISK.

`recipientCharacterId` is also nullable, and is the character the ISK should
actually go to — the account's main by default, overridable per operation for
someone who wants paying on a hauler alt. It is null when the participant could
not be resolved to a known character, and becomes null if that character is later
unlinked (see *Deletion behaviour*). Either way `displayName` still names the
person: it is stored by value, and it is what the UI shows.

`shares` is `numeric` and defaults to `1`. A scout is `1.5`. This is the
`scout_shares` idea generalised — a per-participant multiplier rather than a
boolean, so an FC can pay a double share without a schema change.

`excluded` and *removing the row* are distinct actions, deliberately:

- **Excluded** — they were there, they get nothing (AFK, in a station, already
  paid separately). The row stays, visible, with a zero amount. The record of
  their presence survives.
- **Removed** — they were never in the fleet. Paste error. Row deleted.

Collapsing these into one control loses the audit trail every time an FC means
the first and gets the second.

### Invariants, in the database

These are `CHECK` constraints, not service-layer validation, because a bad row
that reaches the table is a money bug that outlives whatever wrote it:

| Table | Constraint |
|---|---|
| `payout_operation` | `corpSharePct >= 0 AND corpSharePct <= 100` |
| `payout_participant` | `shares > 0` |
| `payout_participant` | `amount >= 0`, `paidAmount IS NULL OR paidAmount >= 0` |
| `loot_item` | `qty > 0`, `unitPrice >= 0`, `totalValue >= 0` |
| `loot_pool` | `totalValue >= 0` |
| `loot_pool` | `valuationSource = 'flat'` ⟹ `notes IS NOT NULL AND notes <> ''` |
| `loot_pool` | `valuationSource = 'appraised'` ⟹ `pricingMode IS NOT NULL AND (stationId IS NOT NULL) <> (regionId IS NOT NULL)` |

The last one enforces both halves of the appraised/flat split at once: an
appraised pool has a pricing mode and exactly one of station or region (triff
accepts one or the other, never both), and a flat pool carries the note that
explains the number someone typed.

### Deletion behaviour

Payout history must outlive the identity records it references, and in this
codebase those records genuinely disappear: `unlinkCharacter`
(`src/services/accounts.ts`) hard-`DELETE`s the `character` row.

So the participant's foreign keys are **`ON DELETE SET NULL`**, never `CASCADE`
and never `RESTRICT`:

- `accountId → account.id` — `SET NULL`
- `recipientCharacterId → character.id` — `SET NULL`

`CASCADE` would silently erase a paid-out participant when someone unlinks an
alt. `RESTRICT` would make unlinking a character fail forever once it appeared in
any payout, breaking an existing flow to protect a new one. `SET NULL` keeps the
row and its amount; `displayName` and `sourceCharacters` are stored *by value* on
the participant precisely so the row still reads correctly after the character it
named is gone.

Within the feature, ownership cascades are correct and intended:
`loot_item → loot_pool`, `loot_pool → payout_operation`,
`payout_participant → payout_operation`, and `payout_payment →
payout_participant` are all `ON DELETE CASCADE`. Deleting a draft operation
should take its contents with it.

## Roster entry

Two paths, both needed:

1. **Paste** — the fleet composition copied out of Discord or the in-game
   window, in the format actually used:

   ```
   Brain Tartare / Gustav Oswaldo / Stealthbot / Tnklstheredneck Yaken / Zodicar
   ```

   Split on `/`, trim, then resolve each name against `character.name`. A
   resolved character maps through `character.accountId` →
   `account.mainCharacterId` to a **human**, and multiple alts of one human
   collapse into a single participant row — the alt names are retained in
   `sourceCharacters` so the FC can see *why* five pasted names became three
   people. Unresolved names become participants with a null `accountId`.

   This is where authGD structurally beats both prior tools: aa-payout needs
   `OwnershipRecord` lookups and live ESI to do this; PayGD cannot do it at all,
   which is why its headcount is wrong whenever someone brings an alt.

2. **Manual entry with type-ahead** — for someone who left the fleet before the
   loot was split, and so is not in anything there is to copy from. Type-ahead
   searches known characters; a free-text name is accepted for anyone else.

No ESI fleet import, and therefore **no new SSO scopes**. `EVE_SSO_SCOPES` in
`src/config.ts` is a single global string applied to every login, so adding a
scope for this feature would re-prompt every user in the alliance for a
permission almost none of them need.

## The split

Pure, in `src/core/payout-split.ts`, with no I/O and no database access — the
same shape as `src/core/tier.ts` and `src/core/role-diff.ts`.

```
corpShare    = total × corpSharePct        (ROUND_DOWN to 0.01)
pool         = total − corpShare
totalShares  = Σ shares over non-excluded participants
perShare     = pool / totalShares          (ROUND_DOWN to 0.01)
amount(p)    = perShare × p.shares         (ROUND_DOWN to 0.01)
remainder    = pool − Σ amount(p)          → corp
```

All arithmetic is exact against `numeric(20,2)` columns, rounding down at every
step, with the sub-ISK remainder falling to corp. Never `float`: PayGD uses
`float` and `round()`, which is fine on screen and wrong in a ledger.

**The exact-arithmetic mechanism is `bigint` ISK-cents**, not a decimal library.
`package.json` has no decimal dependency today, and the working agreement says to
avoid unnecessary ones. The split needs only `+`, `−`, `×`, and floor-division on
integers, which native `bigint` does exactly and without a dependency. Drizzle
returns `numeric` as a string, so the boundary is: parse string → `bigint` cents
on the way in, format `bigint` cents → string on the way out, with both
conversions in one place in `src/core/payout-split.ts` and directly tested.

(If implementation finds the ergonomics genuinely bad — percentage handling is
the likely friction — `decimal.js` is the fallback. Recording the reasoning here
so the choice is revisited on evidence rather than re-litigated from scratch.)

Rounding down is chosen so the sum of the paid amounts can never exceed the pool.
The alternative — round-half-up and let corp absorb a shortfall — can hand out
more ISK than was looted.

Edge cases the table tests must pin: zero participants (everything to corp, no
division); everyone excluded (same); `corpSharePct` of 0 and 100; a pool smaller
than the participant count (some people get 0.00 and it says so, rather than the
whole thing silently going to corp).

## Recalculation safety

aa-payout's data-loss bug comes from payouts being a separate table that gets
dropped and rebuilt. Keeping `amount` on the participant row removes the delete
step — but on its own that is **not** enough. Preserving `status` while
`UPDATE`ing `amount` on the same row means that after an unlock, a row saying
`paid` can come to claim an amount nobody ever paid. The delete-based bug is
merely replaced by a quieter one.

Three mechanisms together, none sufficient alone:

**1. `paidAmount` is immutable.** `amount` is the *computed* figure and moves
freely with recalculation. `paidAmount` is written once, at the moment of
payment, from `amount` as it stood then, and no recalculation path touches it.
Where the two disagree on a paid row, the UI shows both and flags the drift
rather than picking one. What was paid is a fact; what is owed is a calculation.

**2. Payment events, not a status field.** A `payout_payment` row per event, so
correcting a mistaken payment is an append, not an overwrite:

```
payout_payment
  id, participantId, kind, amount, at, actor, note
```

`kind` is `paid | reverted`. A participant's derived state is the fold of its
events. This is what makes "I marked the wrong person" recoverable without
destroying the evidence that it happened.

**3. Payout-affecting edits are prohibited once any payment exists.** Not
"discouraged by a status flag" — rejected in the service layer. Loot pools,
participant `shares`, `excluded`, and `corpSharePct` are all frozen. The unlock
path (below) does not lift this; it exists for correcting *unpaid* operations.

**Concurrency.** Finalize, recalculate, and pay each take `SELECT ... FOR UPDATE`
on the `payout_operation` row for the whole transaction, so two operators cannot
recalculate and pay concurrently and interleave into a state where the paid
amount came from neither calculation. This mirrors the existing row-locking in
`src/services/accounts.ts` (`findCharacterForUpdate`, the `.for("update")` on
`account` before a main-character change).

Every state change writes to the existing `audit_log` table, matching the
project's standing convention.

## Lifecycle

**Operation status** is `draft | finalized`, and the transition is **explicit
only** — a button, audited. An earlier draft also implied auto-finalization on
first payment; that is dropped, because two ways into one state is two sets of
invariants to keep consistent. Instead, **paying requires `finalized`**: the
Pay action is unavailable on a draft. Finalization is therefore something the
operator does deliberately before any money moves.

Unlock (`finalized → draft`) is available only while **no payment event exists**,
and only to the operation's `createdBy` or an admin. Once a payment exists there
is no unlock, which is mechanism 3 above stated as a state transition.

**Participant state** is derived from its payment events, not stored as an enum:

| Derived state | Meaning |
|---|---|
| `excluded` | `excluded = true`. Amount is 0.00. Not owed, not owable. |
| `unpaid` | No events, or last event is `reverted`. |
| `paid` | Last event is `paid`. |

An operation is **complete** when every non-excluded participant is `paid`.
Excluded participants are excluded from that check — otherwise, as the review
noted, a zero-value excluded row would leave every operation perpetually
incomplete. Completion is computed, not stored.

## Pricing

**triff.tools only.** The same endpoint PayGD already uses, free and
unauthenticated. It is a **`GET`** with query parameters:

```
GET https://triff.tools/api/market/quote
  ?type_ids=34,35,36          comma-joined, chunked at 900 per request
  &include_aggregates=true
  &include_orders=false
  &station_id=60003760        exactly one of station_id or region_id
```

Response, keyed by a `types` array rather than by id, so the client indexes it:

```jsonc
{ "types": [ { "type_id": 34,
               "sell": { "best": 5.10, "p05": 5.44 },
               "buy":  { "best": 4.90, "p05": 4.61 } } ] }
```

Pricing modes select into that shape exactly as PayGD does: `side = sell | buy`,
`field = best | p05` (5th percentile), station defaulting to Jita 4-4
(`60003760`).

**Failure handling.** 10-second `AbortSignal.timeout`, matching
`src/lib/esi/sso.ts`. No retry — the operator is watching and can re-click, and a
retry loop on an interactive call just extends the wait. A non-2xx, a timeout, or
a malformed body surfaces as a visible error on the appraisal form with the
pool left unvalued; it never silently produces a partial total. A `type_id`
absent from the response, or present with a null price, becomes an `unresolved`
item row at 0.00 — visible, overridable, and counted as zero only because someone
chose to leave it that way.

Janice — what aa-payout uses — is free but requires an API key, which means a new
secret in `fly.toml`, a rotation story, and a failure mode when it expires. For a
second opinion on a price we already have, that is not worth it. If triff is
down, the flat-value path is the answer: type the number, note why.

Type-ID resolution uses ESI `POST /universe/ids/`, which is unauthenticated,
added as `resolveIds` to the existing `src/lib/esi/client.ts` alongside
`postAffiliation`, following the same injectable-`fetch` pattern.

### An architectural exception, stated plainly

authGD's rule is **enqueue, don't execute**: the web process enqueues, the worker
performs external I/O. Appraisal breaks that rule — the server action calls triff
directly and returns a price.

This is deliberate. Appraisal is interactive: the operator pastes loot and waits
for a number, adjusts the pricing mode, and pastes again. Routing that through
pg-boss means polling for a result the user is actively staring at. The
justification that makes it safe rather than merely convenient: the call is
**read-only** and **idempotent** — it mutates nothing, at triff or here, so the
failure mode of a duplicate or lost call is a re-click, not a corrupted record.
The sync jobs the rule exists to protect are none of those things.

This is a precedent, so it is written down here rather than discovered later in a
diff. **No worker changes are part of this feature.**

## Access and visibility

**Mutation** — creating an operation, editing loot, editing the roster,
finalizing, recalculating, paying — requires tier **`flygd`** *and* status
**`active`**. A `cryo` account cannot mutate payouts: cryo is how this project
represents someone who has stepped away, and someone who has stepped away should
not be moving alliance ISK. There is no `isFc` flag and no migration on
`account`; alliance leadership is small and trusted, and a permissions system
nobody asked for is a system nobody maintains.

**Reading any operation** requires tier `flygd` (any status). Payouts are
otherwise **fully transparent** among members: any `flygd` member can see any
operation, its loot, its roster, and its amounts. That transparency is the
cheapest reconciliation mechanism available — the people who were in the fleet
will notice if the roster is wrong.

**Reading your own history** requires only a session. A participant who has since
been demoted to `blue` or `green`, or moved to `cryo`, keeps access to the
operations they were part of and nothing else. They were owed that ISK when they
earned it; a tier change is not a reason to hide the record of it from them.

This needs new plumbing, because `getSessionAccount` in `src/services/session.ts`
resolves a session to an `accountId` and checks neither tier nor status — every
existing caller that needs more does its own lookup. This feature follows that
pattern rather than changing the shared function: a `requirePayoutOperator` guard
in `src/services/payouts.ts` that loads the account and asserts
`tier = flygd AND status = active`.

Authorization is enforced in the **service layer**, not only in the server
action. A server action is the only caller today, but the guard belongs where the
mutation is, so a future caller cannot bypass it by not knowing it existed.

Line members additionally get a **"your payouts"** section on `src/app/account`
showing operations they participated in, what they were owed, and whether it has
been marked paid. This is the feature's answer to "did I get paid for that
Thursday roam", which is the question the current workflow cannot answer at all.

## Paying

Marking someone paid is a manual click. ESI has no ISK-transfer endpoint, and no
endpoint that opens a pre-filled transfer window either. What it actually offers
is `POST /ui/openwindow/information/?target_id=`, which opens an *information*
window on a character. That is what aa-payout uses, and it is the honest ceiling
here too.

Two consequences that are easy to get wrong:

- The `esi-ui.open_window.v1` scope belongs to the **token used to make the
  call** — the paying operator's character, not `recipientCharacterId`. It is the
  payer's client that opens a window. Checking the recipient's scopes is
  meaningless.
- Because `EVE_SSO_SCOPES` in `src/config.ts` is one global string applied to
  every login, an operator only holds this scope if it was granted globally.

So the flow is: **Open info** (if the operator's own character has the scope)
puts the recipient's information window on screen, from which the operator starts
the transfer in-client; **Copy amount** puts the exact ISK figure on the
clipboard; then **Mark paid**. The saving is the transcription of a
twelve-digit number, which is the step that actually goes wrong.

Enabling this properly needs one of two things, and this design **defers the
choice to implementation** because it is a live question rather than a settled
one:

1. **Add `esi-ui.open_window.v1` globally.** One line in `EVE_SSO_SCOPES`, but it
   re-prompts every user in the alliance for a permission only a handful need.
2. **An optional scope-grant flow** — a second, opt-in SSO authorization for
   operators who want the express path, which means `EVE_SSO_SCOPES` stops being
   a single global string. That is a change to the OAuth flow, and per the
   project's working agreement the OAuth state flow is a **stop-and-ask**
   surface.

Neither is a prerequisite. **Without either, the feature works**: Copy amount and
Mark paid need no scopes at all, and that is what PR 1 ships. The express path is
a PR 2 enhancement gated on this decision.

Marking paid appends a `payout_payment` row, stamps `paidAmount` from the current
`amount`, and writes an audit row.

## Code layout

New:

- `src/core/payout-split.ts` — the split math, pure, table-tested
- `src/lib/triff/client.ts` — appraisal, injectable `fetch`, mirroring `src/lib/esi/client.ts`
- `src/services/payouts.ts` — operation/pool/participant persistence
- `src/app/payouts/` — operation list, operation detail, server actions

Modified:

- `src/db/schema.ts` — **five** new tables (`payout_operation`, `loot_pool`,
  `loot_item`, `payout_participant`, `payout_payment`), plus a generated
  migration (`npm run db:generate`; never hand-written)
- `src/db/tables.ts` — the same five added to `MANAGED_TABLES`. This is not
  optional bookkeeping: `tests/seed-dev.test.ts` asserts the list matches the
  database, so omitting it fails a test — which is exactly the design intent
  recorded in that file's header comment.
- `src/services/audit.ts` — `targetKindFromAction` maps action prefixes to a
  target kind and returns `null` for anything unrecognised, so `payout.*` rows
  would render unresolved. Payout actions target a `payout_operation` uuid, which
  is a *fourth* kind alongside account / character / discord, so this needs a new
  branch and a resolver, not just a prefix added to the account list.
- `src/lib/esi/client.ts` — add `resolveIds`
- `src/app/account/` — the "your payouts" section

Unchanged: `src/worker/`, `src/jobs/`, `src/config.ts` (no new env or secrets —
the express-payment scope question in *Paying* is the one thing that could change
this, and it is deferred out of PR 1).

No new runtime dependencies: exact arithmetic is native `bigint` (see *The
split*).

## Testing

- **Table tests** for `payout-split.ts` covering every edge case listed above,
  asserting exact cent values, plus the string↔`bigint` conversion at the
  boundary — this is the money path and the one place a wrong answer is
  expensive.
- **Table tests** for paste parsing: the `/`-delimited format, stray whitespace,
  duplicate names, alt collapsing, unresolved names.
- **Integration tests** against `TEST_DATABASE_URL` via `tests/helpers/db.ts` for
  the service layer. Four that matter more than the rest, each pinning a specific
  failure this design exists to prevent:
  - recalculating after a payment leaves `paidAmount` untouched (the aa-payout
    bug, in its subtler form);
  - a payout-affecting edit is **rejected** once any payment event exists;
  - unlinking a character that appears in a paid operation leaves the
    participant row intact with its `displayName` and amount readable
    (`ON DELETE SET NULL`, exercised against the real `unlinkCharacter`);
  - a `cryo` or non-`flygd` account is refused at the **service** layer, not
    merely hidden in the UI.
- **Constraint tests** that each `CHECK` actually rejects: negative shares, a
  `corpSharePct` of 101, a flat pool with no note.
- **msw** for the triff client: the real `GET` shape, the `types` array response,
  a timeout, a non-2xx, and a type id missing from the response becoming an
  `unresolved` row rather than a silently smaller total.
- **Playwright** for the create → appraise → roster → finalize → mark-paid path.

Note for whoever runs these: `npm test` shares one database across worktrees. Per
`docs/ops.md:463`, point concurrent runs at a private one with
`TEST_DATABASE_URL`. (`npm run test:e2e` isolates itself and needs nothing.)

## Delivery

**PR 1 — usable core.** Schema, constraints and migration; split math; triff
client; create operation; paste roster; appraise; compute; finalize; mark paid
with copy-amount. Includes the `MANAGED_TABLES` and audit-resolver updates,
because both fail tests if skipped. Shippable: it replaces PayGD on its own, and
needs no new scopes.

**PR 2 — polish.** Manual/type-ahead entry, per-item price override, revert-a-
payment, the account-page "your payouts" section, multiple pools per operation,
and — if and only if the scope question in *Paying* is settled — the open-info
express path.

The line between them is that PR 1 is what makes the numbers *recorded* and PR 2
is what makes them *pleasant*. Splitting this way means the feature is delivering
value before the second half is written, and if PR 2 slips, nothing is broken.

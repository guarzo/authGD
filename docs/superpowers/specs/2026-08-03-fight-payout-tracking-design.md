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
- `Decimal` arithmetic throughout with an explicit rounding mode.

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
  amount, status, paidAt, paidBy
```

`accountId` is **nullable**: not everyone in a fleet has an authGD account, and
the payout must not be blocked on them signing up. A row with a null `accountId`
is a name and an amount, which is enough to owe someone ISK.

`recipientCharacterId` is also nullable, and is the character the ISK should
actually go to — the account's main by default, overridable per operation for
someone who wants paying on a hauler alt. It is null exactly when the participant
could not be resolved to a known character, which is also what disables the
express payment path for that row. `displayName` is always populated and is what
the UI shows.

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

All arithmetic is `Decimal` against `numeric(20,2)` columns, rounding down at
every step, with the sub-ISK remainder falling to corp. Never `float`: PayGD uses
`float` and `round()`, which is fine on screen and wrong in a ledger.

Rounding down is chosen so the sum of the paid amounts can never exceed the pool.
The alternative — round-half-up and let corp absorb a shortfall — can hand out
more ISK than was looted.

Edge cases the table tests must pin: zero participants (everything to corp, no
division); everyone excluded (same); `corpSharePct` of 0 and 100; a pool smaller
than the participant count (some people get 0.00 and it says so, rather than the
whole thing silently going to corp).

## Recalculation safety

aa-payout's data-loss bug comes from payouts being a separate table that gets
dropped and rebuilt. Here, **`amount` and `status` live on the participant row
itself**, so recalculation is an `UPDATE` of `amount` on rows that already exist.
There is no delete step to get wrong.

On top of that: once any participant is marked paid, the operation is
`finalized`, and finalized operations reject changes to the loot pools or the
roster. Correcting a finalized operation is an explicit, audited unlock. The
structural guarantee is the important half; the status check is the guard rail
that keeps someone from wanting to.

Every state change writes to the existing `audit_log` table, matching the
project's standing convention.

## Pricing

**triff.tools only.** `POST https://triff.tools/api/market/quote`, the same
endpoint PayGD already uses, free and unauthenticated. Pricing modes carry over
directly: `side = sell | buy`, `field = best | p05` (5th percentile), station
defaulting to Jita 4-4 (`60003760`).

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

Creating and editing an operation requires an authGD account at tier **`flygd`**
— any member, not a new FC role. There is no `isFc` flag and no migration on
`account`. Alliance leadership is small and trusted; a permissions system nobody
asked for is a system nobody maintains.

Payouts are **fully transparent**: any `flygd` member can see any operation, its
loot, its roster, and its amounts. This is the norm for a corp that splits loot
by trust, and it is the cheapest possible reconciliation mechanism — the people
who were in the fleet will notice if the roster is wrong.

Line members additionally get a **"your payouts"** section on `src/app/account`
showing operations they participated in, what they were owed, and whether it has
been marked paid. This is the feature's answer to "did I get paid for that
Thursday roam", which is the question the current workflow cannot answer at all.

## Paying

Marking someone paid is a manual click, because ESI has no ISK-transfer endpoint
and never has. What the tool can do is remove the transcription step:

For a participant whose `recipientCharacterId` has the `esi-ui.open_window.v1`
scope (checked against the existing `character.scopes` jsonb column), a **Pay**
action opens the in-game transfer window pre-filled with recipient and amount.
The operator confirms in the client, comes back, and marks it paid.

Where that scope is absent — which will be most people, since it is not in the
current `EVE_SSO_SCOPES` — the action degrades to copy-amount-and-advance. No
scope is added for this; the express path lights up for whoever happens to have
granted it.

Marking paid stamps `paidAt` and `paidBy` and writes an audit row.

## Code layout

New:

- `src/core/payout-split.ts` — the split math, pure, table-tested
- `src/lib/triff/client.ts` — appraisal, injectable `fetch`, mirroring `src/lib/esi/client.ts`
- `src/services/payouts.ts` — operation/pool/participant persistence
- `src/app/payouts/` — operation list, operation detail, server actions

Modified:

- `src/db/schema.ts` — four new tables, plus a generated migration
  (`npm run db:generate`; never hand-written)
- `src/lib/esi/client.ts` — add `resolveIds`
- `src/app/account/` — the "your payouts" section

Unchanged: `src/worker/`, `src/jobs/`, `src/config.ts` (no new env or secrets).

## Testing

- **Table tests** for `payout-split.ts` covering every edge case listed above,
  asserting exact `Decimal` values — this is the money path and the one place a
  wrong answer is expensive.
- **Table tests** for paste parsing: the `/`-delimited format, stray whitespace,
  duplicate names, alt collapsing, unresolved names.
- **Integration tests** against `TEST_DATABASE_URL` via `tests/helpers/db.ts` for
  the service layer, including the recalculation-preserves-payment-state
  guarantee, which is the specific aa-payout bug this design exists to avoid.
- **msw** for the triff client, including a triff outage falling through to the
  flat-value path.
- **Playwright** for the create → appraise → roster → split → mark-paid path.

Note for whoever runs these: `npm test` shares one database across worktrees. Per
`docs/ops.md:463`, point concurrent runs at a private one with
`TEST_DATABASE_URL`. (`npm run test:e2e` isolates itself and needs nothing.)

## Delivery

**PR 1 — usable core.** Schema and migration, split math, triff client, create
operation, paste roster, appraise, compute, mark paid. Shippable: it replaces
PayGD on its own.

**PR 2 — polish.** Manual/type-ahead entry, per-item price override, express
open-window payment, the account-page "your payouts" section, multiple pools per
operation.

The line between them is that PR 1 is what makes the numbers *recorded* and PR 2
is what makes them *pleasant*. Splitting this way means the feature is delivering
value before the second half is written, and if PR 2 slips, nothing is broken.

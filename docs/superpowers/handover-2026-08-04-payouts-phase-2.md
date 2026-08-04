# Handover — fight payout tracking, phase 2

**Written:** 2026-08-04, at the end of the phase-1 session.
**For:** whoever brainstorms and plans PR 2. This is *input to* `superpowers:brainstorming`
and `superpowers:writing-plans` — it is not a spec and not a plan. Do not implement
from it directly.

## Where phase 1 got to

PR #65 (`worktree-fight-payout-tracking`) — fight payout tracking, 10 SDD tasks,
merged up to `main` at 15ef717. CI green: typecheck, lint, format, unit (542),
e2e (64), Next build, Docker image.

Read these first; they carry the reasoning this document assumes:

- Spec: `docs/superpowers/specs/2026-08-03-fight-payout-tracking-design.md`
- Plan: `docs/superpowers/plans/2026-08-03-fight-payout-tracking.md`
- The PR body of #65, especially its **Flags** section.

Phase 1 shipped the "usable core": create an operation, attach loot (flat ISK
pool or an EVE inventory paste appraised via triff.tools), paste a fleet roster,
split by share, finalize, mark paid with copy-amount, audit every state change.

### Invariants phase 2 must not break

These were expensive to get right and are enforced by tests that will fail loudly
if a phase-2 change regresses them. Treat them as constraints, not preferences.

1. **Money is exact end to end.** Native `bigint` ISK-cents against
   `numeric(20,2)`. `Number()` never touches a money value on the write *or* read
   side. Splits floor-divide and give the remainder to the corp, so parts always
   reconcile against the total (`src/core/payout-split.ts:62`).
2. **Round once at the line total**, never per unit before multiplying —
   `BigInt(Math.round(price * line.qty * 100))`. Per-unit rounding makes the error
   scale with quantity, and a sub-cent unit price floors to zero and silently
   erases a valuable line. `tests/appraisal.test.ts` asserts the correct value
   *and* asserts it is not the naive one.
3. **The service layer is the authorization boundary**, not the page.
   `requirePayoutOperator` (tier `flygd` AND status `active`) is the first
   statement inside each mutating export's transaction.
   `tests/payouts-service.test.ts` drives all 11 mutating exports through it — any
   new mutating export must join that loop.
4. **Lock, then read.** Anything deciding on a row re-reads it *after*
   `SELECT … FOR UPDATE`. Two phase-1 bugs came from getting this wrong.
5. **Finalization freezes**, and one recorded payment freezes the roster via
   `hasPayments()` (`src/services/payouts.ts:51`).
6. Every state change writes an audit row targeting the operation uuid.
7. `src/core/` stays pure. Migrations are generated, never hand-written.

## Phase-2 scope, from the spec

Verbatim intent from `…-design.md:533`: *"PR 1 is what makes the numbers recorded
and PR 2 is what makes them pleasant."*

| Item | Notes |
| --- | --- |
| Manual / type-ahead participant entry | This is what makes the duplicate-unresolved-name check reachable. That check looks like dead code if you only read the paste path — it is not; do not delete it. |
| Per-item price override | Interacts with invariant 2. An override is a price like any other and must round at the line total. `rawPaste` is kept verbatim precisely so re-appraisal stays possible (`…-design.md:87`). |
| Revert a payment | `payout_payment` already has a `payout_payment_kind` enum with a `reverted` member — the schema anticipated this, the behaviour was never built. Interacts with invariant 5: decide whether a revert un-freezes the roster. |
| Account-page "your payouts" section | The spec lists `src/app/account/` as modified for this; phase 1 only added the nav entry. |
| Multiple pools per operation | The schema already supports it (`loot_pool.operation_id` is a plain FK, no uniqueness). This is a UI/service gap, not a schema change. |
| Open-info express path | **Stop-and-ask. Do not start this without the user.** See below. |

### The one blocking decision

The express path needs `EVE_SSO_SCOPES` to stop being a single global string,
which is a change to the OAuth flow. Both the project working agreement and the
spec (`…-design.md:450`) mark the OAuth state flow as a stop-and-ask surface.

The spec is explicit that this is *not* a prerequisite: Copy amount and Mark paid
need no scopes at all. So phase 2 can ship everything else and leave this out.
**Surface it as a question during brainstorming; do not resolve it by inference.**

## Deferred defects, verified against the code on 2026-08-04

Each of these was confirmed by reading the current source, not recalled. File and
line are accurate as of 15ef717.

**Worth fixing in phase 2:**

1. **`listPayoutOperations` does four unbounded queries**
   (`src/services/payout-view.ts`). It reads *every* row of `loot_pool`,
   `payout_participant`, and `payout_payment` with no `where` clause at all,
   then folds in memory. The CodeRabbit pass narrowed the selected columns (it
   was also dragging every `raw_paste` across the wire), but the queries are
   still unbounded. Fine at ten operations, not at a thousand. This is the
   single most likely thing to bite in production, and it wants pagination
   decided alongside it.
2. **`participant.shares` is `numeric(6,2)`** (`src/db/schema.ts:293`), so a
   share value above 9999.99 fails as a raw Postgres error rather than a readable
   one. (`corpSharePct` is *not* affected — it is `numeric(5,2)` and bounded
   `0..100` by `payout_operation_corp_pct_ck`, so it cannot overflow.)
3. **Zero-quantity paste lines are dropped silently** (`src/core/loot-paste.ts`).
   Deliberate in phase 1 — it matches the parser's existing lenience toward blank
   lines — but a user who pastes a zero-qty line gets no signal at all. Manual
   entry (phase 2) makes this more visible, so revisit it then.
4. **`computeSplit` does no input validation** (`src/core/payout-split.ts:38`).
   A negative `totalCents` or a `corpSharePct` outside 0–100 produces nonsense
   rather than an error. The DB check constraints catch it at persist time, so
   this is defence in depth, not a live bug.
5. **`recordPayment` and `loadParticipantOperationId` throw bare `Error`s**, so
   callers cannot discriminate them from programming errors the way they can with
   `PayoutForbiddenError` / `PayoutLockedError`.
6. **Identical unresolved roster names are not deduped**, so two participant rows
   can share one name. Phase 1 warns about this on the page; phase 2's manual
   entry should probably prevent it instead.

**Lower value, listed for completeness:**

7. `perShareCents` is returned by `computeSplit` (`src/core/payout-split.ts:62`)
   and consumed nowhere. Either use it or drop it from `SplitResult`.
8. Parser edge cases: a line that is only a quantity (`"12"`) is absorbed as a
   name, and `"12xFoo"` with no space is taken as a literal name. Related: an
   absurd-magnitude quantity (a 25-digit run) parses to a finite non-safe
   integer and dies later as a raw `numeric(20,2)` overflow rather than a
   readable error. The regexes only ever match digits, so nothing else can get
   through — this is purely a magnitude bound, and it belongs with phase 2's
   manual-entry validation.

**Not recoverable.** The SDD workspace was deleted after the final review, so
roughly a dozen further per-task *minor* findings — mostly test-hygiene notes — are
gone. The substantive ones are all above or in #65's Flags. I would rather record
that they existed than reconstruct them from memory and present guesses as fact.

## Suggested shape for the brainstorm

The phase-2 items are not equally coupled. Worth deciding early whether this is
one PR or two:

- **Data-shape work** — multiple pools, per-item override, revert-a-payment — all
  touch the service layer and the freeze rules, and interact with each other.
- **Presentation work** — the account-page section, type-ahead entry — is mostly
  additive and could ship independently.

Item 1 (pagination) is arguably its own small PR that need not wait for either.

## Environment notes

- `npm test` shares one database across worktrees — use
  `TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_<name>`.
- `npm run test:e2e` self-isolates but its derived port can collide with another
  worktree's stale container; `E2E_DB_PORT=<port>` is the documented override.
- Running the dev server (including the one Playwright boots) rewrites the tracked
  `tsconfig.json` and `AGENTS.md`. Both are tracked — recover with
  `git checkout`, never delete. Never `git add -A` after an e2e run.
- CI runs `format:check` (`prettier --check .`) over the whole repo; checking only
  your own changed files will pass while CI fails.

## CodeRabbit findings on #65 deliberately not fixed

Reviewed 2026-08-04 against the code at that commit. Each was verified, not
assumed. The three schema ones are grouped on purpose: none changes behaviour
reachable through application code, and all three would mean rewriting an
unapplied migration.

- **Index every FK column on the payout tables.** No table in `schema.ts`
  indexes its FK columns — `character.account_id`, `discord_link.account_id`
  and the rest are all bare. Indexing only the five payout tables would make
  them the exception with no measured need.
- **`CHECK (amount >= 0)` on `payout_payment`.** The only writer inserts
  `participant.amount`, already covered by `payout_participant_amount_ck`. It
  would also pre-judge phase 2's revert semantics, which may want a signed row.
- **`btrim(notes) <> ''` in `loot_pool_flat_note_ck`.** `addFlatPool` already
  rejects `!input.notes.trim()`, so no code path can reach the DB with a
  whitespace-only note.
- **Early-return an empty map from `resolveIds`.** `chunk([], n)` returns `[]`,
  so the loop body never runs and no request is made. Already a no-op.
- **Drop `.finite()` from the triff price schema.** Redundant given
  `.max(1e15)`, but deliberate and documented at the call site; removing it
  changes no behaviour.
- **Bulk-UPDATE the participants in `recalculate`.** Rosters are tens of rows
  inside one transaction. Premature.
- **SQL aggregation in `listPayoutOperations`.** The column narrowing was done
  (it was dragging every `raw_paste` across the wire); the count/group rewrite
  is item 1 above and wants pagination decided with it.

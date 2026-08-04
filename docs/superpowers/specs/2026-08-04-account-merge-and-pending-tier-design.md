# Account merge and the pending tier

Date: 2026-08-04

Two defects found by an operator who signed in with the wrong character:

1. A fresh SSO login with any character creates a new account, and that
   character can never afterwards be moved to the operator's real account.
2. Every new account lands on green, and green carries a Discord role. Anyone
   who finds the login URL grants themselves standing in the guild.

Both are fixed here. They share a file (`src/services/accounts.ts`) and a
concept (what a brand-new account is worth), so they ship together.

## Problem 1: the stranded account

`/auth/eve/link` and `linkCharacter` already exist — the "link character"
button on `/account` is the intended way to attach an alt. The failure is a
deliberate refusal, not a gap:

```
src/services/accounts.ts:244
    if (existing.ownerHash === ch.ownerHash) {
      return { ok: false, error: "already_linked" };
    }
```

The guard protects a character that legitimately sits on someone else's
account. But EVE rotates `ownerHash` whenever a character changes hands, and
`handleEveLogin` reclaims on a hash mismatch. So the state "same character,
same owner hash, different account row" is reachable only when the same EVE
owner authenticated twice. The refusal is firing on a case it can prove is
safe.

### Fix: absorb the source account

The refusal is replaced by a test, in that branch only. The two neighbouring
branches are untouched: a character already on the caller's own account still
re-auths in place, and a character whose owner hash differs is still reclaimed
as a transfer. The source account is folded into the caller's account when
**all** of the following hold:

- it holds exactly one character, the one being linked
- `is_admin` is false
- it has no `discord_link` row
- it has no `payout_participant` and no `payout_operation` rows
- `tier_locked` is false

That is the exact shape of an account created by an accidental login. Any
other shape returns `already_linked` unchanged, so no existing behaviour
moves.

The merge runs in the transaction `linkCharacter` already opens, under locks
it already holds — the advisory character lock plus both account rows in
sorted id order (`lockAccounts`, `accounts.ts:248`), the path built for the
sold-character case. Steps:

1. Clear the source account's `main_character_id`.
2. Repoint `character.account_id` at the target account.
3. Delete the source account's sessions.
4. Delete the source account.
5. Adopt the character as the target's main if the target had none.
6. Audit `account.merged` on the target, with source account id and character
   id in details.
7. Enqueue `{ kind: "account", accountId: target }`.

The composite main-character FK is `DEFERRABLE INITIALLY DEFERRED`
(`drizzle/0001_main_character_fk.sql`), so step 2 is validated at commit and
needs no ordering workaround. `contact_sync_state` is keyed by character id
alone, so it follows the character to its new account correctly.

Two deletion side effects, both accepted:

- `audit_log.actor` is `onDelete: "set null"`, so rows written by the source
  account lose attribution. Acceptable for an account whose whole history is
  "created by mistake"; the `account.merged` row on the target records what
  happened.
- `bootstrap_admin_grant.account_id` also nulls. This is correct — the grant
  stays permanently consumed and cannot be re-earned through a merge.

### Operator recovery path

Sign out, sign in as the main character, then use "Link character" on
`/account` and authorise the stray character. It absorbs.

### Deliberately not built

There is no admin merge tool. An account that fails the absorbable test tells
the member to contact an admin, and the admin has no in-app remedy — they
would be working in the database. Accepted: the rich-alt-account case should
not occur, and building a general account-merge admin surface is a much larger
piece of work than the defect justifies. Recorded here so it is a known gap
rather than a surprise.

## Problem 2: pending instead of automatic green

Green is not inert. `diffRoles` (`src/core/role-diff.ts:9`) grants the managed
green role in Discord, so today any capsuleer who reaches the login URL
receives guild standing. Contacts and the Wanderer ACL are flygd-only
(`getFlygdCharacters`, `isContactsTarget`), so those are unaffected.

### Data model

`pending` is appended to the `tier` enum as a fourth value.

The column default is **not** changed. Postgres refuses to use a new enum
value in the transaction that adds it, and the Drizzle migrator runs
migrations in a transaction, so `ALTER TYPE tier ADD VALUE 'pending'` followed
by `ALTER COLUMN tier SET DEFAULT 'pending'` fails with `unsafe use of new
value of enum type`. Instead `createAccountWithCharacter`
(`src/services/accounts.ts:194`) writes `tier: "pending"` explicitly and the
migration only appends the value. Same behaviour, hazard removed.

Appending an enum value is irreversible — Postgres cannot remove one. This
migration is one-way. It touches no existing rows.

### Type surface

`Tier` in `src/core/tier.ts` gains `pending`, and the hand-written tier unions
that mirror it widen with it: `src/services/account-view.ts` (three
occurrences, plus `TIER_RANK`), `src/services/admin-accounts.ts`,
`src/app/admin/accounts/actions.ts`, `src/app/admin/accounts/page.tsx`
(`TIERS`), `src/core/role-diff.ts` and `src/app/_components/ui.tsx`. These are
mechanical, but they are separate copies of the same union, so a missed one is
a type error rather than a silent bug — typecheck is the gate.

`decideTier`'s return type stays `"flygd" | "green" | null`: the function never
returns pending, it only declines to move a pending account.

### State machine

Three narrow edits:

- **`decideTier`** gains one rule: a pending account whose confirmed main is
  not in the alliance returns `null` and stays pending. Pending with the main
  in the alliance still returns `flygd`, so a genuine member who signs up is
  auto-promoted by the next membership run and never enters the queue.
- **`applyNoMainRule`** (`accounts.ts:144`) demotes to green unless the tier is
  already green. Pending joins that exclusion — otherwise unlinking your main
  *promotes* a pending account to green.
- **`diffRoles`** maps pending to no managed role: add nothing, strip flygd,
  blue and green. `ManagedRoleIds` stays three entries; no new secret, no
  fourth Discord role, no `docs/ops.md` change.

### Approval

A new `approveAccount(dbx, actor, accountId, tier)` in
`src/services/admin-accounts.ts`, separate from `setTierManual`:

- accepts green or blue only — flygd is not an approval target
- refuses unless the account is currently pending
- sets `tier_locked` for blue only
- audits `tier.approved` with the granted tier
- enqueues `{ kind: "account", accountId }` like every other tier mutation

Green approval stays unlocked so the account rejoins the automatic state
machine — a later alliance join then promotes it to flygd without an admin.
An unlocked green is stable, because `decideTier` already wants green for a
confirmed non-alliance main. Blue must lock: an unlocked blue would be
converged straight back to green on the next membership run, which is why blue
is inherently a locked tier today.

### Existing accounts

Nothing moves. Accounts that are green when this ships stay green. The
migration changes the enum only. Anyone who signed up before today keeps their
role until an admin demotes them by hand, which avoids stripping a genuine
deroled ex-member's access on deploy.

### Derole is unchanged

A flygd member who leaves the alliance still drops to green automatically.
Pending is the state of a never-approved account, not a punishment for leaving.
Routing derole through the approval queue would break "derole, don't boot":
someone who drops corp for a week would lose Discord access until an admin
worked the queue.

## Surfaces

**Member (`/account`).** A pending account sees that its access is awaiting
admin approval — no tier badge, and no implication that something is broken.
The `already_linked` copy changes: after this it fires only for account shapes
that fail the absorbable test, so it should say the character belongs to an
account an admin has to sort out.

**Admin (`/admin/accounts`).** Pending joins the tier filter and sorts to the
top of the table, so the queue is the default view. `TIER_RANK` in
`src/services/account-view.ts` gains the value; the badge in
`src/app/_components/ui.tsx:204` learns a fourth tier. The badge treatment is
achromatic rather than a fourth hue: DESIGN.md tunes the three tier colours as
a set against deuteranopia and protanopia, and "not yet decided" reads better
as an absence of colour than as a new one. For a pending row the tier control
becomes "Approve as Green" / "Approve as Blue", routing to `approveAccount`.
Flygd is unchanged — granted by the system, or by the existing manual set.

## Testing

Unit:

- `decideTier`: pending + main in alliance promotes; pending + confirmed main
  out of alliance holds; unchanged behaviour for the existing tiers.
- `diffRoles`: pending adds nothing and strips all three managed roles.
- `applyNoMainRule`: a pending account losing its main stays pending.
- `approveAccount`: refuses a non-pending account, locks for blue, leaves
  green unlocked, refuses an unauthorized actor, writes the audit row.
- `linkCharacter` merge: happy path; one test per rejection reason; main
  adoption when the target had none; source sessions deleted; audit rows.

E2E: a pending account sees the awaiting-approval notice; an admin approves it
and the tier badge changes.

Gates, each run and quoted: `npm test`, `npm run typecheck`,
`npm run test:e2e`, `npm run format:check`.

## Out of scope

- An admin merge tool for non-absorbable accounts.
- A dedicated pending Discord role.
- Any backfill of existing green accounts.
- Any change to the derole path or to contacts/ACL sync.

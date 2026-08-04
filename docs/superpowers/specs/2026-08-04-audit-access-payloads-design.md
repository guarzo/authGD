# Audit log: write down why access was lost

Date: 2026-08-04
Branch: `worktree-feat-audit-access-payloads`, off `main` at `cbc6c5a`

Follow-up to `2026-08-04-admin-audit-fixes-design.md` (shipped as PR #73). That
branch fixed the renderer. This one fixes the writers, and finishes two things
the renderer work left half-done.

## Problem

PRODUCT.md sets the bar: an admin can answer "why is this person's role wrong?"
from `/admin/audit` in under a minute. For the actions most likely to be the
answer, the page cannot, because the row carries nothing to read.

The app writes 36 distinct audit action names. Nine of them are `payout.*`, and
this spec reviews **the other 27**: the access-control set. That boundary is
drawn deliberately and stated up front, because the counts below are otherwise
easy to read as repository-wide.

Of those 27, twelve attach a `details` payload; all twelve are already declared
in the PARTS table in `src/app/admin/audit/summarize.ts`. PARTS holds thirteen
entries, not twelve, and the extra one is the first defect below. The other
fifteen actions call `logAudit` with no `details`, so
`src/app/admin/audit/page.tsx:444` short-circuits to a dim placeholder and
`summarizeDetails` is never called. Declaring those actions would change nothing
on screen. **The work is in the writers.**

**Why `payout.*` is excluded.** Those nine actions record ISK distribution for
a fight operation: who was on the roster, what the loot appraised at, what was
paid. None of them can answer "why did this member lose access", which is the
one question this page exists to serve. Six carry a payload
(`payout.roster_set`, `payout.participant_updated` twice,
`payout.participant_removed`, `payout.paid`, `payout.pool_added` twice,
`payout.pool_deleted`) and three do not (`payouts.ts:113` `payout.created`,
`:371` `payout.finalized`, `:405` `payout.unlocked`). None of the nine is
declared in PARTS, so all six payload-bearing ones render through the generic
key=value fallback, and this branch leaves that unchanged: the fallback already
appends `+N more`, so section 3 below is a no-op for them. Whether the payout
surface wants declarations of its own is a real question and a separate one.

Seven payload-free actions are access-relevant, each verified at this call site:

```
admin.demoted         src/services/accounts.ts:429
admin.promoted        src/services/accounts.ts:457
character.unlinked    src/services/accounts.ts:313
tier.unlocked         src/services/admin-accounts.ts:69
status.note_changed   src/services/admin-accounts.ts:110
token.needs_reauth    src/jobs/token-health.ts:119
wanderer.removed      src/jobs/wanderer.ts:91
```

Two further defects, both currently shipped, are in the same area.

### The declaration that describes nothing

`admin.promoted` is declared in PARTS with `scalar("scope")` and
`scalar("note")` (`summarize.ts:82`), and `src/services/accounts.ts:457` writes
neither. The declaration was written against seeded test data. The app has no
admin-scope concept: `grep` finds exactly one `isAdmin: false` write in the
repository (`accounts.ts:428`) and one `isAdmin: true` promotion path
(`accounts.ts:456`), neither of which has a scope or a note to record.

### Declared actions drop undeclared keys in silence

For an action that PARTS declares, any key the declaration does not name is
dropped with no `+N more`, unlike the undeclared-action fallback. This is
behavioural parity with the pre-existing code, so it is not a regression. It is
also a wider information loss than it first appears:

| Action | Written | Rendered today | Dropped |
| --- | --- | --- | --- |
| `tier.changed` manual, `admin-accounts.ts:49` | `{to, locked, cause}` | `→ green` | `locked`, `cause` |
| `tier.changed` no-main rule, `accounts.ts:159` | `{to, cause}` | `→ green` | `cause` |
| `tier.changed` membership, `membership.ts:59` | `{from, to, cause}` | `flygd → green` | `cause` |
| `status.changed` self, `accounts.ts:98` | `{to, self}` | `→ active` | `self` |
| `discord.role_changed`, `discord-roles.ts:93` | `{removed, cause}` | `−flygd` | `cause` |
| `discord.role_changed`, `discord-roles.ts:166` | `{added, removed, tier}` | `+green −flygd` | `tier` |

`cause` is written by every `tier.changed` writer in the app, carries values
like `"main unlinked"`, `"character transferred"` and `"main left alliance"`,
and is displayed nowhere. It is the closest thing the schema has to a direct
answer to the product question, and it costs no writer change to surface.

### The transition renderer fires on one writer in five

PR #73 built `transition(fromKey, toKey)` so that `status.changed` would stop
rendering a bare `→ cryo`. No `status.changed` writer writes `from`, so it
still does. Of the five writers of the two transition actions, one writes
`from`:

| Writer | Payload | Where `from` already sits in scope |
| --- | --- | --- |
| `membership.ts:59` `tier.changed` | `{from, to, cause}` | written |
| `admin-accounts.ts:45` `tier.changed` | `{to, locked, cause}` | `acc.tier`, read at line 38 |
| `accounts.ts:155` `tier.changed` | `{to, cause}` | `acc.tier`, read at line 138 |
| `admin-accounts.ts:88` `status.changed` | `{to}` | `acc.status`, read at line 81 |
| `accounts.ts:95` `status.changed` | `{to, self}` | guarded `cryo` at line 89 |

Every one of those writers has already locked and read the row it is about to
change, so `from` is a reference to a variable in scope, not a query.

## Approach

### 1. Payloads, and where they are refused

Not every action needs one. Three of the seven are self-describing from actor
and target alone, and adding a payload to them would be filling a slot rather
than answering a question.

| Action | Payload | What it lets an admin conclude |
| --- | --- | --- |
| `character.unlinked` | `{name, wasMain}` | Which character this was, at all. |
| `token.needs_reauth` | `{missingScopes}` | App-wide scope change, or one member's revocation. |
| `tier.unlocked` | `{tier}` | What automation was handed back. |
| `status.note_changed` | `{had, has}` | Added, replaced, or cleared. |
| `wanderer.removed` | `{role}` | Which permission level was revoked. |
| `admin.demoted` | none | Actor plus target is the whole event. |
| `admin.promoted` | none | Same. |

**`character.unlinked` records a name, not an account.** `accounts.ts:310`
deletes the `character` row before the log write, so the audit `target` is a
character id that can never again resolve to a name: `resolveAuditIdentities`
looks it up in a table it is no longer in, and the Target cell renders as a
dead id forever. `character.name` survives nowhere else once the row is gone.

`character.reclaimed` writes `fromAccount` (`accounts.ts:177`) and the parallel
looks tempting, but it does not carry: that action's actor is `"system"`, while
`unlinkCharacter`'s only caller (`src/app/account/actions.ts:58`) passes the
account id as the actor. `fromAccount` would repeat the Actor column on every
row.

`wasMain` is the fork into `applyNoMainRule` (`accounts.ts:321`), which is what
clears the main and deroles the account. It is the field that connects an
unlink to the `tier.changed` row that follows it.

**The recorded name is legible, not searchable, and that is accepted.**
`resolveFilterIdentity` (`src/services/audit.ts:296-303`) resolves a name
filter by matching `lower(character.name)` against **live** character rows. The
character is gone, so filtering by its name returns `{kind: "none"}` and the
page renders "No account or character named X" even though rows about it exist.
Recording the name in `details` does not change that: nothing indexes or
searches payload contents.

This is scoped out rather than solved. An access investigation starts from the
member, not from the alt: the account still exists, and the actor filter
resolves it normally, so the unlink row is reachable by the path an admin
actually takes. The name field's job is to stop a found row from rendering as a
dead id, not to be a search key.

The residual cost, stated so it is not discovered later: an admin who knows
only the deleted character's name, and not which account held it, cannot reach
these rows by filtering. Closing that gap means matching names inside
`audit_log.details`, which needs a jsonb index, a fourth `FilterResolution`
kind for "a name that no longer exists", and a decision about what the Target
cell renders when the id resolves to nothing but the payload carries a name.
That is a spec of its own, not a paragraph in this one.

**`token.needs_reauth` records what is missing, not what is required.**
`cfg.eveSso.scopes.filter((s) => !identity.scopes.includes(s))` at
`token-health.ts:103`, where both sides are already in hand. This is the action
behind the 96 consecutive identical rows noted in PR #73's out-of-scope list;
each of those rows currently carries zero bits.

**`admin.demoted` and `admin.promoted` get nothing.** The plausible reason to
add a payload is to distinguish a deliberate demotion from a last-admin guard
or an automated derole. Neither exists. The `last_admin` branch returns at
`accounts.ts:427`, before `logAudit`. No caller passes `actor: "system"`;
`demoteAdmin` and `promoteAdmin` are reached only from
`src/app/admin/accounts/actions.ts:110` and `:102`, which pass the acting
admin. There is one `isAdmin: false` write in the repository.

**Defect resolution: `admin.promoted` is deleted from PARTS.** Not emptied.
It writes no details, so `page.tsx:444` short-circuits and the declaration is
unreachable regardless; a hollow entry would preserve exactly the speculative
declaration this is meant to remove.

**`wanderer.removed` records the role, not a cause.** A `cause` field would be
a constant: the job knows only `diff.remove`, and the reason is always "not in
the desired flygd set". The role held at removal, read from the `members` list
already fetched at `wanderer.ts:43`, records which permission level was
revoked, and is what an admin needs to restore the entry if the removal turns
out to have been wrong.

Note what that role can and cannot be. `diffAcl` (`src/core/acl-diff.ts:23-27`)
excludes both `admin` and `blocked` from `remove`: admin entries are never
removed, and removing a blocked entry would be equivalent to un-banning. So a
`wanderer.removed` payload can only ever carry `manager`, `member` or `viewer`,
and the field's value is distinguishing an elevated grant from an ordinary one.
An earlier draft of this spec justified the field as separating a live grant
from "an already-blocked entry being tidied up", which describes a branch that
cannot execute; the tests below assert the real invariant instead.

Building the id-to-role `Map` is the only new computation in this spec, and it
is over data the job holds.

### 2. `from` on the four writers that have it

Four one-line additions: `admin-accounts.ts:45`, `accounts.ts:155`,
`admin-accounts.ts:88`, `accounts.ts:95`. Each references a variable already
read under the lock the writer takes anyway. This is what makes PR #73's
transition renderer do something on rows written from here on.

Rejected: leaving it to a later branch. The renderer is already built and
tested; the writers are four references. Deferring keeps "when did this account
stop being active" unanswerable while the machinery to answer it sits unused.

### 3. Undeclared keys on a declared action surface as `+N more`

Decided deliberately rather than inherited. The declarations gain the keys that
matter now (`cause`, `locked`, `self`, `tier`), **and** a declared action falls
through to the same `+N more` counter the undeclared fallback already uses.
This applies the principle PR #73's spec wrote down:

> The summary's job is not completeness; it is to not lie about being complete.

Declaring alone would fix today's instances and leave the next writer to add a
key invisibly, which is the drift class PR #73 set out to kill. `+N more` alone
would leave `cause` one disclosure click away on every row.

Three rules the counter needs, each a decision:

1. **A declared key that renders blank is still consumed.** `{locked: false}`
   renders nothing and produces no `+1 more`. Declared-and-deliberately-silent
   is not the same as nobody-looked-at-it; only the second is worth a marker.
2. **The remainder is appended even when every declared part came out blank.**
   A payload rendering `—` while carrying two unnamed keys says `+2 more`
   rather than claiming emptiness.
3. **Declared parts are not capped.** The three-key cap stays on the undeclared
   fallback only. A declaration is curated by hand, so truncating it would be
   second-guessing its author; the fallback is machine-generated, so truncating
   it is prudent.

**Mechanism: each combinator tags the keys it reads.** `scalar`, `labelled`,
`transition` and `roles` already take their key names as arguments, so each
factory attaches them to the `Part` it returns. `summarizeDetails` unions the
tags of the parts it ran, subtracts that from `Object.keys(payload)`, and
appends the count of what is left.

Rejected: inverting PARTS into a key-to-renderer map. Consumed keys would be
the map's own keys, impossible to desync, but `transition` and `roles` read two
keys and emit one string, so the map needs a multi-key entry form anyway, and
all thirteen declarations get rewritten against five-day-old tests.

Rejected: a `Proxy` over the payload recording property reads. No declaration
burden, self-maintaining, and invisible control flow in a module whose whole
value is that the declaration is readable. It also breaks the moment a
combinator enumerates keys rather than indexing them.

### 4. The declarations

Three new combinators alongside the existing four:

- `flag(key, word)` renders `word` when the value is truthy, nothing when
  falsy. Serves `locked`, `wasMain`, `self`.
- `list(key, word)` renders `missing esi-skills.read_skills.v1` for one value
  and `missing esi-skills.read_skills.v1, esi-clones.read_clones.v1` for two.
  At three or more it collapses to `missing 4 scopes`, since a full EVE scope
  string is long and the column is narrow. Serves `missingScopes`, and keeps a
  scope array out of the column as raw JSON, which is the mistake the Discord
  snowflakes were.

  **`list` guards with `Array.isArray` and renders nothing when the value is
  not an array or is empty.** The DB does not enforce payload shape, so a
  legacy row, a hand-inserted row, or a future writer bug can put a bare string
  or `null` there. This is parity with `roles()` (`summarize.ts:45`), which
  already guards this way and already has a test for it; without the guard a
  string value would `.map` into per-character garbage or throw into the
  `(unreadable)` catch, turning one bad row into a dead cell. The key is still
  treated as consumed, so a malformed value produces no misleading `+1 more`:
  the payload is one disclosure click away, and the summary declines to
  guess rather than inventing a reading of it.

- `noteChange(hadKey, hasKey)` renders `note added`, `note replaced`, or
  `note cleared`.

```
  "tier.changed":         [transition("from","to"), scalar("cause"), flag("locked","locked")]
  "status.changed":       [transition("from","to"), flag("self","self-service")]
  "discord.role_changed": [roles("added","removed"), labelled("tier","tier"), scalar("cause")]
  "character.unlinked":   [scalar("name"), flag("wasMain","was main")]
  "token.needs_reauth":   [list("missingScopes","missing")]
  "tier.unlocked":        [labelled("was","tier")]
  "status.note_changed":  [noteChange("had","has")]
  "wanderer.removed":     [labelled("role","role")]
  "admin.promoted":       deleted
```

## Ordering, locks, and the rules this does not touch

**`character.unlinked` needs one statement moved, and that statement is near a
lock.** `wasMain` requires the account row, which `accounts.ts:316-320` reads
`FOR UPDATE` *after* the log write. The `logAudit` call moves below that read.

Lock acquisition order is unchanged: character first (`findCharacterForUpdate`,
line 294), then account (line 316). The account `SELECT ... FOR UPDATE` does
not move relative to the deletes; only the log call moves, and `logAudit` takes
no lock. A reviewer should confirm this rather than take it on faith, which is
why it is written here.

**Nothing here touches the derole-don't-boot rule or the tier state machine.**
No writer computes a new decision. Every value is a variable already in scope
from a lock-and-read the writer performs regardless: `existing.name`,
`acc.mainCharacterId`, `acc.tier`, `acc.statusNote`, `acc.status`,
`identity.scopes`. The one construction is `wanderer.removed`'s id-to-role
`Map`, built from a list the job has already fetched. If a payload had required
a writer to compute something it does not already know, this spec would say so
and drop the field instead of widening the writer's job to feed the log.

## Backward compatibility

Audit rows are persisted. **No `audit_log` migration and no backfill.** Old
rows lack every field added here, and every combinator already returns `""` for
an absent key, so degradation needs no special case. The three shapes in the
table today all land somewhere honest:

| Existing row | Renders after this change |
| --- | --- |
| `tier.changed {to: "green", cause: "main unlinked"}` | `→ green, main unlinked` (improves with no migration: `cause` was always written, never shown) |
| `character.unlinked` with `details = NULL` | dim `—`, exactly as today; `page.tsx:444` never calls the summarizer |
| `status.changed {to: "cryo"}` | `→ cryo`, unchanged; the `from` branch stays dormant on pre-existing rows |

## Testing

### Unit, renderer

`tests/audit-summarize.test.ts` (exists, seventeen cases). Add:

- one case per new combinator: `flag` truthy and falsy, `list` at one, two and
  three-or-more values, `noteChange` across added, replaced and cleared
- **`list` on a malformed value**: a bare string, `null`, and `[]` each render
  nothing and never reach the `(unreadable)` catch, matching the existing
  `roles()` malformed-payload test. This is the regression guard that stops one
  legacy or hand-inserted row from producing a dead cell.
- one case per new or changed declaration in the table above
- `+N more` appears on a *declared* action carrying an undeclared key
- a declared key rendering blank produces **no** marker (rule 1)
- the remainder count appears when every declared part is blank (rule 2)
- declared parts are not truncated at three (rule 3)
- the three old-row shapes from the compatibility table, which are the
  no-migration guarantee expressed as tests

### Unit, writers

Every affected writer already has a suite. No new files.

| File | Asserts |
| --- | --- |
| `tests/accounts.test.ts` | `character.unlinked` writes `{name, wasMain}`, both branches of `wasMain`; `from` on the self-reactivation `status.changed` and the no-main-rule `tier.changed` |
| `tests/admin-accounts.test.ts` | `tier.unlocked` writes `{tier}`; `status.note_changed` across added, replaced, cleared; `from` on the manual `tier.changed` and `status.changed` |
| `tests/token-health-job.test.ts` | `token.needs_reauth` writes the scopes actually missing, not the whole required set |
| `tests/wanderer-job.test.ts` | `wanderer.removed` writes the role held at removal; a removal row never carries `admin` or `blocked`, because `diffAcl` cannot produce one (the invariant, asserted at the job level where the payload is written, not re-asserted against `tests/acl-diff.test.ts`); dry run still writes no row at all |
| `tests/membership-job.test.ts` | untouched: it already writes `from` |

### E2E

One new spec in `e2e/audit.spec.ts`: a `tier.changed` row seeded with a cause
renders that cause in the summary line. That is the product question end to
end, and nothing else here needs a browser to be believed. Row-count assertions
in it filter by content, because the empty state is also a `<tr>`.

### Two assertions that must change, and the line around them

`e2e/audit.spec.ts:56` asserts `toHaveText("green → flygd")` on a row seeded at
line 22 with `{from: "green", to: "flygd", cause: "admin"}`. Line 62 asserts
`"→ green"` on `{to: "green", cause: "membership"}` from line 28. They become
`green → flygd, admin` and `→ green, membership`.

**Those two updates are the change working, not the change overreaching.** This
needs stating because PR #73's plan carried the opposite standing instruction.
The line:

- **Structural assertions stay untouched.** The 29 `tbody tr` references in
  `e2e/audit.spec.ts`, its eleven count assertions, its three `.log__empty`
  assertions, and `e2e/admin.spec.ts:504`. Nothing in this branch moves an
  element. If one of those breaks, PR #73's rule applies unchanged: stop.
- **Exactly two `.json__peek` text assertions change.** A third one changing
  means a declaration went further than the table in section 4.

### Commands

Run and quote before any completion claim: `npm run format:check`,
`npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`. The unit
suite defaults to the shared `:5433` Postgres and is not worktree-safe; e2e is.
An e2e run rewrites `tsconfig.json` and may touch `AGENTS.md`; both are tracked,
so recover them with `git checkout`, never by deleting.

## Out of scope

- No `audit_log` migration, no backfill.
- The other fifteen payload-free access-control actions stay payload-free. They
  were reviewed against the product question and none of them answers it.
- The nine `payout.*` actions, for the reason given in the Problem section:
  they record ISK distribution, not access. Six of them render through the
  generic fallback today and still will afterwards.
- Searching by the name of a deleted character. Covered in full under
  `character.unlinked` above: the name recorded in `details` makes a found row
  legible and does not make it findable, and closing that needs a jsonb index
  and a new `FilterResolution` kind.
- Resolving a payload uuid to a human name. This is why `character.unlinked`
  records a name rather than an account id, and it is a follow-up, not a
  dependency.
- PR #73's deferred pacing and hierarchy pass (its Appendix A) stays deferred.
  Nothing here changes the page's layout, column widths, or ink distribution.

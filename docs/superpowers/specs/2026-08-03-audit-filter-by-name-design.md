# Audit log: filter by the names you can now see

Date: 2026-08-03
Branch: `fix/audit-filter-by-name`, off `main` at `c84694f` (PR #43, merged)

## Problem

PR #43 resolved audit actors and targets to human names, so the log reads in
under a minute. Filtering still doesn't. `queryAuditLog` matches actor and
target with `eq()` on the raw column, so an admin who sees "Zed" in a row and
wants Zed's history has to go find Zed's account UUID and paste it in. The
names are on screen and are not clickable.

PRODUCT.md sets the bar: an admin can answer "why is this person's role wrong?"
from the audit log in under a minute. Retyping a UUID is the remaining bite out
of that.

## Approach

**Resolve names to ids on input, with union semantics, as the single query
path; plus click-to-filter as a second entry point that emits the same
name-based URL.**

Rejected: matching on name in SQL via a join. `audit_log` carries one index, on
`at` (`src/db/schema.ts`), and this query does not use it — it rides the primary
key descending with `lt(id, before)`. A name join would drag `character` and
`account` across that scan on every page. Resolving first and matching with
`inArray` leaves the audit scan shape exactly as it is today (PK descending →
filter → `limit 100`); only the IN-list widens. The name work moves onto
`character` and `account` instead, where it is bounded by those tables' size
rather than by audit history — see the honest cost below.

### What the name lookup actually costs

Neither `character.name` nor `account.main_character_id` is indexed. Confirmed
against `drizzle/*.sql`: the only indexes in the schema are `audit_log_at_idx`,
`outbox_undispatched_idx`, `session_expires_at_idx` and
`sync_run_job_type_id_idx`. So queries 1 and 2 below are **sequential scans**.
Query 3 is the exception — `discord_link.account_id` is that table's primary
key, so it is index-backed.

That is acceptable here, not free: `character` and `account` are alliance-scale
(hundreds of accounts, low thousands of characters), bounded by alliance size
rather than by time, and the lookup runs at most twice per page render. Audit
history, by contrast, grows without bound — which is exactly why the name match
belongs on these tables and not in a join across `audit_log`. If the member
tables ever grow enough to matter, the fix is an index on `lower(character.name)`
and on `account.main_character_id`; that is a migration, and it is recorded with
the other index follow-ups below.


Click-to-filter and typed-name resolution are complementary and both ship: the
first serves the admin scanning a page, the second serves one arriving with a
name from Discord. They converge on one URL form, so there is one query
semantic to reason about and test.

### Index question (raised, deliberately not answered)

Filtering `audit_log` by actor or target is *already* an unindexed predicate
over a PK-descending scan. For a rare actor, Postgres walks far back to fill
100 rows, and that degrades as the table grows. This change does not make it
hotter — same predicate, longer IN-list. The fix, when it is needed, is
`(actor, id DESC)` and `(target, id DESC)`. That is a migration, and this is a
read-path-only change, so it is recorded here as a known follow-up rather than
added.

## Repository evidence

| Fact | Source |
| --- | --- |
| `resolveAuditIdentities` landed in PR #43, squash-merged to `main` as `c84694f` | `git log origin/main` |
| Actor is monomorphic: always an account UUID or the literal `"system"` | all 25 `logAudit(` call sites under `src/` |
| Target is polymorphic — account UUID, EVE character id, or Discord snowflake | `src/services/accounts.ts:89,232,272`, `src/jobs/wanderer.ts:76`, `src/services/discord-link.ts:73,81`, `src/jobs/discord-roles.ts:94` |
| `character.name` has no unique constraint and no index | `src/db/schema.ts:47-62` |
| `audit_log` has one index, on `at` | `src/db/schema.ts` |
| The ≤4-query budget assertion targets `resolveAuditIdentities` directly, not `queryAuditLog` | `tests/audit-resolve.test.ts:186-196` |
| `queryAuditLog` is called with a non-UUID raw actor in tests | `tests/audit-query.test.ts:40` |

### The decisive finding

One person appears in the target column under up to three different raw
strings. Clicking "Zed" on a `discord.role_changed` row and filtering by that
row's literal target would set `?target=<snowflake>`, hiding every
`tier.changed` row about the same person. The admin would get a page that looks
like Zed's history and is not — arguably worse than today, where the UUID at
least announces itself as one identifier.

This is why the filter unions across identifier forms rather than pinning one.

## Design

### Service — `src/services/audit.ts`

One new export, inverting `resolveAuditIdentities` along the same three display
paths so that clicking any rendered name lands inside its own result set.

```ts
export type FilterResolution =
  | { kind: "raw";  ids: string[] }                              // pasted uuid / digits / "system" / "all"
  | { kind: "name"; name: string; ids: string[]; accountCount: number }
  | { kind: "none"; name: string };                              // a name that matched nothing

export async function resolveFilterIdentity(
  dbx: Dbx, field: "actor" | "target", value: string,
): Promise<FilterResolution>
```

**Raw shapes short-circuit to zero queries.** A UUID, an all-digits string, or
one of the two reserved literals returns `{kind:"raw", ids:[value]}` without
touching the database.

The reserved literals are exactly `"system"` (actor) and `"all"` (target).
`"all"` is not optional: `src/app/admin/sync/actions.ts:13,25` write it as a
real target for `sync.requested` and `sync.recheck_requested`, and
`resolveAuditIdentities` already classifies it as `targetKind: "literal"`.
Omitting it would send `?target=all` down the name path, match no character,
and regress a filter that works today. A grep of every `logAudit` call site
confirms these two are the complete set — no other literal actor or target
exists.

**Raw values are echoed, not resolved.** `kind:"raw"` carries ids only, so the
filter chip shows exactly what was pasted. The tempting alternative — resolving
a pasted id to a display name — founders on a raw digit string, which without
an action to disambiguate it could be either an EVE character id or a Discord
snowflake, and would need a fallback order plus up to two extra queries to
guess. The row cells still resolve to names via `resolveAuditIdentities`, so
the page stays legible; only the chip echoes the input.


**The name path issues at most three queries:**

1. `character where lower(name) = lower($1)` → every character id with that name;
2. `account where main_character_id IN (…)` → the accounts that *display* that name;
3. `discord_link where account_id IN (…)` → their snowflakes (target only).

Actor ids are accounts only, because actor is monomorphic. Target ids are the
union of accounts, characters, and Discord ids.

An **alt's** name resolves to that character's ids but to no account ids, which
is correct: no account row displays an alt's name.

**`accountCount` counts distinct accounts the filter can surface**, not
accounts displaying the name. Those differ, and the difference is the whole
point of the metric. Query 1 already returns each matching character's
`account_id`, so the count is computed from data already in hand, at no extra
query. It is field-aware, because the two fields surface different rows:

- **actor** — accounts whose main displays the name. An alt's name can never
  appear in the actor column, so counting its owning account would overstate.
- **target** — those accounts *plus* the accounts owning a matched character,
  since matched character ids are in the target union and those rows belong to
  the owning account.

Counting only accounts-displaying-the-name would let two same-named alts on two
different accounts widen the results while the page reported no ambiguity at
all, which is precisely the failure this warning exists to catch.

The heading therefore reads `matches 2 accounts` rather than the
`2 people named Zed` of the approved mock. "People" was the wrong noun once
alts are in scope: an alt is not a separate person, but it *is* a separate
account boundary, and the account is the thing an admin acts on in the accounts
table.


**`queryAuditLog` stays id-based.** Its `actor` / `target` filters become
`actorIds?: string[]` / `targetIds?: string[]`: length 1 → `eq` (today's plan,
unchanged), greater than 1 → `inArray`, length 0 → return `[]` without touching
`audit_log`. `action` is untouched — it is already a prefix match and is fine.

Resolution deliberately sits *outside* `queryAuditLog`. `tests/audit-query.test.ts:40`
passes `{ actor: "admin-1" }`, a raw actor that is not UUID-shaped; any
shape-sniffing inside the query function would silently reinterpret it as a name
and return nothing. Keeping the query function id-only makes that impossible.

This changes two lines in `tests/audit-query.test.ts` (`{actor:"admin-1"}` →
`{actorIds:["admin-1"]}`, and the same for `target`). Disclosed rather than
silent; the alternative — keeping both a scalar and an array parameter — would
leave two ways to express one filter.

### Page — `src/app/admin/audit/page.tsx`

```
actorRes, targetRes  ←  Promise.all(resolveFilterIdentity × 2)   // 0 queries when absent or raw
rows                 ←  queryAuditLog({ actorIds, action, targetIds, beforeId })
```

Four visible changes:

- **Names become links.** `ActorCell` / `TargetCell` wrap the resolved name (and
  `system`) in an `<a>`. `title={r.actor}` and `ellipsis-cell` stay, so the raw
  id remains one hover away. The href carries every current param **except
  `before`** — clicking narrows and resets to page 1, which keeps the keyset
  pagination coherent. Unresolved ids stay plain text: they are already exactly
  filterable by paste, and linking them would add tab stops that buy nothing.
- **The filter chip needs no change at all.** This falls out of the two
  decisions above: click-to-filter emits a name, so the param *is* the name and
  PR #43's `activeFilters` already renders it; a pasted raw id is echoed by
  choice. In both cases the chip is the parameter, which is what
  `actor: ${params.actor}` already prints. An earlier draft of this spec
  promised a resolved name in the chip for pasted UUIDs — that contradicted the
  zero-query raw path and is withdrawn.
- **The heading carries the widening, per field.** Each resolution with
  `accountCount > 1` contributes a note, joined with ` · `:
  `14 matching entries · actor "Zed" matches 2 accounts · target "Rix" matches
  3 accounts`. With one ambiguous field only its own note appears; with neither,
  the heading is unchanged. Text, not colour.
- **The empty state names the field that failed.** Any resolution of
  `kind:"none"` guarantees zero rows, so the page short-circuits without
  querying `audit_log` at all. The message enumerates every unmatched field
  rather than describing one:
  - one field — `No account or character named "Zed" (actor).`
  - both — `No account or character named "Zed" (actor) or "Rix" (target).`
  - neither, but nothing matched — today's `Nothing matches this filter.`

  These are three different problems with three different fixes, and a single
  message for all of them sends the admin looking in the wrong place.


No new `'use client'` module: a link is an `<a>` and the filter stays a plain
GET form.

### Styling — `src/app/globals.css`

One rule, `.cell-link`: `color: inherit`, `text-decoration: underline` with
`text-decoration-color: var(--rule-strong)`, resolving to `var(--ink)` on hover
and focus. Gold stays spent on the `Filter` submit, honouring DESIGN.md's one
gold primary action per view. The underline and cursor carry the affordance, so
colour is not the only signal. The global gold focus ring applies unchanged.

## Compatibility

- Pasting a raw UUID, a character id, or `"system"` behaves exactly as before,
  through the `kind:"raw"` path.
- `before=` keyset pagination is unchanged; the `older` link keeps copying
  params verbatim, and a name in the URL is simply re-resolved per page.
- The `clear` link is untouched.
- No schema change, no migration, no write-path change.

## Testing

**Unit** — raw UUID, `"system"` and `"all"` still exact-match (regression
guards; `"all"` is the `sync.*` broadcast target and would otherwise be read as
a name); name resolves to account rows; the union case returns account-UUID,
character-id and snowflake rows together for one name; an alt's name returns
character rows only; an ambiguous name returns both accounts with
`accountCount: 2`; **two same-named alts on different accounts report
`accountCount: 2`** (the metric's whole reason for existing — it must not read
0); a non-matching name returns `[]` with `audit_log` never queried; matching is
case-insensitive; query budget is 0 for a raw value and ≤3 for a name;
`beforeId` paging works under a name filter.

**Combined actor + target** — both ambiguous produces two heading notes; one
unmatched short-circuits to zero rows and names that field; both unmatched names
both fields; one name plus one pasted raw id resolves and filters correctly
together.

**E2E**, extending `e2e/audit.spec.ts` — clicking an actor name navigates to
`?actor=Boss`; clicking a target name yields a union page showing both a
`tier.changed` (account UUID) row and a `discord.role_changed` (snowflake) row;
a typed name works; a pasted UUID still works; `?target=all` still returns the
`sync.*` rows; `clear` still works; the ambiguous-name heading appears.

**Commands** — `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`.

## Environment notes

- Unit tests run against the `authgd-ci-pg` container on **port 5434**
  (`postgres://authgd:authgd@localhost:5434/authgd_test`). Port 5433 is held by
  `authgd-design-postgres-1` and produces spurious failures.
- Playwright's `reuseExistingServer` will silently attach to another worktree's
  dev server on port 3111. Run e2e from a throwaway config on a free port with
  `reuseExistingServer: false`, and delete it before committing.

## Out of scope

- The `action` filter. It is already a prefix match and is correct.
- Indexes — a migration, so recorded as follow-ups rather than added:
  `(actor, id DESC)` and `(target, id DESC)` on `audit_log` for the filter
  predicate, and `lower(character.name)` plus `account.main_character_id` for
  the name lookup. None are needed at current scale; all are the right fix if
  either side grows.
- Any change to the write path or to `logAudit`.
- Renaming or restructuring anything PR #43 introduced.

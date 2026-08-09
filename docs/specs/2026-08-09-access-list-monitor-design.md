# Access-list monitor — design

**Date:** 2026-08-09
**Status:** approved, not yet implemented

## Purpose

Admins need to know whether authGD's member roster and the in-game ESI access
lists agree. The ESI access-list endpoints are **read-only**, so this page
informs; it never reconciles. Every correction is an in-game action a human
takes.

## Scope

In scope: a new admin page, a scheduled read job, a pure comparison function,
an optional OAuth scope, and an id→name cache.

Out of scope, deliberately: any write to an access list (the API offers none),
alerting or Discord notification (page-only for v1 — `logAuditIfChanged` and the
ops webhook remain available if admins turn out not to check the page), and
per-admin watchlists.

## Decisions

### The scope is opt-in, and its loss is made visible

`esi-access.read_lists.v1` is **not** added to `EVE_SSO_SCOPES`. Doing so would
flip every character to `needs_reauth` at the next 03:00 UTC token-health run
(`src/jobs/token-health.ts:103-105`), because that job compares granted scopes
against the required set.

Two mechanisms already support opt-in with no schema change:

- `character.scopes` (`src/db/schema.ts:70`) stores what EVE actually granted,
  read from the JWT `scp` claim. This is the same mechanism
  `getMainCharacterWithScope` uses for `esi-ui.open_window.v1`.
- token-health's check is "nothing missing", not set equality, so a character
  carrying an **extra** scope stays `valid`.

The only change needed: `buildEveAuthorizeUrl` (`src/lib/esi/sso.ts:36`) gains an
optional `extraScopes` parameter, and `/auth/eve/link` accepts `?grant=access-lists`.

**The grant is not sticky, and cannot be.** An earlier draft of this design had
the link route union in "whatever scopes the character already holds". That is
unimplementable: EVE's own character picker runs *after* the authorize URL is
built, so at the moment `/auth/eve/link` constructs the scope string there is no
"the character" yet. Identity is learned only from the callback JWT
(`src/app/auth/eve/link/route.ts:8-17`,
`src/app/auth/eve/callback/route.ts:76-83`).

Two escapes were considered and rejected. **Account-wide union** — request the
union of every scope any of the account's characters holds — would make every
future alt link start asking for the ACL scope, broadening an opt-in grant to
characters nobody opted in for. **Character-targeted state** — carry the intended
character through the transaction — touches the OAuth state flow, which CLAUDE.md
names as a stop-and-ask surface, and would still be a guess, since the member can
pick a different character at the EVE picker regardless.

So the scope **can** be dropped: an admin who granted it and later clicks the
ordinary re-auth link (`src/app/account/page.tsx:799,1090`;
`contact-state.tsx:223` — all plain `<a href="/auth/eve/link">`) loses it.
Rather than prevent that, the monitor **detects and announces** it. The page
already reads the holder's `character.scopes`; a holder missing
`esi-access.read_lists.v1` renders the same re-grant call to action as a holder
that never had it. A silent failure becomes a loud one, with no change to the
state flow, matching the existing `needs_reauth` → one-click-re-auth idiom.

### The OAuth state flow is not touched

The obvious design — a new `oauthIntentEnum` value so the callback sets the
holder — would mean an enum migration and a callback branch, on the surface
CLAUDE.md flags as stop-and-ask.

Instead the callback is unchanged: it stores granted scopes exactly as today.
Designation is a **separate explicit server action** on the admin page, which is
also the right place for the replace-confirm. Cost: two clicks instead of one,
and the callback returns to `/account` so the admin navigates back. A `returnTo`
would fix the papercut but *would* touch state, so it is excluded.

### One designated ACL holder

A single character reads all lists. Whoever completes the grant flow and clicks
"Designate as holder" becomes it, stored in a singleton row. Replacing requires
an explicit confirm, because a different holder may see a different set of lists
and watched rows can go "not visible to holder".

This is a single point of failure by design: if the holder's token goes bad, its
grant is dropped, or its character is unlinked, the whole page goes dark. That is
four distinct ways to fail, so the page treats them as first-class states rather
than rendering zero rows — see *States, in priority order*, and the
*Stale-holder guard* for what happens when designation changes mid-run.

### Discrepancy means effective access

A member has access if **any** of: their character is listed, their corporation
is listed, their alliance is listed, or `allow_everyone` is set.

Two buckets:

- **Missing access** — member characters the list does not cover.
- **Has access, not a member** — characters the list covers who are not on our
  roster.

**The second bucket is only complete for explicit `characters[]` entries.** A
list granting a corporation or alliance may cover many non-members, and authGD
cannot enumerate them: it stores a `corporationId` per character but has no corp
or alliance roster, and ESI offers no cheap membership read for a corp we hold
no roles in.

Therefore every broad grant is surfaced with a partial answer — "covers 12 of our
members, plus an unknown number of others" — computed from our own characters'
`corporationId` / `allianceId`, needing no extra ESI call. The page never claims
a corp-granted list is fully accounted for.

`allow_everyone` is reported in its own words: such a list has zero missing
members *by construction*, so "0 discrepancies" would read as "correctly
configured" when it means "open to everyone".

### `universeName` is not reused for character names

Its table comment (`src/db/schema.ts:228-240`) promises fork operators that "no
personal data lands here — systems, NPC stations and player structures are
places, not people". Character names are people. A separate `esi_entity_name`
cache carries its own honest comment. It is batch-shaped
(`POST /universe/names/`, 1000 ids per call) where `resolveUniverseName` is
one-id-at-a-time, so the split is natural regardless.

### Reads happen in a job, never during render

A live fetch on page render would burn a refresh-token rotation per load (EVE
rotates on use), block on two round-trips, have no staleness concept to display,
and be dead in dry-run. It would also put an ESI dependency in the web tier.

The page reads Postgres only. A "Check now" button **enqueues** an outbox row;
the worker performs the read — the same shape `/admin/sync`'s re-run buttons
already use.

## Data model

Generated with `npm run db:generate`; never hand-written.

| Table | Shape | Notes |
|---|---|---|
| `access_list_holder` | `id integer PK CHECK (id = 1)`, `characterId → character.id ON DELETE CASCADE`, `designatedAt`, `designatedBy` | Singleton: one row or none |
| `access_list_catalog` | `accessListId PK`, `name`, `discoveredAt`, `observedByCharacterId` | Lists the holder can see; feeds the picker; delete-all/insert-all per discovery |
| `access_list_watch` | `accessListId PK`, `addedAt`, `addedBy` | The shared watchlist, curated by admins |
| `access_list_snapshot` | `accessListId PK`, `observedAt` (nullable), `lastAttemptAt`, `readStatus`, `observedByCharacterId`, `name`, `description`, `allowEveryone`, `detail` | One row per watched list |
| `access_list_entry` | `accessListId`, `kind` ∈ character\|corporation\|alliance, `entityId`, `access` (verbatim text), unique on the triple | Membership rows |
| `esi_entity_name` | `id PK`, `kind`, `name`, `fetchedAt` | Character/corp/alliance name cache |

Three design points that are load-bearing:

**The holder FK cascades.** A bare `.references(() => character.id)` defaults to
`NO ACTION`, which would make `delete(character)` fail with a constraint
violation for whoever happens to be the holder — breaking both existing deletion
flows: unlink (`src/services/accounts.ts:198-205`) and transfer reclaim
(`:482-505`, `:583-609`). The repo already specifies this explicitly where it
matters; `payoutParticipant.recipientCharacterId` uses `onDelete: "set null"`
(`src/db/schema.ts:386-388`). `set null` is not available here — the singleton's
`characterId` is NOT NULL — so **cascade**: the holder row disappears and the
page falls back to the "no holder" state it already defines. Losing the holder
by unlinking a character is a real event an admin should see, and the page says
so rather than erroring.

**Snapshot split from entries** is what distinguishes "read succeeded, list is
empty" (snapshot row, zero entries) from "never read" (no snapshot row) from
"read failed, here is the last good one" (snapshot row, `readStatus` ≠ ok, stale
`observedAt`). `wandererAclObservation` gets this for free by being a single
global list; we do not.

**Two timestamps, not one.** `observedAt` is the last *successful* read;
`lastAttemptAt` + `readStatus` + `detail` describe the latest attempt.
Collapsing them forces a choice between lying about freshness and discarding
the failure.

### Stale-holder guard

`observedByCharacterId` on both observation tables exists to reject writes from
a holder that is no longer designated. Outbox execution is explicitly
at-least-once (`src/worker/dispatcher.ts:124-136`), so a job that started under
holder A can still be mid-flight when an admin designates holder B — and since
the catalog is delete-all/insert-all, A's late write would replace B's view of
the world wholesale.

The job therefore re-reads the holder inside the write transaction and skips the
write when it no longer matches the character it read with, the same
compare-and-swap shape the token code uses to discard stale concurrent decisions
(`src/services/tokens.ts:100-115`). A skipped write counts as
`counts.holderChanged` and returns `ok` — the next run, under the new holder,
produces the correct state. Different holders may see different lists, so this
is not a merge; it is a discard.

## The job

`src/jobs/access-lists.ts`, job type `access-lists`, cron `25 * * * *`
(a free slot: `:00/:30` membership, `:05` contacts, `:10` wanderer, `:15`
discord-roles, `:02,17,32,47` location — `src/core/schedules.ts:10-21`). Wrapped
in `runJob` for a `syncRun` row, `/admin/sync` visibility, and pg-boss
retry/backoff.

Group is **`on-demand`**, not `sweep`. `sweep` is defined as "the four jobs the
primary 'sync everything' fan-out enqueues" (`src/core/schedules.ts:44-50`), and
that fan-out is a hardcoded list in `jobsFor({kind:"all"})`
(`src/core/dispatch-plan.ts:67-73`) — so labelling this job `sweep` without
editing that list would make the group name a lie. `on-demand` means "reachable
from a dedicated control other than the fan-out", which is exactly what the
"Check now" button is, alongside `membership-recheck`'s "Recheck invalid
affiliations". **`jobsFor` is therefore left untouched**: a read-only monitor has
no business being triggered by "sync everything", which exists to push member
state outward.

Registration is three edits, all compile-enforced: `JOB_CRON` + `JOB_GROUP`
(a `Record<JobType, JobGroup>`, so a cron key with no group is a compile error),
`QUEUES` + `JOB_QUEUES`, and the handler map with a strict Zod payload.
`RERUNNABLE` needs **no** edit — it derives from `QUEUES`
(`src/worker/dispatcher.ts:22-24`), and `isJobType` is the actual runtime gate
(`src/core/dispatch-plan.ts:74-81`).

Order of operations:

1. **No holder** → `ok` with `counts.noHolder = 1`. An unconfigured optional
   feature must not paint `/admin/sync` red; the monitor page explains it.
2. **Token** via `getFreshAccessToken`, whose four outcomes are
   `no_token | invalid | transient | dry_run` (`src/services/tokens.ts:17-23`) —
   there is no `needs_reauth` arm, and the service performs invalidation
   internally (`:92-98`, `:126-133`), so the job must **not** repeat the CAS:
   - `dry_run` → `ok` + `counts.skipped` (as `src/jobs/contacts.ts:105-114`).
   - `transient` → `{ retry: true }`.
   - `no_token` / `invalid` → `failed` without retry. The page explains it; see
     the dark-monitor state below.
3. **Scope check** — a holder whose `character.scopes` lacks
   `esi-access.read_lists.v1` returns `ok` + `counts.scopeMissing`, without
   calling ESI. Calling anyway would spend a token refresh to earn a certain 403.
4. **Discovery** — `GET /characters/{id}/access-lists` returns **ids only**, so
   each id whose name is not already cached costs a detail call. Catalog
   replaced delete-all/insert-all in one transaction, under the stale-holder
   guard.
5. **Per watched list** — `GET .../access-lists/{id}`; on success write snapshot
   and replace that list's entries in one transaction. On failure **leave prior
   entries intact**: the wanderer rule, "never remove on unknown state"
   (`src/jobs/wanderer.ts:41-54`), applies verbatim — a wiped snapshot renders
   as "everyone lost access".
6. **Names** — batch unresolved ids through `getUniverseNames`, upsert the
   cache. Never throws; unresolved ids render bare.

A 403 from either endpoint is classified as a scope/permission failure the way
contacts classifies its own (`src/jobs/contacts.ts:224-240`) — recorded on the
snapshot's `readStatus` as "not visible to holder" rather than treated as a token
fault, since a list the holder simply cannot see is a normal state, not an error.

## The comparison

`src/core/access-list-compare.ts` — pure, no I/O, unit-tested standalone like
every diff in `src/core/`.

```
compareAccessList({ membership, roster }) → {
  missingAccess: RosterCharacter[];  // member characters with no effective access
  nonMembers: number[];              // listed character ids not on the roster
  matched: number;
  broadGrants: BroadGrant[];         // allow_everyone / corporation / alliance,
                                     // each with our own covered-member count
}
```

The roster side is `getMemberCharacters` — the same desired set every other sync
diffs against, so this page cannot disagree with the contacts and Wanderer syncs
about who a member is.

Deliberately **not** named `diffAcl`-style with `add`/`remove`: that vocabulary
implies a mutation we cannot perform, and read-only is this feature's premise.
It shares the word "ACL" with `src/core/acl-diff.ts` (Wanderer, a third-party
mapping tool authGD *writes* to) and nothing else.

## The page

Route `/admin/access-lists`, as the established `page.tsx` / `view.ts` /
`actions.ts` triple, `export const dynamic = "force-dynamic"`, and its own
`await requireAdminPage()` — the layout guard does not re-run on soft navigation
and never sees server actions. Nav entry added beside `MEMBERS`/`AUDIT`/`SYNC`
in `_components/nav-items.ts`, label string appearing exactly once (WCAG 3.2.4).

### States, in priority order

Each is a distinct sentence, never a bare empty table. States 3–5 are the
**dark-monitor** cases: the single-holder design makes them the most likely way
this feature fails, so each names the holder, says plainly that no reads are
happening, and gives the one action that fixes it.

1. No holder, your character lacks the scope → what the page is for, "Grant access".
2. Your character has the scope, no holder set → "Designate as holder".
3. Holder set, but its `character.scopes` no longer contains
   `esi-access.read_lists.v1` → the grant was dropped by an ordinary re-auth
   (see *The scope is opt-in*); "Re-grant access".
4. Holder set, `tokenStatus` is `needs_reauth` → the standard one-click re-auth.
5. Holder set, `tokenStatus` is `invalid` or `missing` → `getFreshAccessToken`
   returns `no_token` for both (`src/services/tokens.ts:67-73`), so no read can
   ever succeed until the character re-authenticates. Distinct from 4 because
   the remedy differs: `missing` means no stored token at all.
6. Holder healthy, catalog empty → "No lists discovered yet", "Check now".
7. Normal.

States 3–6 all render the last successful observation alongside the problem,
with its age — a stale answer plus its date beats a blank page.

### Normal view

A head naming the current holder and last run time — the honest-staleness
pattern from the crew drawer's "Map observed …Z". A picker to add a list from
the catalog. Then one row per watched list.

**Only rows with something to report expand.** A clean list is one line with no
disclosure control; a drifted one opens to detail. This keeps the page scannable
in the common case, where everything is fine.

Status tone follows the repo rule — `bad` is reserved for destructive acts, so
drift is `warn`, never `bad` (PRODUCT.md: nothing reads as punishment). Colour is
never the sole carrier of meaning; every tone is paired with text.

| State | Tone |
|---|---|
| In sync | `ok` |
| N missing / N has-access-not-a-member | `warn` |
| `allow_everyone` | `warn`, own wording |
| Read failed / not visible to holder | `warn`, with last good observation and its age |

### Detail content

- **Missing access (N)** — member character names, with account and corporation.
- **Has access, not a member (N)** — resolved names of character entries absent
  from the roster.
- **Broad grants** — each with its resolved name and our partial count.

Names lead and ids are secondary: the admin retypes these in-game.

### Actions

Four admin actions: `designateHolderAction`, `addWatchAction`,
`removeWatchAction`, `checkNowAction`. All enqueue; none call ESI.

`removeWatchAction` sits inside a row and must **return** an `ActionOutcome`
through `useActionState` — a redirect replaces the route tree, resets
`Disclosure`'s `useState`, and closes the drawer the admin opened
(`src/app/admin/sync/actions.ts:35-66`). The other three sit outside any drawer
and redirect with the usual `?done=&at=` markers.

**Every one writes an audit row.** CONTRIBUTING.md:60-63 — "Every state change
writes an audit row. Tier changes, links, unlinks, admin actions, sync outcomes
— with the actor and the cause." The `designatedBy` and `addedBy` columns record
only the *current* state, so without audit rows a holder replacement or a watch
removal leaves no history of who did it or what it displaced.

| Action | Audit | Details |
|---|---|---|
| Designate holder (first time) | `access_list.holder_designated` | new character id |
| Designate holder (replacing) | `access_list.holder_replaced` | previous and new character id |
| Add watch | `access_list.watch_added` | list id and name |
| Remove watch | `access_list.watch_removed` | list id and name |

`target` is the character id for the holder actions and the access-list id for
the watch actions. `checkNowAction` writes none: enqueuing a read changes no
state, and `runJob` already records the run in `syncRun` — the same reason
`/admin/sync`'s re-run buttons audit `sync.requested` at the *request*, not the
execution.

These are the first audit actions whose noun carries an underscore
(`access_list.`, against `account.` / `character.` / `payout.`). The alternative,
`accesslist.`, reads worse; the convention is `noun.verb_past` and the noun is
genuinely two words.

## ESI client changes

- `request()` (`src/lib/esi/client.ts:132`) gains a base override: these
  endpoints are not under the hardcoded `/latest` base (`client.ts:6`).
- An `X-Compatibility-Date` header, which nothing in the repo sends today. This
  is the first use of a convention that will spread.
- `getAccessLists(characterId, accessToken)` and
  `getAccessList(characterId, accessListId, accessToken)`, consumed by jobs as a
  narrow `AccessListsEsi = Pick<EsiClient, ...>` alias, per `ContactsEsi`.
- `getUniverseNames(ids)` — unauthenticated `POST /universe/names/`, chunked
  1000, following `resolveIds`'s chunking.

Reads are never dry-run suppressed (only writes are), but
`getFreshAccessToken` refuses in dry-run, so the job still no-ops there.

### Parsing: envelope closed, `access` open

The envelope **fails closed** — a malformed body is a permanent `EsiError`, as
`safeParse` already enforces. The `access` field **fails open** as `z.string()`:
a `z.enum` would turn CCP adding one value into a total read failure for a field
nothing acts on. Recognized values are interpreted; anything else renders
verbatim.

## Verification

- `tests/access-list-compare.test.ts` — effective access by each of the four
  grant paths, both buckets, `allow_everyone`, corp grants with the partial
  covered-member count, empty list. Shape follows `acl-diff.test.ts`.
- `tests/access-lists-job.test.ts` — fake ESI, real DB, following
  `contacts-job.test.ts`: no holder, holder missing the scope, each of
  `getFreshAccessToken`'s four outcomes, **a failed read leaving prior entries
  intact**, the two-timestamp behaviour, and **a write discarded because the
  holder changed mid-run**.
- `tests/access-lists-actions.test.ts` — an audit row per admin action, and the
  replace path recording both the previous and the new character id.
- **A migration test that deleting the holder character succeeds** and leaves no
  holder row, exercising the cascade against the real unlink path rather than
  trusting the FK declaration.
- `tests/dispatcher.test.ts` — already asserts `RERUNNABLE` equals `JOB_CRON`'s
  keys, so adding the queue and the cron entry is covered by an existing test
  rather than a new one. Confirm it still passes; a failure there means the two
  edits drifted.
- `tests/esi-client.test.ts` additions — new base and `X-Compatibility-Date`,
  `getUniverseNames` batching.
- `e2e/access-lists.spec.ts` — seeds holder/watch/snapshot rows **directly**,
  since dry-run forbids live reads, and asserts all seven page states plus the
  drifted-row disclosure. Same approach as `sync.spec.ts`.
- Gates: `npm test`, `npm run typecheck`, `npm run format:check`,
  `npm run test:e2e`, `npm run build`.

## Assumptions to verify first

This design is built from published docs, not a live response. **The first
implementation step is a spike with a real token against one list**, settling:

1. Whether `/access-lists` paginates (`x-pages` present or not). If it does,
   follow `getAllContacts`'s fail-closed loop (`client.ts:240-285`). If the
   header is simply absent, treat as single-page — failing closed on a
   non-paginating endpoint would break it outright.
2. The real value set of `access`.
3. That the `/latest`-less base plus `X-Compatibility-Date` behaves as the
   documented curl implies.
4. What a watched list the holder can no longer see returns — 403, 404, or an
   empty membership. The third is the dangerous one: it is indistinguishable
   from "everyone was removed", and the job would record a real-looking
   observation of an empty list. If the spike shows that shape, the job must
   treat a watched list absent from `/access-lists` as unreadable and skip it
   rather than fetch it.

If the spike contradicts any of these, revisit before generating migrations.

## Known limitations

- Corp- and alliance-granted access cannot be fully enumerated (see
  *Discrepancy means effective access*). The page states this rather than
  implying completeness.
- Dry-run deploys show no observations at all. The page says "no reads performed
  in dry-run" rather than "no drift".
- A single holder means a single point of failure. Accepted deliberately; an
  explicit pick among several granted characters is the upgrade path if it
  proves annoying.
- The grant flow returns to `/account`, not back to the monitor page.
- The scope can be dropped by an ordinary re-auth and nothing prevents it. The
  page detects the loss and asks for a re-grant; it cannot stop it happening
  (see *The scope is opt-in, and its loss is made visible*).
- Unlinking the holder's character silently deletes the designation, by cascade.
  The audit row for the unlink records the character; nothing separately records
  that a holder designation went with it, so the page's recovery signal is
  "no holder designated" rather than "your holder was unlinked on X".

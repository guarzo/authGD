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

### The scope is opt-in and sticky, not global

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

**Sticky:** the link route unions in whatever scopes the character already holds.
Without this, an admin who granted the scope and later clicks the ordinary
re-auth link (`src/app/account/page.tsx:799,1090`; `contact-state.tsx:223` — all
plain `<a href="/auth/eve/link">`) is silently downgraded and the monitor goes
dark with no visible cause.

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

This is a single point of failure by design: if the holder's token goes bad, the
whole page goes dark. The page therefore names the holder and its token state
prominently rather than merely rendering zero rows.

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
| `access_list_holder` | `id integer PK CHECK (id = 1)`, `characterId → character.id`, `designatedAt`, `designatedBy` | Singleton: one row or none |
| `access_list_catalog` | `accessListId PK`, `name`, `discoveredAt` | Lists the holder can see; feeds the picker; delete-all/insert-all per discovery |
| `access_list_watch` | `accessListId PK`, `addedAt`, `addedBy` | The shared watchlist, curated by admins |
| `access_list_snapshot` | `accessListId PK`, `observedAt` (nullable), `lastAttemptAt`, `readStatus`, `name`, `description`, `allowEveryone`, `detail` | One row per watched list |
| `access_list_entry` | `accessListId`, `kind` ∈ character\|corporation\|alliance, `entityId`, `access` (verbatim text), unique on the triple | Membership rows |
| `esi_entity_name` | `id PK`, `kind`, `name`, `fetchedAt` | Character/corp/alliance name cache |

Two design points that are load-bearing:

**Snapshot split from entries** is what distinguishes "read succeeded, list is
empty" (snapshot row, zero entries) from "never read" (no snapshot row) from
"read failed, here is the last good one" (snapshot row, `readStatus` ≠ ok, stale
`observedAt`). `wandererAclObservation` gets this for free by being a single
global list; we do not.

**Two timestamps, not one.** `observedAt` is the last *successful* read;
`lastAttemptAt` + `readStatus` + `detail` describe the latest attempt.
Collapsing them forces a choice between lying about freshness and discarding
the failure.

## The job

`src/jobs/access-lists.ts`, job type `access-lists`, cron `25 * * * *`
(a free slot: `:00/:30` membership, `:05` contacts, `:10` wanderer, `:15`
discord-roles, `:02,17,32,47` location), group `sweep`. Wrapped in `runJob` for
a `syncRun` row, `/admin/sync` visibility, and pg-boss retry/backoff.

Registration is four compile-enforced edits: `JOB_CRON` + `JOB_GROUP`
(a `Record`, so a missing group is a compile error), `QUEUES` + `JOB_QUEUES`,
the handler map with a strict Zod payload, and `RERUNNABLE` — a cron key absent
from `RERUNNABLE` renders a re-run button whose outbox row is silently dropped.

Order of operations:

1. **No holder** → `ok` with `counts.noHolder = 1`. An unconfigured optional
   feature must not paint `/admin/sync` red; the monitor page explains it.
2. **Token** via `getFreshAccessToken`. `dry_run` → `ok` + `counts.skipped`
   (as `contacts.ts:105-114`). `transient` → `{ retry: true }`.
   `invalid`/`needs_reauth` → CAS `tokenStatus` guarded on the token blob
   (as `contacts.ts:230-239`), then `failed` without retry.
3. **Discovery** — `GET /characters/{id}/access-lists` returns **ids only**, so
   each id whose name is not already cached costs a detail call. Catalog
   replaced delete-all/insert-all in one transaction.
4. **Per watched list** — `GET .../access-lists/{id}`; on success write snapshot
   and replace that list's entries in one transaction. On failure **leave prior
   entries intact**: the wanderer rule, "never remove on unknown state"
   (`src/jobs/wanderer.ts:41-54`), applies verbatim — a wiped snapshot renders
   as "everyone lost access".
5. **Names** — batch unresolved ids through `getUniverseNames`, upsert the
   cache. Never throws; unresolved ids render bare.

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

Each is a distinct sentence, never a bare empty table:

1. No holder, your character lacks the scope → what the page is for, "Grant access".
2. Your character has the scope, no holder set → "Designate as holder".
3. Holder set, token `needs_reauth` → names the holder, says the monitor is dark
   until re-granted. The single-point-of-failure state, so it is loud.
4. Holder healthy, catalog empty → "No lists discovered yet", "Check now".
5. Normal.

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

`addWatchAction` and `checkNowAction` sit outside any drawer and redirect with
the usual `?done=&at=` markers. `removeWatchAction` sits inside a row and must
**return** an `ActionOutcome` through `useActionState` — a redirect replaces the
route tree, resets `Disclosure`'s `useState`, and closes the drawer the admin
opened (`src/app/admin/sync/actions.ts:35-66`).

All three enqueue; none call ESI.

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
  `contacts-job.test.ts`: no holder, dry-run, transient retry, **a failed read
  leaving prior entries intact**, and the two-timestamp behaviour.
- `tests/esi-client.test.ts` additions — new base and `X-Compatibility-Date`,
  `getUniverseNames` batching.
- `e2e/access-lists.spec.ts` — seeds holder/watch/snapshot rows **directly**,
  since dry-run forbids live reads, and asserts all five page states plus the
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

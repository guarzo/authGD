# Structure damage monitor — design

Status: implemented
Date: 2026-08-24

Monitor the corp's own structures and post a Discord alert when one takes
damage. Modelled closely on the access-list monitor
(`docs/specs/2026-08-09-access-list-monitor-design.md`), which established the
designated-holder pattern this feature reuses.

## Outcome

One character grants two opt-in ESI scopes. An hourly job keeps a roster of the
corp's structures; a ten-minute job polls that character's notifications for the
four damage types and posts each new one to Discord. An admin page at
`/admin/structures` states what is true and offers the remedy when it is not.

## Scope sources

Two scopes, both deliberately absent from `EVE_SSO_SCOPES`:

- `esi-corporations.read_structures.v1` — the roster. Requires the
  **Station_Manager** corp role in game.
- `esi-characters.read_notifications.v1` — the damage events. Corp structure
  notifications are only _delivered_ to a **Director or CEO**.

`esi-universe.read_structures.v1` is already in `EVE_SSO_SCOPES`
(`docs/ops.md:21`) and is a different scope — it resolves a structure's name for
the location job. Confusing the two produces a feature that authorizes cleanly
and returns nothing.

Both are granted together by `/auth/eve/link?grant=structures`, which maps to
that exact literal pair. The link route refuses free-form scope params
(`src/app/auth/eve/link/route.ts:18-22`); this preserves that.

The grant is not sticky — any ordinary re-auth link drops it, because EVE's
character picker runs after the authorize URL is built. The page detects the loss
and asks for a re-grant, exactly as `/admin/access-lists` does.

## Data model

Four tables, two enums, one generated migration (`npm run db:generate` — never
hand-written). All four go into `MANAGED_TABLES` (`src/db/tables.ts`);
`tests/seed-dev.test.ts:135-149` asserts set equality in both directions, so an
omission fails a test rather than rotting.

### `structure_holder`

Singleton, copied from `accessListHolder` (`src/db/schema.ts:280-294`):
`id integer PRIMARY KEY` pinned by
`structure_holder_singleton_ck CHECK (id = 1)`,
`character_id bigint NOT NULL REFERENCES character(id) ON DELETE CASCADE`,
`designated_at`, and `designated_by text NOT NULL` (account uuid or `"system"`,
carried over verbatim from the precedent at `src/db/schema.ts:291`). Two columns
access-lists does not have:

- `corporation_id bigint NOT NULL` — **pinned at designation time**, not read
  live. `character.corporationId` is overwritten from affiliation every thirty
  minutes (`src/jobs/membership.ts:125`). Following it live means a holder who
  changes corp silently re-rosters against the new corp and stamps
  `missing_since` on every previous structure — rendered identically to
  "destroyed", arriving during the exact incident this tool exists for. Pinning
  turns that into a loud `corp-changed` state instead.
- `seeded_at timestamptz` — null means this holder has never completed a poll.
  The events job seeds silently when null and alerts when not. `designateHolder`
  writes it null, so replacing the holder re-seeds: a new holder is often a
  different corp whose whole 90-day backlog would otherwise read as new and fire
  at once.

Re-seeding is necessary but **not sufficient** to make holder replacement safe
across a corp change. `seeded_at` only governs how *newly discovered* events
are recorded; it says nothing about events already sitting at `pending` from
the previous holder's corp, which the sender would otherwise pick up and post
under the new holder. When the new holder is in a DIFFERENT corp,
`designateHolder` retires every `pending` row — see `abandoned` below. When
the new holder is in the SAME corp, nothing is retired: those `pending` rows
are still for the corp being watched and are still owed their alert, so
abandoning them would silently drop a live attack.

Not generalised into a shared `service_character(role, character_id)` table
alongside `access_list_holder`. That is the obvious dedupe and it would mean
migrating a table already in production — out of scope here, recorded as
follow-up.

### `structure_read_state`

Composite primary key `(kind, corporation_id)` — `kind text` is `'roster'` or
`'events'`. Then `observed_at`, `last_attempt_at`, `read_status`, `detail`.

Two timestamps, not one, for the reason `accessListSnapshot` gives
(`src/db/schema.ts:316-326`): `observed_at` is the last _successful_ read and is
null until there is one; `last_attempt_at` + `read_status` + `detail` describe
the most recent attempt either way. Collapsing them forces a choice between lying
about freshness and discarding the failure.

Keyed by kind rather than duplicated as columns on the holder because the two
reads fail independently — notifications can 403 on Director while the roster
reads fine on Station_Manager, and the page should say which.

Keyed **also** by corporation because the row describes a read against one
specific corp. Without it, replacing the holder leaves the previous corp's
freshness and 403 state in place, and the page reports the new holder's monitor
as healthy on the strength of a read that happened against a corp it no longer
watches. The page reads the row for the currently pinned corp; rows for other
corps are inert history.

This table exists because `sync_run` cannot serve it: `counts` is
`Record<string, number>` and `error_summary` is free text
(`src/db/schema.ts:218-231`). A page deriving `no-corp-roles` by pattern-matching
a job's count keys or error prose is exactly the drift the snapshot split
prevents.

### `structure`

Roster. `structure_id bigint PRIMARY KEY`, `corporation_id`, `type_id`,
`type_name`, `system_id`, `name`, `state text`, `state_timer_start`,
`state_timer_end`, `fuel_expires`, `observed_at`, `missing_since`.

`state` is `text`, not a pgEnum, for the reason `accessListEntry.access` is
(`src/db/schema.ts:344-355`): a state string CCP adds next patch must not fail
the read.

`type_name` is denormalized at read time. There is no type-id name cache to use:
`universe_name`'s kind enum is `["system","station","structure"]`
(`src/db/schema.ts:239-243`) and `resolveEntityNames` deliberately drops
inventory types from `getUniverseNames` results, because an unmodelled category
would fail the whole insert (`src/services/entity-names.ts:76-80`).
Denormalizing touches neither cache.

A structure that stops appearing gets `missing_since` stamped, never deleted —
"never remove on unknown state" (`src/jobs/access-lists.ts:277-283`). From the
roster's side a destroyed Astrahus and a 403 are identical; only the event stream
distinguishes them.

### `structure_event`

`notification_id bigint PRIMARY KEY` — ESI's own id, which is what makes "seen"
idempotent. `type text` verbatim, `sent_at timestamptz` (ESI's timestamp),
`structure_id bigint` nullable, `corporation_id bigint NOT NULL`, `alert_status`,
`details jsonb`.

`corporation_id` is stamped at insert from the holder's **pinned** corp, not
parsed from the body. It is what the sender filters on: pending rows are selected
for the currently pinned corp only, so a row recorded under a previous holder can
never be posted under a new one. Without it the seed-silently rule protects only
newly discovered events and leaves the already-`pending` ones to fire under a
holder that never saw them.

`structure_id` is nullable because the notification body is YAML and a parse can
fail; a failed parse still records the event as seen and still alerts, without a
structure name.

`details` holds only the parsed subset actually rendered — attacker corp,
alliance, character, damage percentages, timer end. Everything else is dropped.
`/characters/{id}/notifications/` returns **every** notification type for that
character: war decs, mail, kill rights, corp applications, insurance. The job
filters to the four structure types and persists nothing else, so no personal
notification reaches Postgres. Same posture the `character.location*` docblock
takes about member location.

No retention policy, and none is expected: `docs/ops.md:240-255` records that
append-only records of fact are deliberately exempt from `purge.ts`, with the gap
documented in ops.md instead. `structure_event` follows `audit_log`.

### Enums

```ts
export const structureReadStatusEnum = pgEnum("structure_read_status", [
  "ok",
  "forbidden",
  "failed",
]);
export type StructureReadStatus = (typeof structureReadStatusEnum.enumValues)[number];

export const structureAlertStatusEnum = pgEnum("structure_alert_status", [
  "seeded",
  "pending",
  "sent",
  "abandoned",
]);
export type StructureAlertStatus = (typeof structureAlertStatusEnum.enumValues)[number];
```

The four values are distinct states, not shades of one:

- `seeded` — recorded without alerting, because this holder had never polled
  (or because no webhook was configured; see Alerting).
- `pending` — recorded and owed an alert.
- `sent` — posted successfully.
- `abandoned` — was `pending` when the holder was replaced with one in a
  DIFFERENT corp, and will never be posted. Written by `designateHolder` in
  the same transaction as the new designation. A same-corp replacement writes
  none of these: those rows are still owed to the corp being watched.

`abandoned` is a fourth value rather than a reuse of `seeded` because the two
answer different questions. `seeded` means "deliberately not alerted, by the
first-run rule"; `abandoned` means "owed an alert that no longer has a valid
recipient." Collapsing them would make it impossible to tell, from the table,
whether a holder swap silently swallowed a live attack.

`structure_read_status` is not a reuse of `accessListReadStatusEnum` — its
`not_visible` means something else, and coupling two features' enums makes the
next CCP change a two-feature migration.

## Jobs

Two job types, both `on-demand` in `JOB_GROUP` (both reachable from the page's
own Check now, which is what that group means — `src/core/schedules.ts:48-74`):

```ts
"structures": "35 * * * *",
"structure-events": "3,13,23,33,43,53 * * * *",
```

Slots chosen off the busy minutes for the reason recorded at
`src/core/schedules.ts:18-24`: :00/:05/:10/:15/:25/:30 and :02,17,32,47 are
taken. `formatCadence` supports evenly-spaced comma minutes
(`src/core/schedules.ts:175-203`), so the admin page renders the ten-minute
cadence correctly rather than falling back to the raw cron.

Ten minutes matches the notifications endpoint's 600s cache exactly; polling
faster returns the same cached page. The roster endpoint caches for an hour.

Both jobs share the access-lists staging (`src/jobs/access-lists.ts:36-132`):

1. No holder → `{status:"ok", noHolder:1}`. An unconfigured optional feature must
   never paint `/admin/sync` red.
2. Persisted-scope check against `character.scopes` **before** any network call.
3. `getFreshAccessToken`, four-way branch.
4. `stillHolder(tx, characterId)` compare-and-swap before every write, so a
   holder swapped mid-flight cannot have another character's read written under
   their name.

### `structures`

Reads the **pinned** `structure_holder.corporation_id`. If the holder's current
`character.corporationId` differs, the job writes `read_status = 'failed'` with
`detail = 'corp-changed'` and mutates no roster rows.

Otherwise fetches `/corporations/{id}/structures/` and, in one transaction,
upserts each row and stamps `missing_since` on any structure absent from the
response. A 403 sets `read_status = 'forbidden'`, returns `status: "partial"`,
and mutates no roster rows.

### `structure-events`

Fetches notifications, filters to `StructureUnderAttack`,
`StructureLostShields`, `StructureLostArmor`, `StructureDestroyed`, and parses
each YAML body.

**Resolve the webhook URL before the insert, not at post time.** If neither
`structureWebhookUrl` nor `opsWebhookUrl` is set, there is no recipient, and an
event recorded as `pending` would be marked `sent` by a post that never
happened — `postOpsWebhookOrThrow` returns early and successfully when no URL is
configured (`src/lib/ops-webhook.ts:47-48`). So the insert status is:

```
alert_status =
  no webhook configured        -> 'seeded'
  holder.seeded_at === null    -> 'seeded'
  otherwise                    -> 'pending'
```

Recording as `seeded` when unconfigured is deliberate: it keeps the table honest
(nothing is owed an alert that can never be delivered), it keeps the pending set
from growing without bound, and configuring a webhook later starts alerting on
genuinely new events rather than replaying the backlog. The page says so via the
`alerts-unconfigured` state rather than claiming alerts go to Discord.

In one transaction: insert each event `ON CONFLICT DO NOTHING` with that status
and with `corporation_id` stamped from the holder's pinned corp, and if seeding,
stamp `seeded_at`.

After commit, select all `pending` rows **for the currently pinned corp** — which
naturally includes leftovers from a previous run's failed sends, and naturally
excludes anything recorded under a previous holder — post each, flip to `sent`. A
failed post leaves the row `pending`; the run returns `"partial"`, not
`"failed"`, because the ten-minute tick is the retry and pg-boss's retry budget
is for a run that accomplished nothing (`src/services/sync-run.ts:36-47`).

Posting happens after commit, so a crash between the two re-sends next tick.
At-least-once: a duplicate Discord post is possible and preferred to a lost one.

**No age cutoff.** If the worker is down for a long weekend, the first run back
alerts on every structure notification from that window at once. Correct per the
seed-silently rule, and loud. The mitigation, if it ever bites, is a cutoff
constant in `src/core/structure-event.ts`.

### Pagination

`/corporations/{id}/structures/` is paginated. The ESI client already knows how
to do this: `getAllContacts` (`src/lib/esi/client.ts:320-358`) reads `x-pages`
off the first response, rejects a missing or non-integer header as a `transient`
`EsiError` rather than guessing, and loops pages 2..N. It is covered directly by
`tests/esi-client.test.ts:109-163`.

The fail-closed behaviour is the valuable part and the comment says why: "an
unknown page count means an unknown contact set, and the downstream diff
deletes. Never guess (spec: never remove on unknown state)." That reasoning
transfers exactly — this roster's `missing_since` stamping is also a
diff-that-removes, so a silently truncated page set would mark real structures
missing.

So this feature **generalises the existing loop** rather than inventing one:
extract the page walk from `getAllContacts` into a shared helper, keeping its
header validation and error class verbatim, and have both callers use it.
`getAllContacts` keeps its current observable behaviour, pinned by the tests
above.

### Pure core

`src/core/structure-event.ts` — no I/O, unit-tested: a tolerant flat
`key: value` YAML reader returning a partial record, the Discord line formatter,
and the roster sort. No YAML dependency; the bodies are flat enough that a small
parser beats adding one, and a parse failure returns nulls rather than throwing,
so a body CCP reshapes costs a structure name, not the alert.

### Error classification

`classifyEsiError` maps 403 to `needs_reauth` only when the body matches
`/scope|token|authorization/i`, otherwise `permanent`
(`src/core/errors.ts:22-32`). A corp-roles 403 reads "Character does not have
required role(s)" — no match — so it classifies `permanent`, which is what keeps
`forbidden` distinct from a token fault. This is load-bearing on CCP's error
prose and gets a test pinning it.

### Dry run

`getFreshAccessToken` returns `dry_run` **before any network call**
(`src/services/tokens.ts:74-87`), because EVE SSO rotates the refresh token on
use. Both jobs therefore exit at the token stage in dry-run and never reach the
fetch or the post. The post step must stay after the token branch, never before,
or a dry-run worker would consume real pending alerts.

## Alerting

New optional `DISCORD_STRUCTURE_WEBHOOK_URL`, declared exactly as
`DISCORD_OPS_WEBHOOK_URL` is (`src/config.ts:79`, normalized at `:174`):

```ts
DISCORD_STRUCTURE_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
```

`postOpsWebhookOrThrow` currently reads `cfg.discord.opsWebhookUrl` internally,
so it grows an explicit url parameter; `postOpsWebhook(cfg, content)` keeps its
signature and delegates. New `postStructureWebhook(cfg, content)` resolves
`cfg.discord.structureWebhookUrl ?? cfg.discord.opsWebhookUrl`. The dry-run guard
and the 1900-character clamp stay where they are.

**Both may be absent**, and that case is load-bearing rather than degenerate.
`postOpsWebhookOrThrow` returns early and *successfully* when no URL is
configured (`src/lib/ops-webhook.ts:47-48`) — correct for its existing callers,
which have nothing at stake in a missing ops channel, and wrong for this one,
where a successful no-op would flip an owed alert to `sent`.

So the resolution is exposed rather than buried: a
`resolveStructureWebhookUrl(cfg): string | undefined` that both the job and the
page read. The job branches on it *before* inserting (see `structure-events`);
the page renders `alerts-unconfigured` from it. Neither infers delivery from a
post's return value, because that value cannot distinguish "delivered" from
"nowhere to deliver."

Nothing asserts `.env.example` matches the schema, so the var is added by hand in
four places: `src/config.ts`, `.env.example`, the `docs/ops.md` secret table
(`:348-371`) plus the first-deploy secrets block (`:14-28`), and
`playwright.config.ts` if a page ever reads it.

## Page

`/admin/structures`, admin-only, nav entry declared in
`src/app/_components/nav-items.ts` (covered by `tests/nav-items.test.ts`).

`page.tsx` guards itself with `requireAdminPage()` even though the layout guarded
— layouts do not re-run on soft navigation and never see server actions. Each
action re-guards with `requireAdminAction()` and parses its input with zod, not a
cast.

### State cascade

Priority order, in `view.ts`, mirroring `monitorState`:

| state                 | sentence                                                   | remedy                              |
| --------------------- | ---------------------------------------------------------- | ----------------------------------- |
| `grant-needed`        | No character has granted structure access.                  | `/auth/eve/link?grant=structures`   |
| `designate-needed`    | _Name_ granted structure access but is not the holder.      | Designate                           |
| `scope-dropped`       | _Name_ is the holder but no longer grants structure access. | Re-grant link                       |
| `holder-needs-reauth` | token fault                                                 | bare `/auth/eve/link`               |
| `holder-no-token`     | token fault                                                 | bare `/auth/eve/link`               |
| `corp-changed`        | _Name_ has left the corp the roster belongs to.             | Re-designate                        |
| `no-corp-roles`       | The corp refused the _roster_ / _notifications_ read.       | Text only                           |
| `roster-empty`        | Nothing read yet.                                           | Check now                           |
| `alerts-unconfigured` | _N_ structures. No Discord webhook is set, so nothing is alerted. | Text only                     |
| `normal`              | _N_ structures. Alerts go to Discord.                       | —                                   |

`alerts-unconfigured` sits directly above `normal` and is the only difference
between them: the monitor is working, the roster is real, and nothing will be
sent. It exists because `normal`'s sentence is otherwise a lie whenever neither
webhook is configured — and since an unconfigured webhook post returns
successfully (`src/lib/ops-webhook.ts:47-48`), nothing else on the page or in the
job would ever reveal it.

The scope check precedes the token check for the reason recorded at
`src/app/admin/access-lists/view.ts:40-54`: the plain re-auth link is what drops
the scope, so offering it first sends an admin round a loop that cannot
terminate.

`no-corp-roles` names which read is forbidden. It is not a token fault — the fix
is an in-game role grant nobody can make from this app, and conflating the two
sends an admin round the re-auth loop forever.

`corp-changed` is derived **live on the page**, by comparing
`structure_holder.corporation_id` to the holder's current
`character.corporationId` — not read from `structure_read_state.detail`. The page
must say so the moment affiliation updates, rather than waiting up to an hour for
the roster job's next tick to record it. The job writes
`read_status = 'failed'`, `detail = 'corp-changed'` independently, so the two
never contradict: the page states the condition, the read state records that a
run declined to act on it.

### Rendering

Roster table: name, system, type, state, timer, fuel. Read-only, sorted most
alarming first (reinforced above vulnerable above healthy). Below it, the last
~20 events with timestamp, structure, what happened, and the attacker corp or
alliance from the notification body.

`Check now` enqueues both job types via `enqueueSync` and writes no audit row —
asking for a read changes no state. No live ESI call on render, ever: the web
tier writes an outbox row and the worker performs every read.

DESIGN.md constraints that apply: no zebra striping; status `ok` is neutral
`--ink-dim` ("do not restore the green"); alarm is `--signal-bad` **border and
text, never filled**; gold rationed to one primary action per view; R1's two hit
grades (36px standalone, 28px in-row); R4 parity — no information exists only in
the AT channel.

Reinforced structures use the `bad` tone.
`src/app/admin/access-lists/view.ts:220-227` refuses that tone because PRODUCT.md
principle 4 reserves alarm colour for things the user can and should fix. A
structure in hull reinforce is precisely that — a fight you can still show up to.
This is the case the principle carves room for, not an exception to it.

## Audit

Two actions only, matching the access-list namespace shape, with entries in
`TARGET_KIND_BY_NAMESPACE`, `DETAIL_CHARACTER_KEYS`, and
`src/app/admin/audit/summarize.ts`:

- `structure.holder_designated` — target characterId, details
  `{characterId, corporationId}`
- `structure.holder_replaced` — target characterId, details
  `{previousCharacterId, characterId, corporationId, abandonedAlerts}`

`abandonedAlerts` is the count of `pending` rows retired to `abandoned` by that
replacement. It belongs in the audit row because it is the one number that says
whether a holder swap swallowed a live alert, and the swap is an admin action
nobody would otherwise connect to a missing Discord post.

Events are observations, not state changes; access-lists sets the precedent that
observations surface on the page rather than in the audit log. Read failures are
likewise not audited — `structure_read_state` holds that, which is why it earns
its place.

## Registries

Mechanical, but each omission fails somewhere different:

| Registry                | File                                                            | Failure mode if omitted             |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------- |
| `JOB_CRON`              | `src/core/schedules.ts:10-26`                                   | `JobType` never includes it         |
| `JOB_GROUP`             | `src/core/schedules.ts:76-86`                                   | compile error                       |
| `QUEUES` + `JOB_QUEUES` | `src/worker/queues.ts`                                          | boot throws on missing cron; a `JOB_CRON` key with no `QUEUES` entry also fails `tests/dispatcher.test.ts:128-132`, since `RERUNNABLE` (`src/worker/dispatcher.ts:22-24`) is derived from `QUEUES` and asserted equal to `JOB_CRON`'s keys |
| zod schema + handler    | `src/worker/handlers.ts`                                        | job never runs                      |
| `KNOWN_ORDER`           | `src/services/sync-status.ts:8-18`                              | sorts to the end of the sync page   |
| `MANAGED_TABLES`        | `src/db/tables.ts`                                              | `tests/seed-dev.test.ts` fails      |
| per-queue literals      | `tests/schedules.test.ts:113-118`, `tests/worker-queues.test.ts:40-47` | fail                          |
| ops.md job table        | `docs/ops.md:106-116`                                           | drifts silently                     |

## Testing

Following the existing eight-file shape:

- `tests/structure-event.test.ts` — the YAML reader against real bodies for all
  four types; a malformed body yields nulls rather than throwing
- `tests/structure-view.test.ts` — every branch of the cascade, including both
  `forbidden` variants, `corp-changed`, and `alerts-unconfigured`
- `tests/structure-job.test.ts` — seeding sends nothing; second run alerts only
  on new; a failed post leaves `pending` and the next run re-sends; `stillHolder`
  CAS rejects a mid-flight holder swap; 403 sets `forbidden` and mutates no
  roster rows; a corp-roles 403 body classifies `permanent`; **with no webhook
  configured, new events land as `seeded` and no row is ever marked `sent`**;
  **replacing the holder with one in a different corp retires pending rows to
  `abandoned` and the next run posts none of them**; **replacing the holder
  with one in the SAME corp retires nothing, and those rows still post**;
  **pending rows for a non-pinned corp are never
  selected**
- `tests/esi-client.test.ts` — extend the existing pagination coverage
  (`:109-163`) to the extracted shared helper, proving `getAllContacts` keeps its
  behaviour and the roster read fails closed on a missing `x-pages` too
- `tests/structure-service.test.ts`, `tests/structure-schema.test.ts`,
  `tests/structure-reads.test.ts`,
  `tests/admin-structure-actions-validation.test.ts`
- `e2e/structures.spec.ts` — designate, check now, roster renders from seeded
  rows

ESI is mocked by hand-rolling the narrowed `StructuresEsi` /
`StructureEventsEsi` `Pick<>` types, as `tests/access-lists-job.test.ts` does;
msw is only used for tests that exercise the real client.

**Coverage boundary:** e2e runs `SYNC_MODE: "dry-run"`
(`playwright.config.ts:27-73`), and dry-run cannot obtain a token, so Playwright
can only cover the state cascade, designation, and rendering from seeded rows.
Every alerting behaviour is proven in `tests/` against real Postgres.

## Rollout

The migration is additive: four tables, two enums, nothing rewritten, no
backfill, no index on an existing table (so no write-blocking `CREATE INDEX`
under the single-transaction migration batch — `docs/ops.md:180-244`).

Deploying without setting the webhook or designating a holder is inert: both jobs
return `{status:"ok", noHolder:1}` and the page shows `grant-needed`. The code
can ship before anyone grants a scope in game.

Migration numbering collides if another branch also generates `0013_*`; nothing
in-repo prevents that. Regenerate rather than hand-edit if it happens.

## Out of scope

Fuel alerts, low-power and anchoring notifications, structure timers as a
calendar, per-structure muting, alerting for any corp but the holder's own, and
the `service_character` generalisation that would dedupe `structure_holder`
against `access_list_holder`.

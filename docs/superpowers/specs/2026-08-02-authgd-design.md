# authGD — Design Spec

**Date:** 2026-08-02
**Status:** Approved (after 4 external review rounds), pre-implementation

## Purpose

A modern, minimal replacement for the Alliance Auth stack (AA + aa-standingssync-zoo +
aa-wanderer-map + zoo-aa theming) used by a single ~20-member corporation. It covers only
what the corp actually uses: EVE SSO login, alt character linking, automatic in-game
standings distribution, Wanderer map ACL management, Discord role management, and
automatic deprovisioning when members leave — with an audit log and an admin accounts
page for status/cryo tracking.

Out of scope for v1 (designed-for, built later): loot payout splits (aa-payout
replacement), read-only in-game structure ACL audit.

## Requirements

From the corp CEO, verbatim intent:

1. Manage ACL / Wanderer / Discord access.
2. Account page with alts linked.
3. Contact manager with automatic removal.
4. ESI login must request **all needed scopes on the first login per character** — no
   re-adding characters to grant more scopes.
5. Leaving members are **deroled, not booted**: three tiers (below). Accounts retain all
   linked characters and ESI tokens so returning members don't re-onboard.
6. Accounts page: mark people cryo/AFK with the date set and a notes field; sortable to
   quickly pull who is in cryo.

### Membership tiers

| Tier  | How set                          | Standings | Wanderer map | Discord role |
|-------|----------------------------------|-----------|--------------|--------------|
| FlyGD | auto: main character in alliance | +5 (all linked chars) | yes | FlyGD role |
| Blue  | manual (admin), `tier_locked`    | none      | no           | Blue role    |
| Green | auto on leaving alliance         | none      | no           | Green role   |

- All tiers keep account, linked characters, ESI tokens, and Discord link in the DB.
- Membership test: the account's **main** character's alliance == configured alliance ID.
  Alts may be in any corp/alliance.
- A Green account whose main rejoins the alliance is automatically restored to FlyGD.

### Tier state machine

- `tier_locked = false` (default): the tier is **system-managed** — the membership job
  sets `flygd` (main in alliance) or `green` (main not in alliance). Nothing else
  changes it.
- **Any manual tier set by an admin** (FlyGD, Blue, or Green — all three are allowed)
  sets `tier_locked = true`: the membership job never touches a locked account.
- Admins can **"return to auto"** (clear the lock); the next membership run then sets
  flygd/green from the main's affiliation. Blue therefore only exists as a locked tier —
  unlocking a Blue account converts it to system management.
- All transitions (manual or system) are audit-logged with actor and cause. Every
  tier/`tier_locked` combination is valid in the DB; semantics come from the rules
  above.

## Architecture (Approach A — approved)

TypeScript full-stack monolith, deployed as containers on a managed container platform
(Railway / Fly / Render); portable unchanged to a VPS with docker compose.

```
web (Next.js UI + API)  ──enqueue──▶  worker (pg-boss jobs)  ──▶  Postgres (data + queue)
        │                                    │
  EVE SSO, Discord OAuth          ESI · Wanderer API · Discord REST
```

- **One repo, one image, two containers** (different start commands) + Postgres.
- **web** — Next.js App Router. Member pages (login, account page, add character, link
  Discord) and admin pages (accounts list, audit log, tier controls). OAuth callbacks for
  EVE SSO and Discord live in API routes. Web enqueues on-demand sync jobs.
- **worker** — same codebase running pg-boss: scheduled + on-demand jobs, retries with
  exponential backoff, job history in Postgres. No Redis.
- **Integrations are outbound REST only.** Discord uses a bot token over REST for role
  changes — no gateway connection, no bot process. Wanderer uses the map API key.
- **Stack choices:** Drizzle ORM; `arctic`/`openid-client` for OAuth. Sessions are
  **server-side**: a `session` table (opaque random id, account, created/expires/
  last-seen) referenced by an HTTP-only cookie holding only the opaque id — so
  revocation (transfer reclaim, admin action) is a row delete that takes effect on the
  next request. Signed-cookie-only sessions are explicitly ruled out because they
  cannot be revoked.

### Configuration (env)

Alliance ID; EVE SSO client id/secret + scope set; standings label name + value (+5);
Wanderer base URL, API key, map/ACL id; Discord bot token, guild id, FlyGD/Blue/Green
role IDs, optional ops webhook URL; bootstrap admin character IDs; Postgres URL; session
secret; token-encryption key.

### Auth flows

- **EVE SSO:** first character login creates the account; that character is the main
  (changeable later). "Add character" runs the same SSO flow while logged in and links
  the new character. **Every character login requests the full configured scope set**
  (contacts read/write + any configured extras) — req. 4.
- **OAuth hardening:** both EVE SSO and Discord flows use `state` plus PKCE, backed by
  an **`oauth_transaction`** row: single-use, expiring (~10 min) record of state hash,
  intent (`login` / `link-character` / `link-discord`), initiating session/account, and
  PKCE verifier. Durable in Postgres, so it survives restarts and multiple web
  replicas. A callback is only honored against a live, unconsumed transaction matching
  its account and intent.
- **Conflict semantics & transfer reclaim:** when an SSO callback returns a character
  linked to a *different* account, compare the callback's `owner_hash` to the stored
  one **before** rejecting. Same hash → same owner, reject with "already linked"
  (moving a character between your own accounts is an admin action, audit-logged).
  Different hash → the character was sold: atomically unlink the stale link (applying
  the no-main rule below if it was that account's main), then proceed with the new
  owner's login/link. Re-authing a character already on *your own* account simply
  refreshes its token/scopes in place.
- **Scope evolution:** the configured scope set carries a version. The token health job
  flags characters whose granted scopes no longer cover the required set
  (`token_status: needs_reauth`); the account page shows a one-click "re-auth" per
  character that reruns SSO and updates the link in place — no unlink/re-add ever.
- **Ownership transfer** (rare; minimal policy): SSO `owner_hash` is stored; a mismatch
  detected on re-auth, on the reclaim path above, or on token refresh (where the
  provider returns one) invalidates the token and unlinks the character, audit-logged.
- **No-main rule (atomic):** whenever an account's main is unlinked (transfer, reclaim,
  admin action), the same transaction sets `main_character_id = null` and — unless
  `tier_locked` — tier to `green`, audit-logs the cause, and enqueues the deprovision
  jobs. The membership job *skips* null-main accounts (it only transitions on a
  confirmed affiliation read of a main). Admin list shows "no main"; the user logs in
  with any remaining character (or fresh SSO) and picks a new main. An account with
  zero characters simply stays Green until an admin deletes it.
- **Discord:** OAuth with `identify` scope only, stores the Discord user id.
  `discord_user_id` is unique — linking a Discord account already linked elsewhere fails
  with a clear error, so two accounts can never fight over one user's roles.
- **Admins:** `is_admin` flag on the account. Bootstrap admin character IDs (env) are a
  **one-time, consumable grant**: the first time an account links a bootstrap
  character, a `bootstrap_admin_grant` row is written (character id — unique —, the
  granting `owner_hash`, account, timestamp) and `is_admin` is set, audit-logged. A
  character with an existing grant row can never grant again — so a sold bootstrap
  character conveys nothing to its purchaser, even through the reclaim path. Ongoing
  admin management happens in the UI by existing admins.
  **Last-admin protection:** the last account with `is_admin` cannot be demoted or
  deleted. **Session revocation:** a transfer reclaim (character unlinked from an
  account because a new owner authenticated it) revokes all active sessions of the
  affected account; ordinary self-service unlink does not.

## Data model

Postgres via Drizzle. pg-boss adds its own job tables (job history = sync-run log).

- **account** — `id`, `created_at`, `last_login_at`;
  `tier` (`flygd|blue|green`), `tier_changed_at`, `tier_changed_by` (account id or
  `system`), `tier_locked` (bool);
  `status` (`active|cryo`), `status_changed_at`, `status_note`;
  `is_admin`, `main_character_id`.
- **character** — `id` (EVE character id), `account_id`, `name`, `corporation_id`,
  `alliance_id`, `affiliation_checked_at`, `affiliation_invalid` (bool — id no longer resolves, e.g.
  biomassed; excluded from affiliation batches), `owner_hash`, `refresh_token` (encrypted at
  rest), `scopes`, `token_status` (`valid|invalid|needs_reauth|missing`).
- **discord_link** — `account_id`, `discord_user_id` (**unique**).
- **session** — server-side sessions: `id` (opaque random), `account_id`,
  `created_at`, `expires_at`, `last_seen_at`. Cookie stores only the id.
- **bootstrap_admin_grant** — consumed bootstrap grants: `character_id` (**unique**),
  `owner_hash`, `account_id`, `granted_at`.
- **outbox** — transactional job triggers: `id`, `payload`, `created_at`,
  `dispatched_at`.
- **oauth_transaction** — single-use, expiring OAuth state: `id`, `state_hash`,
  `intent`, `session_id`/`account_id`, `pkce_verifier`, `created_at`, `expires_at`,
  `consumed_at`.
- **contact_sync_state** — `character_id`, `last_synced_at`, `last_result` (per
  push-target character).
- **sync_run** — application-level ledger, one row per job execution: `job_type`,
  `started_at`, `finished_at`, `status` (`ok|partial|failed`), `error_summary`, `counts`
  (jsonb: added/removed/skipped). The UI reads this, not pg-boss internals.
- **wanderer_acl_observation** — the last ACL state actually read from Wanderer:
  `character_id`, `role`, `observed_at` (replaced wholesale each successful ACL read).
  Powers the "Map" column with real observed membership rather than assumptions.
- **audit_log** — append-only: `at`, `actor` (account id | `system`), `action`
  (e.g. `character.linked`, `tier.changed`, `contacts.pushed`, `wanderer.removed`,
  `discord.role_changed`), `target`, `details` (jsonb).

Derived (computed, not stored):

- **Desired standings set:** every character of every FlyGD account, at +5, under the
  configured contact label.
- **Desired Wanderer ACL:** every character of every FlyGD account.
- Green/Blue accounts simply fall out of the desired sets; nothing is deleted.

## Sync jobs

All jobs are idempotent diff-and-apply (desired vs actual); re-running is always safe.

1. **Membership verification — every 30 min; the anchor.** Bulk-refresh all characters'
   corp/alliance via public ESI `/characters/affiliation` (no tokens). The endpoint is
   all-or-nothing per batch (one invalid/biomassed id fails the whole call), so: submit
   in chunks (≤500 ids); **only on a deterministic invalid-request response (400)**,
   bisect the chunk to isolate the bad ids and mark those characters
   `affiliation_invalid` (surfaced in admin, excluded from future batches; rechecked
   weekly and via an admin recheck button, since flags can be wrong or characters can
   be restored). Transient failures (420 rate-limit, 5xx, network) are never bisected
   or flagged — the batch just retries.
   Then per account (skipping `tier_locked`): main left alliance & `flygd` → `green`;
   main in alliance & `green` → `flygd`. **An account transitions only if its main's
   affiliation was confirmed in this run** — unresolved mains are left untouched. Each
   change is audit-logged and enqueues jobs 2–4.
2. **Contact push — hourly + on-demand.** ESI cannot *create* contact labels — labels
   must be made in-game, and the API only lists them. So, per push-target character,
   the job first reads the character's labels; if the configured label (e.g. `flygd`)
   is missing, it records `missing_label` in `contact_sync_state.last_result`, **skips
   all writes for that character**, and the UI (member page + admin list) shows the
   remediation: "create a contact label named `flygd` in-game, then re-sync." This is
   also part of onboarding copy at token grant. **Push targets, precisely:** every
   character belonging to a FlyGD account whose token is usable for **this job** —
   not revoked/invalid and granted the contacts read+write scopes (and has the label).
   `needs_reauth` is a *warning about incomplete capability*, never a global blocker:
   a token missing some newly added unrelated scope still syncs contacts if the
   contact scopes are granted. Every job gates on token validity plus *its own*
   required scopes; the desired set written to a given
   character **excludes that character itself**. When the label exists: read **all
   pages** of the character's contacts before diffing — if any page fails, abort that
   character's reconciliation for this run (a partial read is unsafe for destructive
   changes) — then fully reconcile against the desired set. **Label-ownership policy (same as aa-standingssync):** the app owns
   the configured label (e.g. `flygd`) outright, and users are told so in the UI at
   token grant. Within that ownership: desired characters are added (or, if they already
   exist as personal contacts, updated to +5 and given our label — the app takes them
   over); contacts carrying our label that leave the desired set are deleted entirely.
   Contacts never carrying our label are never modified. This accepted-destructive
   policy is deliberate and documented to users. Every scheduled run reconciles real
   state — no hash short-circuit — so manual in-game edits are repaired within the hour;
   duplicate on-demand triggers are coalesced via pg-boss singleton keys instead. This
   is both provisioning and automatic removal (req. 3).
3. **Wanderer ACL sync — hourly + on-demand.** Read the ACL via Wanderer API, diff
   against desired, add/remove members, then **re-read the ACL after any mutation (or
   partial failure) and persist that post-change read** into
   `wanderer_acl_observation` — the UI never shows pre-mutation state.
   **`admin`-role entries are never removed; `manager`-role entries are removed like
   anyone else** when not in the desired set. Every run reconciles from the live read,
   so manual ACL edits drift back within the hour.
4. **Discord role sync — hourly + on-demand.** Each run begins with a **config
   validation**: the three managed role IDs are distinct and exist in the configured
   guild, and the bot has Manage Roles with its highest role above all managed roles.
   Validation failure is classified *permanent-config*, not retryable: the run aborts
   with `sync_run.status = failed` + a clear error on the admin sync page and ops
   webhook, instead of retry-looping. For each Discord-linked account: ensure
   exactly the role matching its tier among the three managed role IDs (add the right
   one, remove the other two); other roles untouched. User not in guild → log and skip.
5. **Token health — daily.** Refresh stale tokens; **permanent OAuth failures only**
   (`invalid_grant`, revocation) mark `token_status: invalid` (surfaced to the member
   and on the admin list); transient failures retry silently. Also compares each
   character's granted scopes against the current required scope set and marks
   shortfalls `needs_reauth` (one-click re-auth in place — see Auth flows).
   `owner_hash` mismatch unlinks the character and audit-logs it (see Ownership
   transfer policy).

**On-demand triggers:** character linked/unlinked, Discord linked, tier changed by
admin, **main character selected/changed/unlinked** (enqueues an immediate
membership evaluation for that account), admin "sync now" button.

**Account creation:** conservative and never optimistic — the SSO callback creates the
account **unlocked, tier Green, affiliation unresolved** in one transaction and
enqueues an immediate membership evaluation for it; the account is promoted to FlyGD
and provisioned only after a *confirmed* affiliation read (normally seconds later).
The callback itself performs no ESI affiliation lookups, so a transient ESI failure
can neither block login nor partially provision.

**Ordering on tier change (uniform rule):** the state change and its trigger commit in
**one Postgres transaction** via an application **outbox** table: the transaction
writes the state change plus an outbox row ("sync account X"); a dispatcher in the
worker polls the outbox and enqueues the corresponding pg-boss jobs, marking rows
dispatched. pg-boss internal tables are never written directly (unsupported coupling);
if the selected pg-boss version offers a supported caller-owned-transaction API, the
outbox may be replaced by it during implementation. After dispatch, jobs 2–4 run and
retry independently — one failing integration never blocks the others. Hourly
scheduled reconciliation remains the backstop for anything missed.

## UI

- **Member account page:** linked characters with per-character token state ("needs
  re-auth"), main-character marker, add-character button, Discord link state, map access
  state, current tier.
- **Admin accounts page:** one row per account — main (+ expandable alts), tier with
  changed-at/by, lock indicator, and inline controls (set FlyGD/Blue/Green — which
  locks — or "return to auto"), cryo toggle + set-date + editable notes,
  token health, Discord linked, **Map** (characters actually present on the Wanderer ACL
  per last sync), **last login**. Sort/filter by tier, cryo status, name, tier-change
  date.
- **Admin audit log page:** filterable view of `audit_log`.
- **Admin sync page:** last runs per job from `sync_run` (status, counts, error
  summary), "sync now" buttons.
- The "Map" column reads `wanderer_acl_observation` (live-observed membership, with
  observed-at timestamp), never inferred state.

## Error handling

- **ESI etiquette:** honor `X-ESI-Error-Limit-Remain/Reset`; the shared ESI client
  pauses near the limit.
- **Retryable vs. permanent classification everywhere:** a character is marked
  `token_status: invalid` only on permanent OAuth errors (`invalid_grant`,
  revoked/consent-withdrawn); 420/429/5xx/network errors are transient and retry
  without changing state; missing-scope responses map to `needs_reauth`, not
  `invalid`. A permanently failed token never blocks the rest of a sync — mark and
  continue.
- **Retries:** pg-boss exponential backoff (~5 tries over ~30 min) on every job.
- **Partial-failure isolation:** contact push is per-character; results recorded in
  `contact_sync_state.last_result`.
- **Never remove on unknown state:** if a read (ACL, contacts) fails, skip removals that
  cycle rather than act on missing data. Membership demotion requires a *successful*
  affiliation response — an ESI outage can never mass-demote.
- **Ops alerting:** after final retry failure, post to the optional Discord ops webhook.
- **Deprovision audit:** every tier change logs its cause (`system: main left alliance`
  vs. admin name).

## Testing

- **Unit (vitest):** table-driven tests over the pure diff logic (contacts, ACL, roles)
  and tier-transition rules (incl. `tier_locked`, cryo, rejoin), plus the error
  classifiers (transient vs. permanent OAuth/ESI errors) and affiliation-chunk
  bisection.
- **Critical-path cases (unit or integration as appropriate):** OAuth transaction
  replay and expiry rejection; transfer reclaim (owner-hash mismatch clears stale link,
  revokes the old account's sessions); atomic null-main demotion + transactional job
  insert; `missing_label` skip + remediation surfacing; multi-page contact reads and
  abort-on-partial-read; scope-shortfall → `needs_reauth` → in-place re-auth;
  post-mutation Wanderer observation freshness; bootstrap-admin one-time semantics and
  last-admin protection.
- **Integration:** jobs against mocked ESI/Wanderer/Discord HTTP (msw) + real Postgres
  (testcontainers or dev compose), covering the full deprovision path: main leaves →
  green → contact removals + ACL removals + role change + audit rows.
- **Smoke (Playwright):** login-mocked pass over account page, admin list sort/filter,
  tier controls.

## Deferred / future

- **Loot payout splits** (aa-payout parity: Janice valuation, alt dedup, even split,
  scout bonus, payment tracking). The alt-linkage data model already supports dedup.
- **In-game structure ACL read audit** — pending confirmation of the ESI read endpoint.
- **Member-facing Discord notifications** (join/leave announcements, payout pings).
- Multi-map / multi-Wanderer-instance support (single instance+map assumed in v1).

## Key decisions log

- TypeScript full-stack (Next.js) over Elixir/Go/Python — user choice.
- Approach A: monolith + pg-boss worker over split API/SPA and over in-process cron.
- Alliance (not corp) as the membership base — flexibility.
- Auto-approve alt linking, with audit log; no approval queue.
- Standings mechanism: push to member characters' personal contacts (ESI cannot write
  corp/alliance contacts); label-scoped management.
- Derole-not-boot tier model; Green retains everything for frictionless return.
- Managed container platform deployment; design stays VPS-portable.

### From external review (2026-08-02)

- Label ownership is **accepted-destructive** within the configured label (aa-standingssync
  precedent); users are notified at token grant that the app owns the `flygd` label.
- Scheduled syncs always reconcile from live-read state (no hash short-circuit);
  singleton job keys handle duplicate triggers instead.
- Character transfer kept minimal (rare event): unlink + demote via the normal
  membership rule; admin surfaces "no main".
- OAuth: state + PKCE + intent binding; unique constraints prevent character/Discord
  links being claimed by two accounts.
- `sync_run` + `wanderer_acl_observation` added as application-level state for the UI.
- Affiliation batches chunked with bisection on failure; transitions require a
  confirmed read of the main.
- Tier state machine defined: any manual set locks; "return to auto" unlocks.
- Scope set versioned; shortfall ⇒ `needs_reauth` with in-place re-auth.

### From external review round 2 (2026-08-02)

- Contact labels cannot be created via ESI: `missing_label` state + skip writes +
  in-UI remediation ("create the `flygd` label in-game").
- No-main handling made atomic (unlink ⇒ green + deprovision in one transaction);
  membership job skips null-main accounts.
- Transfer reclaim: owner-hash comparison precedes the "already linked" rejection, so
  a sold character's stale link clears on the new owner's first login.
- Error classification: bisect only on deterministic 400s; token `invalid` only on
  permanent OAuth errors; `affiliation_invalid` rechecked weekly/on demand.
- `oauth_transaction` table added (durable single-use state + PKCE across replicas).
- Wanderer observation persisted from a post-mutation re-read.
- Account creation computes tier inline and provisions immediately; main
  selection/change/unlink triggers immediate membership evaluation.

### From external review round 3 (2026-08-02)

- Bootstrap admin = one-time grant at first link, never re-evaluated; last-admin
  protection; transfer reclaim revokes the affected account's sessions.
- Account creation is pessimistic: Green + unresolved affiliation, promoted only after
  a confirmed read by the enqueued evaluation (no ESI in the callback).
- Push targets defined precisely; self excluded from own desired set; full pagination
  required before destructive diff.
- Uniform transactional enqueue: state change + pg-boss job rows commit in one
  Postgres transaction; hourly reconciliation as backstop.
- Test plan extended to cover all round-2/3 critical paths.

### From external review round 4 (2026-08-02)

- Bootstrap admin grants persisted as consumed (`bootstrap_admin_grant`, unique per
  character, owner_hash recorded) — un-regrantable after transfer.
- Sessions moved server-side (opaque-id cookie + `session` table) so revocation is
  real.
- Transactional enqueue via application outbox + worker dispatcher; pg-boss internals
  never written directly (may swap for a supported caller-owned-tx API if the chosen
  version has one).
- Per-job scope gating: `needs_reauth` is a capability warning, not a global blocker.
- Discord role sync validates config (distinct roles, guild membership, Manage Roles +
  hierarchy) and fails permanent-config instead of retry-looping.

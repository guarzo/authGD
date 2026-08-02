# authGD — Design Spec

**Date:** 2026-08-02
**Status:** Approved design, pre-implementation

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
- `tier_locked` accounts (manual Blue) are never auto-changed by the membership job.
- A Green account whose main rejoins the alliance is automatically restored to FlyGD.

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
- **Stack choices:** Drizzle ORM; `arctic`/`openid-client` for OAuth; signed HTTP-only
  cookie sessions.

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
- **Ownership transfer:** SSO `owner_hash` is stored; a mismatch on re-auth or token
  refresh invalidates the token and unlinks the character (sold characters lose access).
- **Discord:** OAuth with `identify` scope only, stores the Discord user id.
- **Admins:** `is_admin` flag, bootstrapped from env character IDs, settable by other
  admins in the UI.

## Data model

Postgres via Drizzle. pg-boss adds its own job tables (job history = sync-run log).

- **account** — `id`, `created_at`, `last_login_at`;
  `tier` (`flygd|blue|green`), `tier_changed_at`, `tier_changed_by` (account id or
  `system`), `tier_locked` (bool);
  `status` (`active|cryo`), `status_changed_at`, `status_note`;
  `is_admin`, `main_character_id`.
- **character** — `id` (EVE character id), `account_id`, `name`, `corporation_id`,
  `alliance_id`, `affiliation_checked_at`, `owner_hash`, `refresh_token` (encrypted at
  rest), `scopes`, `token_status` (`valid|invalid|missing`).
- **discord_link** — `account_id`, `discord_user_id`.
- **contact_sync_state** — `character_id`, `last_synced_at`, `last_result`,
  `desired_hash` (skip no-op syncs).
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
   corp/alliance via public ESI `/characters/affiliation` (no tokens; 1000 ids/call).
   Then per account (skipping `tier_locked`): main left alliance & `flygd` → `green`;
   main in alliance & `green` → `flygd`. Each change is audit-logged and enqueues jobs
   2–4.
2. **Contact push — hourly + on-demand.** For each character of a FlyGD account with a
   valid `write_contacts` token: read contacts, manage **only contacts carrying our
   label** — add missing desired contacts at +5, delete labeled contacts not in the
   desired set, never touch unlabeled/personal contacts. Per-character `desired_hash`
   skips no-ops. This is both provisioning and automatic removal (req. 3).
3. **Wanderer ACL sync — hourly + on-demand.** Read the ACL via Wanderer API, diff
   against desired, add/remove members. **`admin`-role entries are never removed;
   `manager`-role entries are removed like anyone else** when not in the desired set.
4. **Discord role sync — hourly + on-demand.** For each Discord-linked account: ensure
   exactly the role matching its tier among the three managed role IDs (add the right
   one, remove the other two); other roles untouched. User not in guild → log and skip.
5. **Token health — daily.** Refresh stale tokens; failures mark `token_status:
   invalid` (surfaced to the member and on the admin list). `owner_hash` mismatch
   unlinks the character and audit-logs it.

**On-demand triggers:** character linked/unlinked, Discord linked, tier changed by
admin, admin "sync now" button.

**Ordering on tier change:** commit the tier flip first (single source of truth), then
jobs 2–4 run and retry independently — one failing integration never blocks the others.

## UI

- **Member account page:** linked characters with per-character token state ("needs
  re-auth"), main-character marker, add-character button, Discord link state, map access
  state, current tier.
- **Admin accounts page:** one row per account — main (+ expandable alts), tier with
  changed-at/by and inline Blue/Green controls, cryo toggle + set-date + editable notes,
  token health, Discord linked, **Map** (characters actually present on the Wanderer ACL
  per last sync), **last login**. Sort/filter by tier, cryo status, name, tier-change
  date.
- **Admin audit log page:** filterable view of `audit_log`.
- **Admin sync page:** last run/result per job, "sync now" buttons.

## Error handling

- **ESI etiquette:** honor `X-ESI-Error-Limit-Remain/Reset`; the shared ESI client
  pauses near the limit. Token 4xx → mark character invalid and continue; never blocks
  the rest of a sync.
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
  and tier-transition rules (incl. `tier_locked`, cryo, rejoin).
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

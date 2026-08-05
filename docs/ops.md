# authGD operations

## Deploy (Fly.io)

One image, two process groups (`web`, `worker`) plus a release command that
runs migrations before each deploy (`fly.toml`).

First deploy:

```bash
fly launch --no-deploy          # reuses fly.toml; create the app, don't deploy
fly postgres create             # or attach an existing cluster
fly postgres attach <pg-app>    # sets DATABASE_URL
fly secrets set \
  SESSION_COOKIE_NAME=authgd_session \
  TOKEN_ENCRYPTION_KEY=<base64 of 32 random bytes> \
  APP_BASE_URL=https://<public-hostname> \
  ALLIANCE_ID=... \
  BOOTSTRAP_ADMIN_CHARACTER_IDS=... \
  EVE_SSO_CLIENT_ID=... EVE_SSO_CLIENT_SECRET=... \
  EVE_SSO_SCOPES="esi-characters.read_contacts.v1 esi-characters.write_contacts.v1 esi-ui.open_window.v1" \
  DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... DISCORD_BOT_TOKEN=... \
  DISCORD_GUILD_ID=... DISCORD_ROLE_ID_MEMBER=... DISCORD_ROLE_ID_ASSOCIATE=... \
  DISCORD_ROLE_ID_ALUMNI=... DISCORD_OPS_WEBHOOK_URL=... \
  WANDERER_BASE_URL=... WANDERER_API_KEY=... WANDERER_ACL_ID=... \
  STANDINGS_LABEL=authgd STANDINGS_VALUE=5 \
  ESI_CONTACT="you@example.com" \
  SYNC_MODE=live
fly deploy
```

Set `APP_BASE_URL` to the hostname you intend to keep. If a custom domain is
coming, use it from the start rather than the `<app>.fly.dev` default: OAuth
redirect URIs derive from this value, so changing it later means re-registering
the callback URLs with both EVE SSO and Discord.

Deploy at `web=1`. Scaling to `web=2` comes after the connection-headroom
check below — two web machines double the pool count against one small
Postgres, so the check is the gate, not a formality.

`TOKEN_ENCRYPTION_KEY`: `openssl rand -base64 32`. Rotating it invalidates
every stored EVE refresh token (members re-auth); treat it as unrotatable.

## Monitoring

Two public endpoints, deliberately separate:

| Endpoint | 200 means | 503 means |
|---|---|---|
| `/api/health` | this web machine serves and Postgres answers | the process is up but the database is unreachable |
| `/api/health/sync` | a sync job ran within the last 90 minutes | the worker is dead, wedged, or has never run — or, with `"db":"error"`, the database is unreachable |

Both responses carry a `db` field (`"ok"` or `"error"`), so a 503 from
`/api/health/sync` distinguishes a stalled worker from a dead database without a
second request.

Only `/api/health` is wired into `fly.toml`. A failing Fly check removes the
machine from the load balancer and gates deploys, so pointing it at worker
freshness would take the site down over a fault that has nothing to do with
serving pages.

Something outside Fly has to poll these; Fly cannot tell you it is down, which
is the entire reason the external check exists. `.github/workflows/uptime.yml`
does it today as a stopgap — see [The external poll is a
stopgap](#the-external-poll-is-a-stopgap) for what it covers and what it does
not.

`/api/health` depends on Postgres, and the Fly check above has no
consecutive-failure threshold, so a single blip — including a planned
Postgres patching window (see Sizing and redundancy) — takes every web machine
out of rotation at once; they all share one database. This is accepted: without
Postgres the app cannot serve anything useful, so removing machines that can't
reach it costs little. The consequence is that once Fly's proxy stops routing,
Fly itself has nothing left to tell you — the external monitor is the only
party still watching the app from outside.

A database that is up but slow is handled by two cooperating timeouts. The
connection pool gives up after 5 seconds (`src/db/index.ts`), so the endpoint
answers 503 with `"db":"error"` rather than queueing forever; the Fly check
waits 10 seconds, so that answer arrives before the proxy gives up and reports
an opaque timeout with no body. If you change either, keep the pool's timeout
below the check's.

Notes:

- A `failed` run still counts as fresh. The endpoint measures whether the worker
  is alive, not whether jobs succeed. Job outcomes belong to `/admin/sync`; the
  ops webhook is narrower still, firing only on exhausted retries
  (`src/worker/index.ts`), permanent Wanderer read failures
  (`src/jobs/wanderer.ts`), and Discord role configuration errors
  (`src/jobs/discord-roles.ts`) — every other failure appears only in
  `/admin/sync`. Folding job outcomes into this endpoint would let one permanent
  config error hold the check red forever and train you to ignore it.
- A brand-new deploy reads 503 on `/api/health/sync` until the first `membership`
  tick, up to 30 minutes. This is intended: "never ran" is a real failure.
- Detection is not instant. A dead worker surfaces up to 90 minutes after its
  last run, plus your monitor's poll interval.
- The 90-minute threshold is a constant in `src/core/health.ts`, compared with
  `<=`. If you change a schedule in `src/worker/queues.ts` to something slower
  than 90 minutes for the most frequent job, change it there too.

## Sizing and redundancy — decisions, not defaults

- **512MB for both web and worker**, declared as `[[vm]]` blocks in `fly.toml`.
  The worker runs `tsx` and transpiles at runtime, so it carried the real OOM
  risk; both were raised to keep the groups uniform.
- **`web=2`** closes the deploy gap that `web=1` creates. The web tier is
  stateless — sessions and OAuth PKCE state are both in Postgres — so extra
  instances are safe. Machine count is not a `fly.toml` field; set it with
  `fly scale count`, after the headroom check below.
- **`worker=1`, deliberately.** The Wanderer reconcile is destructive; a second
  worker is not a change to make casually.
- **Single-node Postgres, deliberately.** HA adds real operational weight to an
  unmanaged `postgres-flex` cluster you already patch yourself.

**Before scaling to `web=2`, check connection headroom.** `fly postgres connect`
opens an interactive psql session; there is no flag for passing SQL (`-c` is the
config-file path):

```bash
fly postgres connect -a <pg-app>
```

Then at the prompt:

```sql
SHOW max_connections;
```

| Source | Connections |
|---|---|
| web pools (2 machines × `max` 5) | 10 |
| worker `createDb` pool | 5 |
| worker pg-boss pool | 5 |
| **steady state** | **20** |
| release command (capped at 1) | +1 |
| rolling replacement overlap, worst case | +15 |
| **deploy peak, worst case** | **~36** |

Confirm headroom above ~36 including superuser-reserved connections. If it is
short, lower the per-pool `max` in `src/db/index.ts` rather than skipping the
check. Once it clears:

```bash
fly scale count web=2 worker=1
```

## First-deploy Wanderer smoke check

The Wanderer client contract was confirmed from wanderer's source; verify it
against YOUR live instance once, at first deploy, with a throwaway character
id (any EVE character id not already on the ACL):

```bash
fly ssh console -C "sh -c 'cd /app && npm run smoke:wanderer -- <characterId>'"
```

PASS = read/add/remove all work. The script refuses to run against a
character already on the ACL.

## Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (set by `fly postgres attach`) |
| `SESSION_COOKIE_NAME` | no (default `authgd_session`) | session cookie name |
| `TOKEN_ENCRYPTION_KEY` | yes | base64, exactly 32 bytes; encrypts EVE refresh tokens at rest |
| `APP_BASE_URL` | yes | public URL; OAuth redirect URIs derive from it |
| `ALLIANCE_ID` | yes | membership anchor: main in this alliance ⇒ member |
| `BOOTSTRAP_ADMIN_CHARACTER_IDS` | no | comma-separated; see recovery caveat below |
| `EVE_SSO_CLIENT_ID` / `EVE_SSO_CLIENT_SECRET` | yes | EVE application credentials |
| `EVE_SSO_SCOPES` | yes | space-separated full scope set requested at every login. Adding a scope flips every existing character to `needs_reauth` until its holder logs in again — a capability warning, not an outage: `src/jobs/contacts.ts` gates per job on the scopes it actually needs |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | yes | Discord OAuth (identify only) |
| `DISCORD_BOT_TOKEN` | yes | bot with Manage Roles above the three managed roles |
| `DISCORD_GUILD_ID` | yes | the guild whose roles are managed |
| `DISCORD_ROLE_ID_MEMBER` / `_ASSOCIATE` / `_ALUMNI` | yes | the three managed role ids (distinct) |
| `DISCORD_OPS_WEBHOOK_URL` | no | ops alerts (final retry failures, config errors) |
| `WANDERER_BASE_URL` / `WANDERER_API_KEY` | yes | Wanderer instance + the **ACL's own** API key (the map API key returns 401 on `/api/acls/*`) |
| `WANDERER_ACL_ID` | yes | the managed ACL — dedicated to authGD, reconciled destructively |
| `STANDINGS_LABEL` | no (default `authgd`) | in-game contact label the app OWNS — see the warning below |
| `STANDINGS_VALUE` | no (default 5) | standing pushed for members |
| `ESI_CONTACT` | yes | operator contact sent in the ESI User-Agent (CCP requirement) |
| `SYNC_MODE` | **yes, no default** | `live` \| `dry-run`. `dry-run` suppresses every outbound mutation (see below). Production MUST be `live` |

### Adding an SSO scope

Every character's granted scopes are compared against `EVE_SSO_SCOPES` in four
places — `tokenFields` (`src/services/accounts.ts`), the token-health job
(`src/jobs/token-health.ts`), the member account view and the admin accounts
view (both `src/services/account-view.ts`). Adding a scope therefore flips
**every** existing character to `needs_reauth` on the first token-health run
after deploy, and writes one `token.needs_reauth` audit row per character.

Sync keeps working throughout: each job gates on the scopes it actually needs,
so a character missing only the new scope still syncs. The warning clears
per member as they log in again.

**Rolling this out to an already-running deployment** (not the first-deploy
case above): run

```bash
fly secrets set EVE_SSO_SCOPES="esi-characters.read_contacts.v1 esi-characters.write_contacts.v1 esi-ui.open_window.v1"
fly deploy   # only if the secret change did not already trigger the rolling restart
```

`fly secrets set` restarts the machines itself, so the `fly deploy` line is a
backstop, not a second required step. To confirm it took: `fly secrets list`
shows an updated digest/timestamp for `EVE_SSO_SCOPES`, and the new scope
appears on the EVE SSO consent screen the next time someone logs in.

## SYNC_MODE — the dry-run safety guard

`SYNC_MODE` is **required and has no default**. Every other arrangement has a
silent failure mode, so both production and development must state intent.

| Mode | Effect |
|---|---|
| `live` | normal operation — all outbound writes are real |
| `dry-run` | every outbound **mutation** is a logged no-op; **reads still happen** |

`dry-run` suppresses, at boundaries a job cannot bypass:

- ESI contact add / edit / **delete** (the job that once removed 130 contacts)
- Wanderer ACL add / remove / role change
- Discord role add / remove
- **EVE refresh-token rotation** — EVE rotates the refresh token on every use,
  so refreshing against production credentials silently invalidates the stored
  copy. This is destruction disguised as a read
- Discord ops-webhook posts, so a local worker never pages the real ops channel

It does **not** suppress the login / character-link OAuth exchanges: those mint
new credentials from a fresh authorization code and invalidate nothing.

In `dry-run` the Wanderer and Discord jobs write **no audit rows** and report
`wouldAdd` / `wouldRemove` / `wouldUnblock` / `wouldChangeRoles` instead of the
applied-change counters, so a suppressed run can never be mistaken for a real
one. The contacts job cannot obtain a token, so it reports every character as
skipped and shows no diff — an accepted limitation of refusing the refresh.

The worker prints its mode and its three targets at startup, before any queue
runs.

### Deploying this change

`SYNC_MODE` must be set **before** the deploy that introduces it, not with it:

```bash
fly secrets set --stage SYNC_MODE=live   # stored; applied by the next deploy
fly deploy
```

`--stage` avoids restarting the current machines for a value the running code
does not yet read. Plain `fly secrets set` also works — it just triggers its own
rolling restart first.

**A missing `SYNC_MODE` is not caught by anything, including the health check.**
Per component:

| Component | Behavior | Why |
|---|---|---|
| Release command | **succeeds** | `src/db/migrate.ts` reads `DATABASE_URL` directly, never `getConfig()` |
| `worker` | **crash-loops** | `getConfig()` runs at `src/worker/index.ts` startup |
| `web` | **boots, then 500s on every page** | `getConfig()` is lazily cached (`src/config.ts`) and every caller is inside a route handler or page |
| `/api/health` | **returns 200 — healthy** | it never calls `getConfig()`: `getDb()` reads `process.env.DATABASE_URL` directly (`src/db/index.ts`) and `checkLiveness` only runs `select 1` |

That last row is the trap. `fly.toml` *does* define an `http_service` check on
`/api/health`, and that check genuinely gates deploys — but only on database
reachability. A config error leaves it reporting healthy while every real page
is broken, so the machine stays in rotation and the deploy is never gated.

Setting the secret first is the safety net. There is no automatic one.

The `worker` still crash-loops on bad config, but it is no longer silent: it
posts to `DISCORD_OPS_WEBHOOK_URL` naming the invalid variables before it
exits (see [Worker boot failures](#worker-boot-failures)).

### What SYNC_MODE does NOT protect

**The database.** The purge job deletes rows directly, and the guard only covers
outbound HTTP. Never put a production `DATABASE_URL` in a local `.env` — no
setting in this app will save you from that.

## Worker boot failures

`## Monitoring` above covers the two endpoints and what they assert. This
section is the other half of the same problem: the worker process group has no
HTTP listener, so `/api/health/sync` can only notice it is gone *after* the
90-minute freshness threshold expires. Everything below is about the window
before that, and about the worker telling you itself.

### How a dead worker reaches you

Three independent paths, because the incident that prompted this defeated
having only one.

1. **Boot failure** — the worker posts to `DISCORD_OPS_WEBHOOK_URL` before
   exiting. Previously impossible: the only webhook caller in that process was
   the dead-letter handler, registered *after* `boss.start()`, so a worker dying
   at boot could never reach it. This path reads `process.env` directly rather
   than `getConfig()`, precisely because invalid config is the common cause.
   Suppressed when `SYNC_MODE=dry-run`, so a laptop never pages ops.
2. **Job failure after retries** — the dead-letter handler, unchanged.
3. **Silent death** (OOM-killed, wedged, restarts exhausted) — nothing inside
   the process can report this, so `/api/health/sync` going stale is the only
   signal, and something outside Fly has to be looking at it.

Only ZodError detail is forwarded to Discord, because it names *variables* and
never values. Any other error sends a fixed summary and the full text goes to
stderr — a driver-level failure can carry a connection string or a credential
in its message, and the webhook is a chat room with a wider audience than
`fly logs`.

### The 60-second boot watchdog

`BOOT_TIMEOUT_MS` in `src/worker/index.ts` exits the process if startup has not
completed in 60 seconds. This is not belt-and-braces — it covers a failure mode
path 1 alone could not:

> With **valid config but an unreachable database**, `pg-boss.start()` retries
> forever. It neither resolves nor rejects, so the worker sits past its startup
> banner indefinitely. Fly sees a live process and never restarts it,
> `main().catch()` never runs, and no alert is sent. Verified by pointing
> `DATABASE_URL` at a dead port: the process ran until killed, silently.

With the watchdog it exits 1 after 60s, which both engages the restart policy
and fires the boot-failure webhook.

If you ever add slow work to `main()` — a large backfill, a warm-up query —
raise this constant or move that work behind `boss.work()`, or a healthy worker
will be killed mid-boot.

### The restart ceiling, and why the worker stays down

`[[restart]]` in `fly.toml` states `policy = "on-failure"`, `retries = 10`
explicitly. That was already the default; writing it down makes the ceiling
reviewable. It governs unexpected process **exits** — not health check results,
which never restart anything.

Exhausting the 10 retries leaves the Machine **stopped**, not permanently dead;
`stopped` is recoverable and it can be started again. What differs is who does
the starting:

- **web** — `auto_start_machines = true`, so Fly Proxy wakes a stopped machine
  on the next inbound request.
- **worker** — behind no proxy and receiving no requests, so nothing will ever
  wake it. It stays stopped until you run `fly machine start` or hit the API.
  This is the case that bit us, and path 1 above is the only thing that will
  tell you it happened as it happens.

### The external poll is a stopgap

`.github/workflows/uptime.yml` curls `/api/health/sync` every 15 minutes. It
needs a repository variable, set to the app's **public** URL — the custom
domain, not `authgd.fly.dev`. Both hostnames answer, but only the custom domain
exercises the DNS record and the certificate users actually depend on, so a
probe of the `.fly.dev` name would stay green through an expired cert:

```bash
gh variable set APP_BASE_URL --body https://authgd.zoolanders.space
```

This is the same value as the app's own `APP_BASE_URL` secret, but the two are
unrelated storage: the secret is what OAuth redirect URIs derive from
(`src/config.ts`), while the variable is only the probe target.

It probes only that one URL, not both: a 200 from `/api/health/sync` already
proves the web process served a request and Postgres answered, and its `db`
field distinguishes a stale worker from an unreachable database. A separate
`/api/health` probe would add no information.

**It does not cover config validity.** Neither endpoint calls `getConfig()`, so
a `web` machine deployed with a missing secret answers 200 on both while every
real page 500s — the trap described under *Deploying this change*. Closing that
would mean either validating config in `/api/health` (which then pulls machines
out of rotation on a config error) or having `node web/server.js` call
`getConfig()` eagerly and refuse to start. Neither is done today.

Do not mistake this workflow for real alerting. GitHub cron is best-effort and
routinely runs 5-15 minutes late or skips runs entirely; scheduled workflows are
disabled after 60 days of repository inactivity; and if Actions is down the
check is down silently. A failed run notifies whoever's notification settings
happen to cover it, which is not a paging guarantee. Replace it with an uptime
service that actually pages — keep the endpoint, delete the workflow.

## Contact label — use a dedicated one

`STANDINGS_LABEL` names an in-game contact label that authGD **owns outright**.
On every contacts run it deletes every contact carrying that label that is not a
current member (`src/core/contacts-diff.ts`). Point it at a label created
for authGD; never at one people also curate by hand, or their contacts are
deleted on the first run.

Four properties worth knowing before changing it:

- **ESI cannot create labels.** Create it in the client first. Until it exists
  the job records `missing_label` and skips every write — safe, but inert.
- **The match is exact and case-sensitive** (`src/core/contact-label.ts`), so
  `authgd` ≠ `AuthGD`. A typo skips rather than deletes. A near-miss typo (case
  or whitespace only) records `label_mismatch` and names both the offending
  label(s) and the required name; an unrelated typo records `missing_label`
  with no label to point at.
- **A case-only change strands every existing member at once.** The label id is
  re-resolved from the name each run, so recapitalizing `STANDINGS_LABEL`
  instantly stops matching every label that was correct under the old value.
  This happened on 2026-08-03: eight of ten characters dropped to
  `missing_label` in one run (the same situation records `label_mismatch`
  today). Members must rename their label in game before their sync resumes —
  announce the change before making it, and expect to field reports from
  anyone who does not notice the difference on screen.
- **Nothing about the label is persisted** — the id is resolved from the name
  each run. Changing the value needs no migration, but contacts left under the
  old label become unmanaged: the app stops touching them rather than cleaning
  up.

## Bootstrap admin — recovery caveat

The bootstrap grant is **once-ever per character id**: the first time an
account links a character listed in `BOOTSTRAP_ADMIN_CHARACTER_IDS`, a
consumed `bootstrap_admin_grant` row is written and can never fire again —
even if the account is deleted, the flag revoked, or the character sold.

**If you ever lose all admin access**, adding a previously used character id
back to the env var does nothing. Recovery requires adding a character id
that has NEVER had a grant row, then logging in with that character. Keep at
least one never-used id in reserve, or check
`select character_id from bootstrap_admin_grant` before relying on one.

## Local development

Requires **Node 24+** (Active LTS; the Dockerfile ships `node:24-alpine`) and
Docker. `npm install` enforces it via `engines` + `.npmrc`, and
`nvm use` picks it up from `.nvmrc`. The three pins (`Dockerfile`, `.nvmrc`,
`package.json` `engines`) must agree on the major — `scripts/check-node-version.sh`
fails CI if a bump misses one.

### From a fresh clone

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres 16 on :5433
npm install
cp .env.example .env                             # working fakes; boots as-is
npm run db:migrate
npm run dev                                      # web → http://localhost:3000
```

`npm run dev` holds the terminal. Start the worker in a second one:

```bash
npm run worker
```

No editing is required to get a browsable app: **every value in `.env.example`
is a working fake**, and `SYNC_MODE=dry-run` means every outbound *sync*
mutation is a logged no-op — no in-game contacts deleted, no Wanderer ACL
reconciled, no Discord roles changed, no EVE refresh token rotated.

**`SYNC_MODE` does not cover the OAuth flows, deliberately.** Login and
character-link exchange a fresh authorization code for new credentials; they
invalidate nothing, and guarding them would make local OAuth testing
impossible. So if you put **real** EVE or Discord client credentials in
`.env`, those flows will contact the real providers and can mint real tokens
or create a real Discord link — dry-run will not stop them. It stops the sync
jobs from changing anything, not the app from authenticating.

The worker prints its mode and targets on startup — check it before trusting
that a terminal is safe:

```text
authGD worker: SYNC_MODE=dry-run — outbound writes are SUPPRESSED
  target: wanderer=https://wanderer.example acl=dev-acl-id
  target: discord guild=9000
  target: standings label=authgd value=5
```

### `npm test` cannot touch your dev database

This is not obvious, and it stops people running the tests.

`docker-compose.dev.yml` starts **one** Postgres hosting **two** databases:

| Database | Used by | Destructive operations |
|---|---|---|
| `authgd` | `npm run dev`, `npm run worker`, `npm run db:migrate` | none automatic |
| `authgd_test` | `npm test` | `TRUNCATE` between every test |

`authgd_test` is created by `scripts/init-test-db.sql` at container init. The
test helpers connect to it explicitly (`tests/helpers/db.ts`), so the
`TRUNCATE ... CASCADE` the suite runs between tests physically cannot reach
`authgd`. Run the tests freely.

`npm run test:e2e` does not appear above: it provisions a database of its own,
in its own container, and never touches either of these. See
[`npm run test:e2e` isolates itself](#npm-run-teste2e-isolates-itself) below.

**Two `npm test` runs at once used to fight**, because they share
`authgd_test` and the suite `TRUNCATE`s it between every test. A sibling run
would see rows vanish mid-test — assertion failures like
`expected [] to deeply equal [1, 2]` that moved around between runs,
indistinguishable from a real regression. Playwright is pinned to
`workers: 1` for the same reason within its own suite.

That silent corruption is now a named error instead. `tests/helpers/global-setup.ts`
takes a session-scoped `pg_try_advisory_lock` on `authgd_test` for the
lifetime of the run (a fixed 64-bit key, chosen to be nowhere near
pg-boss's own per-database advisory locks). A second `npm test` — in this
checkout or another git worktree — fails immediately with a message naming
the database and pointing at the fix below, instead of running and
corrupting the first run's results. The lock is per-database, so it never
fires for a run already pointed at its own private database via
`TEST_DATABASE_URL` (see below) — there's nothing to contend with. If
Postgres isn't reachable at all, the lock check fails open rather than
blocking the suite: plenty of test files never touch the database and must
keep working with Postgres down.

If you need to run the unit tests while another checkout is using
`authgd_test`, point yours somewhere private — this is what the error
message itself suggests:

```bash
docker exec <pg-container> psql -U authgd -d postgres \
  -c "CREATE DATABASE authgd_test_mine OWNER authgd;"
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_mine npm test
```

#### `npm run test:e2e` isolates itself

The e2e suite is the exception: it needs none of the above. `e2e/env.ts` hashes
the worktree's absolute path into a dev-server port and a database port, and
`e2e/provision.ts` starts a Postgres container named `authgd-e2e-<worktree>` on
that port before the dev server boots. Both `playwright.config.ts` and
`e2e/helpers.ts` read the resulting URL from that one module, so the server and
the seeding code cannot end up pointed at different databases.

Concurrent worktrees therefore each get their own port and their own database,
and `npm run test:e2e` remains the only command you need.

```bash
npm run test:e2e          # provisions on first run, reuses afterwards
npm run test:e2e:clean    # remove this worktree's container when you're done
```

The container is kept between runs on purpose — a throwaway one would pay for
`initdb` plus a full migration every time, and would strand any reused dev
server against a database that no longer exists. Nothing reclaims it
automatically, so `test:e2e:clean` is the tidy-up.

Two overrides exist, both optional:

| Variable | Effect |
|---|---|
| `TEST_DATABASE_URL` | Use this database and skip provisioning entirely. |
| `E2E_PORT` / `E2E_DB_PORT` | Pin a port, e.g. after a hash collision. |

If something that is not this worktree's own dev server already holds the port,
the run **aborts** rather than attaching to it. Attaching is what used to make a
sibling worktree's server answer your tests and return a green suite that never
touched your branch.

### What works on fakes, and what needs real credentials

| Works with `.env.example` as-is | Needs real credentials |
|---|---|
| Browsing the app; every page renders | **EVE SSO login** — the fake client id is rejected by CCP |
| `npm run db:migrate`, `npm test`, `npm run test:e2e` | **Discord account linking** |
| `npm run typecheck`, `lint`, `format` | Any sync that actually changes something |
| Worker boots, queues are created, schedules registered | `npm run smoke:wanderer` (also requires `SYNC_MODE=live`) |

**Expect the sync jobs to fail on fakes, and that is correct.** With fake hosts
and tokens: the wanderer job's ACL read fails DNS (`wanderer.example` does not
resolve), the discord-roles job gets 401 from the real Discord API, and the
contacts job skips every character because dry-run refuses the token refresh. A
worker that boots cleanly and then logs failing jobs is working as designed.

### Logging in without EVE SSO

EVE SSO rejects the fake client id, so the way to browse as a real account —
including an admin — is to seed one and paste its session cookie.

```bash
npm run db:seed              # safe to re-run; upserts
npm run db:seed -- --reset   # TRUNCATE everything first, for a clean slate
```

It seeds six accounts covering every tier, an admin, alts, and the `cryo` and
`tier_locked` states the admin pages need something to render. For each it
prints a cookie:

```text
admin   Admin Prime        (member, admin, 2 alt(s))
  authgd_session=Ux7...redacted...

member  Member Pilot       (member, 1 alt(s))
  authgd_session=Qa2...redacted...
```

To use one:

1. Open devtools on the app → **Application** → **Cookies** → the origin you are
   actually browsing (`http://localhost:3000` by default).
2. Add a cookie whose **name** is your `SESSION_COOKIE_NAME` (default
   `authgd_session`). The **value** is only the text *after* the `=` — the
   script prints a full `name=value` assignment, but devtools has separate
   fields, and pasting the whole line into the value box fails to authenticate.
3. **Path `/`.** Reload.

Set it on the origin you browse, not on whatever `APP_BASE_URL` happens to say.
Those differ once you point `APP_BASE_URL` at an https tunnel — and over https
the cookie also needs the `Secure` attribute, or the browser will not send it.
The app sets `Secure` automatically for its own cookies when `APP_BASE_URL`
starts with `https` (`src/app/auth/eve/callback/route.ts`), but a cookie you
create by hand is yours to configure.

Two behaviors worth knowing:

- **Re-running revokes the previous run's sessions.** Cookies printed earlier
  stop working; you get a fresh set. That keeps sessions from accumulating and
  makes the output authoritative.
- **The script refuses a non-local `DATABASE_URL`.** Both paths write rows —
  `--reset` destructively, the default by adding fixture accounts — and a dev
  seed has no legitimate remote use. `ALLOW_REMOTE_SEED=1` overrides it
  deliberately.

Character ids come from the reserved **`91_000_000`–`91_999_999`** range
(mains at `91_000_00x`, alts at `91_000_1xx`), chosen to sit clear of the
`90_000_00x` ids `e2e/helpers.ts` generates, so the two can never collide.

### Real OAuth locally, over a tunnel

The seeded cookie above covers most dev work. You need real OAuth only when you
are changing the login or character-link flows themselves.

Both providers redirect back to a URL derived from `APP_BASE_URL`, so they have
to reach your machine. A tunnel with a **stable** domain is what makes this
bearable — a fresh random hostname per run means re-registering the redirect URI
in two developer portals every time.

#### 1. Start the tunnel

```bash
ngrok http 3000 --domain your-stable-domain.ngrok-free.app
```

#### 2. Override `APP_BASE_URL` in `.env.local`

`.env.local` takes precedence over `.env`, and `.env*` is gitignored apart from
`.env.example`. Both loaders agree on that: Next.js applies its own
`.env.local`-wins rule for `npm run dev`, and the `worker` / `db:migrate` /
`db:seed` scripts pass `--env-file-if-exists=.env` before
`--env-file-if-exists=.env.local`, where the later flag overrides the earlier. Keeping the override in a second file means
your working `.env` stays untouched and switching back is deleting one file.

```bash
# .env.local — tunnelled OAuth. Delete this file to go back to localhost.
APP_BASE_URL=https://your-stable-domain.ngrok-free.app
```

A trailing slash is harmless — `src/config.ts` strips it. That matters because
the two OAuth `redirect_uri` values are string-concatenated rather than
URL-joined, so an unnormalised `https://x.ngrok.app/` would yield
`https://x.ngrok.app//auth/eve/callback`, which no longer matches the URI
registered in the developer portal. `z.string().url()` accepts the slash, so
before normalisation this surfaced only as an unexplained redirect mismatch at
login. Write it without the slash anyway — that is the form you register below.

#### 3. Register the redirect URIs

Exactly two, and they must match character-for-character:

| Provider | Redirect URI to register |
|---|---|
| EVE (developers.eveonline.com → your application) | `https://your-stable-domain.ngrok-free.app/auth/eve/callback` |
| Discord (Developer Portal → your app → OAuth2 → Redirects) | `https://your-stable-domain.ngrok-free.app/auth/discord/callback` |

**One EVE entry covers both flows.** Login (`/auth/eve/login`) and adding a
character (`/auth/eve/link`) both call `buildEveAuthorizeUrl`, so they share the
single `/auth/eve/callback` URI. Discord needs only `identify` scope.

#### 4. Browse the tunnel URL, not localhost

Once `APP_BASE_URL` is `https://…`, the session cookie is issued with `Secure`
(`src/app/auth/eve/callback/route.ts`), so the browser will not send it back over
plain `http://localhost:3000`. You will appear logged out no matter how many
times you log in. Use the tunnel origin for the whole session.

This applies to seeded cookies too: paste them on the origin you are browsing,
and mark them `Secure` when that origin is https.

#### The failure that looks like a Discord bug

EVE and Discord treat `redirect_uri` differently, and it matters when you change
`APP_BASE_URL`:

- **EVE** sends `redirect_uri` only on the authorize request. The token exchange
  (`exchangeEveCode`, `src/lib/esi/sso.ts`) sends `grant_type`, `code`, and
  `code_verifier` — no `redirect_uri`.
- **Discord** sends it **twice** — on authorize *and* again in the token exchange
  (`src/lib/discord/oauth.ts`), where it must match the first one exactly.

So if you change `APP_BASE_URL` (or restart the server with a different tunnel
domain) *between* clicking "link Discord" and the redirect landing, the exchange
fails while EVE login keeps working. It reads like a Discord outage; it is a
mid-flight config change. Restart the flow from the current origin.

Since the callbacks were hardened, that failure lands on
`/account?error=discord_failed` rather than a bare 500, so the diagnosis is in
the server log rather than on the screen. Grep for `discord callback failed` (or
`eve callback failed`) — the line carries the underlying error message.

#### What each callback error code means

Both callbacks redirect on every failure so a member always has a way back. The
code in the URL is the only thing distinguishing them, so:

| Code | Reached `/` | Cause |
|---|---|---|
| `oauth_denied` / `discord_denied` | login / account | The member declined at the provider. Nothing was requested. |
| `oauth_expired` / `discord_expired` | login / account | State unknown, already used, or older than the 10-minute transaction TTL (`src/services/oauth-tx.ts`). Also covers a forged `state`. |
| `oauth_failed` / `discord_failed` | login / account | The provider or database threw. Details are logged, never shown. |
| `link_expired` / `link_failed` | account | Same two causes, for adding a character to a session that already exists. |
| `session_expired` | login | The session cookie is gone or dead. Emitted by both callbacks and by `/account`, which distinguishes a dead cookie from no cookie at all. |

A rise in `*_expired` with no matching log lines is normal background: members
abandon flows and browsers pre-fetch. A rise in `*_failed` is not — those always
log.

#### Switching back to localhost

```bash
rm .env.local     # or comment out the APP_BASE_URL line
```

Restart `npm run dev` — `.env.local` is read at process start, not per request.
The registered tunnel redirect URIs can stay in both portals; they are inert
while `APP_BASE_URL` points at localhost, so this is a one-line round trip.

### Expected noise

`--env-file-if-exists` prints one line per missing file, and `tsx` re-execs
node, so a missing `.env.local` produces this **twice**:

```text
.env.local not found. Continuing without it.
```

It is informational, not an error.

### Port 5433 is already allocated

```text
Bind for 0.0.0.0:5433 failed: port is already allocated
```

Something else already holds the port — often another checkout of this repo
running the same compose file under a different project name, in which case you
can just use it. **Do not assume that, though: verify before reusing.** Whatever
holds 5433 becomes your dev database, so pointing at the wrong one silently
gives you someone else's data.

Find the container, then check all three of these:

```bash
docker ps --filter publish=5433 --format '{{.Names}}\t{{.Image}}\t{{.Labels}}'
```

1. **Image** is `postgres:16-alpine` — a different major version will fail or
   behave differently under the same migrations.
2. **Compose project** is a checkout of this repo, not an unrelated service that
   happens to use 5433 (`com.docker.compose.project` in the labels).
3. **The `authgd_test` database exists** — it is created only by
   `scripts/init-test-db.sql` at *first* container init, so a Postgres started
   any other way will not have it and the test suites will fail:

   ```bash
   docker exec <container> psql -U authgd -lqt | cut -d'|' -f1 | grep -w authgd_test
   ```

If any of those don't hold, stop that container or change the host port rather
than reusing it.

### Note for deployers

`fly.toml` runs the worker as `npx tsx src/worker/index.ts` directly, **not**
`npm run worker`, so it does not inherit the `--env-file` flags. That is
deliberate and safe: `.dockerignore` excludes `.env*`, so no env file exists in
the image, and Fly secrets arrive as real environment variables — which take
precedence over `--env-file` anyway. But it does mean changes to the `worker`
npm script do not reach production.

`npm run db:migrate` **is** the release command (`fly.toml`), so it does carry
the flags into the deploy path. That is what makes the Node floor load-bearing
in production rather than a developer convenience: below Node 22.9 `node`
rejects `--env-file-if-exists` outright and every deploy fails. The floor now
sits at 24 to track Active LTS, well clear of that, but the Dockerfile copies
`.npmrc` before `npm ci` in both stages so `engine-strict` turns any regression
below the floor into a **build** failure instead of a release-time one.

## Tier rename migration (0007)

The tier enum values were renamed in place: `flygd → member`, `blue →
associate`, `green → alumni`. `RENAME VALUE` rewrites no rows, but the old image
cannot run against the new enum — its queries use values Postgres no longer
accepts. **This deploy requires a maintenance window.**

### Deploy

`docs/ops.md` § "Sizing and redundancy" runs **`web=2`, `worker=1`** — `web=2`
is a deliberate choice that closes the deploy gap, not a default. Record the
live counts before scaling down and restore those, rather than trusting the
numbers written here:

```bash
fly scale show   # record the current web and worker counts
```

1. `fly scale count web=0 worker=0`
2. Set the new role secrets, copying each value verbatim from the old one.
   Read the three old values first and substitute them for the placeholders —
   the `<…>` below are not shell syntax and will be set literally if pasted
   as-is. Leave the old three set:
   ```bash
   fly secrets set DISCORD_ROLE_ID_MEMBER='<paste value of DISCORD_ROLE_ID_FLYGD>' \
                   DISCORD_ROLE_ID_ASSOCIATE='<paste value of DISCORD_ROLE_ID_BLUE>' \
                   DISCORD_ROLE_ID_ALUMNI='<paste value of DISCORD_ROLE_ID_GREEN>'
   ```
3. Merge the pull request. **Merging is the deploy** — this repo deploys from
   `main` through Fly's GitHub integration, so there is no `fly deploy` to run
   by hand, and merging before step 1 would start a rolling replacement with
   the old image still serving against the new enum. Watch `fly releases` until
   the release command reports the migration applied.
4. `fly scale count web=2 worker=1` (or the counts recorded above), then verify
   `/api/health` and load `/admin/accounts`
5. Confirm the renamed role secrets actually resolve. `/api/health` and
   `/admin/accounts` prove the enum rename took; they say nothing about Discord,
   and a mistyped or omitted `DISCORD_ROLE_ID_*` fails silently as "no role
   managed" rather than as an outage. On `/admin/sync`, run the
   "Sync membership, contacts, wanderer, discord-roles" action and wait for the
   `discord-roles` runs to land green — a bad role ID surfaces there as a
   Discord role configuration error (and on the ops webhook).
6. Only after steps 4 and 5 are confirmed healthy:
   ```bash
   fly secrets unset DISCORD_ROLE_ID_FLYGD DISCORD_ROLE_ID_BLUE DISCORD_ROLE_ID_GREEN
   ```

Step 6 is last and separate so a rollback still has a bootable old image.

### Rollback

Keeping the old secrets is **necessary but not sufficient** — the enum must be
reverted before the old image starts, or it fails on every tier read regardless
of configuration.

1. `fly scale count web=0 worker=0`
2. Revert the enum:
   ```sql
   ALTER TYPE "public"."tier" RENAME VALUE 'member' TO 'flygd';
   ALTER TYPE "public"."tier" RENAME VALUE 'associate' TO 'blue';
   ALTER TYPE "public"."tier" RENAME VALUE 'alumni' TO 'green';
   ALTER TABLE "account" ALTER COLUMN "tier" SET DEFAULT 'green';
   ```
3. Remove the migration's row so the next forward deploy re-applies it.
   **`__drizzle_migrations.hash` is a SHA-256 of the file contents, not the
   filename — matching on `'%0007%'` finds nothing and silently leaves the row
   in place.** The row is identified by `created_at`, which is the `when` value
   drizzle-kit recorded in `drizzle/meta/_journal.json` for the `0007_*` entry.
   Read that number out of the journal in the deployed image, then, in the same
   transaction as step 2:

   ```sql
   -- <when> is the "when" field of the 0007 entry in drizzle/meta/_journal.json
   -- <hash> is the output of: sha256sum drizzle/0007_<name>.sql
   SELECT id, hash, created_at FROM drizzle.__drizzle_migrations
    WHERE created_at = <when>;
   -- confirm exactly one row, and that its hash equals <hash>, then:
   DELETE FROM drizzle.__drizzle_migrations
    WHERE created_at = <when> AND hash = '<hash>';
   ```

   Run steps 2 and 3 inside one `BEGIN`/`COMMIT`, and check the `DELETE` reported
   `DELETE 1` before committing. If the `SELECT` or the `DELETE` touches zero or
   more than one row, `ROLLBACK` and stop — reverting the enum without clearing
   the record leaves the next deploy unable to move forward, and clearing the
   wrong record is worse. Keying the `DELETE` on the hash as well as `created_at`
   means a mistyped `<when>` deletes nothing rather than something else.
4. Re-set `DISCORD_ROLE_ID_FLYGD/_BLUE/_GREEN` if step 6 of the deploy already ran
5. `fly deploy --image <previous image ref>`
6. `fly scale count web=2 worker=1` (or the counts recorded before the deploy)

A Fly version bump does not guarantee a new image — check `ImageRef` before
concluding the rollback took effect.

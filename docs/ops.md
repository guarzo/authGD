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
  APP_BASE_URL=https://<app>.fly.dev \
  ALLIANCE_ID=... \
  BOOTSTRAP_ADMIN_CHARACTER_IDS=... \
  EVE_SSO_CLIENT_ID=... EVE_SSO_CLIENT_SECRET=... \
  EVE_SSO_SCOPES="esi-characters.read_contacts.v1 esi-characters.write_contacts.v1" \
  DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... DISCORD_BOT_TOKEN=... \
  DISCORD_GUILD_ID=... DISCORD_ROLE_ID_FLYGD=... DISCORD_ROLE_ID_BLUE=... \
  DISCORD_ROLE_ID_GREEN=... DISCORD_OPS_WEBHOOK_URL=... \
  WANDERER_BASE_URL=... WANDERER_API_KEY=... WANDERER_ACL_ID=... \
  STANDINGS_LABEL=FLYGD STANDINGS_VALUE=5 \
  ESI_CONTACT="you@example.com"
fly deploy
fly scale count web=2 worker=1
```

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

Point an external uptime monitor at **both** URLs. Fly cannot tell you it is
down; that is the entire reason the external check exists.

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
  instances are safe. Set it with `fly scale count web=2`; machine count is not a
  `fly.toml` field.
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
check.

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
| `ALLIANCE_ID` | yes | membership anchor: main in this alliance ⇒ FlyGD |
| `BOOTSTRAP_ADMIN_CHARACTER_IDS` | no | comma-separated; see recovery caveat below |
| `EVE_SSO_CLIENT_ID` / `EVE_SSO_CLIENT_SECRET` | yes | EVE application credentials |
| `EVE_SSO_SCOPES` | yes | space-separated full scope set requested at every login |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | yes | Discord OAuth (identify only) |
| `DISCORD_BOT_TOKEN` | yes | bot with Manage Roles above the three managed roles |
| `DISCORD_GUILD_ID` | yes | the guild whose roles are managed |
| `DISCORD_ROLE_ID_FLYGD` / `_BLUE` / `_GREEN` | yes | the three managed role ids (distinct) |
| `DISCORD_OPS_WEBHOOK_URL` | no | ops alerts (final retry failures, config errors) |
| `WANDERER_BASE_URL` / `WANDERER_API_KEY` | yes | Wanderer instance + the **ACL's own** API key (the map API key returns 401 on `/api/acls/*`) |
| `WANDERER_ACL_ID` | yes | the managed ACL — dedicated to authGD, reconciled destructively |
| `STANDINGS_LABEL` | no (default `FLYGD`) | in-game contact label the app OWNS (destructive within it); matched **case-sensitively** against the label as typed in the client |
| `STANDINGS_VALUE` | no (default 5) | standing pushed for members |
| `ESI_CONTACT` | yes | operator contact sent in the ESI User-Agent (CCP requirement) |

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

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres on :5433
npm run db:migrate && npm run dev                # web
npm run worker                                   # worker (second terminal)
npm test                                         # vitest (needs the compose DB)
npm run test:e2e                                 # Playwright (Task 12; not concurrently with npm test)
```

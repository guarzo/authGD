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
  EVE_SCOPE_SET_VERSION=1 \
  DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... DISCORD_BOT_TOKEN=... \
  DISCORD_GUILD_ID=... DISCORD_ROLE_ID_FLYGD=... DISCORD_ROLE_ID_BLUE=... \
  DISCORD_ROLE_ID_GREEN=... DISCORD_OPS_WEBHOOK_URL=... \
  WANDERER_BASE_URL=... WANDERER_API_KEY=... WANDERER_ACL_ID=... \
  STANDINGS_LABEL=authgd STANDINGS_VALUE=5 \
  ESI_CONTACT="you@example.com" \
  SYNC_MODE=live
fly deploy
fly scale count web=1 worker=1
```

`TOKEN_ENCRYPTION_KEY`: `openssl rand -base64 32`. Rotating it invalidates
every stored EVE refresh token (members re-auth); treat it as unrotatable.

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
| `EVE_SCOPE_SET_VERSION` | no (default 1) | bump when scopes change ⇒ members flagged needs_reauth |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | yes | Discord OAuth (identify only) |
| `DISCORD_BOT_TOKEN` | yes | bot with Manage Roles above the three managed roles |
| `DISCORD_GUILD_ID` | yes | the guild whose roles are managed |
| `DISCORD_ROLE_ID_FLYGD` / `_BLUE` / `_GREEN` | yes | the three managed role ids (distinct) |
| `DISCORD_OPS_WEBHOOK_URL` | no | ops alerts (final retry failures, config errors) |
| `WANDERER_BASE_URL` / `WANDERER_API_KEY` | yes | Wanderer instance + the **ACL's own** API key (the map API key returns 401 on `/api/acls/*`) |
| `WANDERER_ACL_ID` | yes | the managed ACL — dedicated to authGD, reconciled destructively |
| `STANDINGS_LABEL` | no (default `authgd`) | in-game contact label the app OWNS — see the warning below |
| `STANDINGS_VALUE` | no (default 5) | standing pushed for members |
| `ESI_CONTACT` | yes | operator contact sent in the ESI User-Agent (CCP requirement) |
| `SYNC_MODE` | **yes, no default** | `live` \| `dry-run`. `dry-run` suppresses every outbound mutation (see below). Production MUST be `live` |

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
fly secrets set SYNC_MODE=live     # triggers its own rolling restart
fly deploy
```

There is no automatic rollback if you forget. `fly.toml` defines no health
checks, and only the worker validates config at startup — it crash-loops, while
`web` boots normally and returns 500 on every request (`getConfig()` is lazy).
The release command still succeeds, because migrations never read config.

### What SYNC_MODE does NOT protect

**The database.** The purge job deletes rows directly, and the guard only covers
outbound HTTP. Never put a production `DATABASE_URL` in a local `.env` — no
setting in this app will save you from that.

## Contact label — use a dedicated one

`STANDINGS_LABEL` names an in-game contact label that authGD **owns outright**.
On every contacts run it deletes every contact carrying that label that is not a
current FlyGD member (`src/core/contacts-diff.ts`). Point it at a label created
for authGD; never at one people also curate by hand, or their contacts are
deleted on the first run.

Three properties worth knowing before changing it:

- **ESI cannot create labels.** Create it in the client first. Until it exists
  the job records `missing_label` and skips every write — safe, but inert.
- **The match is exact and case-sensitive** (`src/jobs/contacts.ts`), so
  `authgd` ≠ `AuthGD`. A typo skips rather than deletes.
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

Requires **Node 22.9+** (the floor for `--env-file-if-exists`, which
`npm run worker`, `npm run db:migrate`, and `npm run smoke:wanderer` use to load
`.env`) and Docker. `npm install` enforces it via `engines` + `.npmrc`.

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
| `authgd_test` | `npm test`, `npm run test:e2e` | `TRUNCATE` between every test |

`authgd_test` is created by `scripts/init-test-db.sql` at container init. The
test helpers connect to it explicitly (`tests/helpers/db.ts`,
`playwright.config.ts`), so the `TRUNCATE ... CASCADE` the suites run between
tests physically cannot reach `authgd`. Run the tests freely.

**Never run `npm test` and `npm run test:e2e` at the same time.** They share
`authgd_test`, and Playwright is pinned to `workers: 1` for the same reason.
Symptoms of a collision are rows vanishing mid-test — assertion failures like
`expected [] to deeply equal [1, 2]` that move around between runs.

The same applies across git worktrees: two checkouts running `npm test`
simultaneously fight over the same database. If you need to run tests while
another checkout is using it, point yours somewhere private:

```bash
docker exec <pg-container> psql -U authgd -d postgres \
  -c "CREATE DATABASE authgd_test_mine OWNER authgd;"
TEST_DATABASE_URL=postgres://authgd:authgd@localhost:5433/authgd_test_mine npm test
```

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

Logging in without EVE SSO needs a seeded session — see the dev seed script.

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
the flags into the deploy path. That makes the Node 22.9 floor load-bearing in
production: below it, `node` rejects `--env-file-if-exists` outright and every
deploy fails. The Dockerfile copies `.npmrc` before `npm ci` in both stages so
`engine-strict` turns that into a **build** failure instead of a release-time
one.

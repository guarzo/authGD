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
  ESI_CONTACT="you@example.com"
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

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres on :5433
npm run db:migrate && npm run dev                # web
npm run worker                                   # worker (second terminal)
npm test                                         # vitest (needs the compose DB)
npm run test:e2e                                 # Playwright (Task 12; not concurrently with npm test)
```

<p align="center">
  <img src="docs/assets/hero.png" alt="Zoo Landers — Flygd" width="100%">
</p>

# authGD

A modern, minimal replacement for the Alliance Auth stack, built for a single
~20-member EVE Online corporation. It does only what the corp actually uses —
no plugin ecosystem, no admin sprawl.

- **EVE SSO login** — the first character login creates the account and becomes the
  main. Every character login requests the full configured scope set, so nobody ever
  has to re-add a character just to grant another scope.
- **Alt linking** — link as many alts as you like from the account page; auto-approved
  and audit-logged. Alts may sit in any corp or alliance.
- **Automatic standings distribution** — pushes the member roster into each member
  character's in-game personal contacts at +5, scoped to a configured contact label.
- **Wanderer map ACL management** — keeps the map ACL in sync with the member roster.
- **Discord role management** — grants exactly the one role matching an account's tier.
- **Derole, don't boot** — leaving members drop to a lower tier but keep their account,
  linked characters, ESI tokens, and Discord link, so returning is frictionless.
- **Audit log** — every tier change, link, and sync action is recorded with actor and cause.
- **Admin accounts page** — one row per account with tier controls, cryo/AFK tracking
  with dates and notes, token health, Discord and map state, sortable and filterable.

## Membership tiers

| Tier      | How it is set                          | Standings              | Wanderer map | Discord role |
| --------- | -------------------------------------- | ---------------------- | ------------ | ------------ |
| **FlyGD** | automatic: main character in alliance   | +5 on all linked chars | yes          | FlyGD        |
| **Blue**  | manual (admin); locks the tier          | none                   | no           | Blue         |
| **Green** | automatic on leaving the alliance       | none                   | no           | Green        |

Membership is tested against the account's **main** character's alliance. Tiers are
system-managed by default; any manual tier an admin sets locks the account so the
membership job leaves it alone, and admins can "return to auto" to unlock it. A Green
account whose main rejoins the alliance is restored to FlyGD automatically.

## Architecture

One repo, one image, two containers, plus Postgres.

```text
web (Next.js UI + API)  ──enqueue──▶  worker (pg-boss jobs)  ──▶  Postgres (data + queue)
        │                                    │
  EVE SSO, Discord OAuth          ESI · Wanderer API · Discord REST
```

- **web** — Next.js 15 App Router. Member pages (login, account, add character, link
  Discord) and admin pages (accounts, audit log, sync status). OAuth callbacks live in
  API routes. Web enqueues on-demand sync jobs.
- **worker** — the same codebase running [pg-boss](https://github.com/timgit/pg-boss):
  scheduled and on-demand jobs with exponential-backoff retries. No Redis.
- **Postgres 16** — application data *and* the job queue.
- **Integrations are outbound REST only.** Discord role changes go over the REST API with
  a bot token — no gateway connection, no bot process. Wanderer uses the map API key.

Sync jobs are all idempotent diff-and-apply, so re-running them is always safe:
membership verification (every 30 min, the anchor), contact push (hourly + on demand),
Wanderer ACL sync (hourly + on demand), Discord role sync (hourly + on demand), and
token health (daily).

Stack: TypeScript (strict), Drizzle ORM, `jose` + `fetch` for OAuth, Vitest.
Sessions are server-side — an opaque id in an HTTP-only cookie backed by a `session`
row — so revoking one is a row delete that takes effect on the next request.

## Quickstart (local development)

Requires Node.js 22+ and Docker.

```bash
# 1. Start Postgres 16 (published on host port 5433 to stay out of a local 5432's way)
docker compose -f docker-compose.dev.yml up -d

# 2. Install dependencies
npm install

# 3. Configure — copy the example env and fill it in.
#    See docs/ops.md for what each variable means.
cp .env.example .env

# 4. Run migrations
npm run db:migrate

# 5. Start the web app  →  http://localhost:3000
npm run dev
```

In a second terminal, start the job worker:

```bash
npm run worker
```

Run the test suite (needs the dev Postgres from step 1 running):

```bash
npm test
```

Other useful scripts: `npm run build`, `npm run typecheck`, `npm run test:watch`, and
`npm run db:generate` to author a new migration after changing the Drizzle schema.

## Documentation

- [Design spec](docs/superpowers/specs/2026-08-02-authgd-design.md) — the authoritative
  description of the tier model, data model, sync jobs, auth flows, and error handling.
- [Implementation plans](docs/superpowers/plans/) — the phased build plans.
- [Operations guide](docs/ops.md) — deployment and the full environment-variable
  reference. *(Being added on a separate branch; the link may not resolve yet.)*

## Status

Built in phases: foundation and auth, then the sync engine, then the admin UI and ops
tooling. See the plans linked above for what each phase covers.

---

Branding assets in `docs/assets/` and `public/` are Zoo Landers corporation artwork.

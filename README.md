# authGD

<p align="center">
  <img src="docs/assets/hero.png" alt="authGD — identity and access for EVE corporations" width="100%">
</p>

A modern, minimal replacement for the Alliance Auth stack, built for a small EVE Online corporation. 
It does only what the corp actually uses — no plugin ecosystem, no admin sprawl.

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

Requires Node.js 24+ and Docker.

```bash
# 1. Start Postgres 16 (published on host port 5433 to stay out of a local 5432's way)
docker compose -f docker-compose.dev.yml up -d

# 2. Install dependencies
npm install

# 3. Configure — the example is a complete set of working fakes and needs
#    no editing to get a browsable app.
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

`.env.example` ships `SYNC_MODE=dry-run`, so the sync jobs cannot change anything
in EVE, Discord, or Wanderer. On the fake values the app itself, the migrations,
and both test suites work. The Wanderer, Discord-roles, and contacts sync jobs
are **expected to fail or skip** — the fake hosts and tokens are not real, and
that is what a correctly-configured dev worker looks like. EVE SSO login and
Discord linking need real credentials.

**[`docs/ops.md` → Local development](docs/ops.md#local-development) is the
canonical guide** — why `npm test` cannot touch your dev database, what works on
fakes and what does not, running tests alongside another checkout, and the
tunnelled-OAuth setup.

Other useful scripts: `npm run build`, `npm run typecheck`, `npm run lint`,
`npm run test:watch`, and `npm run db:generate` to author a new migration after
changing the Drizzle schema.

## Documentation

- [Design spec](docs/superpowers/specs/2026-08-02-authgd-design.md) — the authoritative
  description of the tier model, data model, sync jobs, auth flows, and error handling.
- [Implementation plans](docs/superpowers/plans/) — the phased build plans.
- [Operations guide](docs/ops.md) — deployment, the Fly.io runbook, and the full
  environment-variable reference.

## Status

Built in phases: foundation and auth, then the sync engine, then the admin UI and ops
tooling. See the plans linked above for what each phase covers.

## License

[MIT](LICENSE) for the source code.

The artwork in `docs/assets/` and `public/` is **not** covered by the MIT
license — it was created by **Faoble** and is used here with permission. All
rights remain with the artist.

EVE Online and all related logos and images are trademarks or registered trademarks
of CCP hf. authGD is a third-party tool, not affiliated with or endorsed by CCP hf.
See [LICENSE](LICENSE) for the full notice.


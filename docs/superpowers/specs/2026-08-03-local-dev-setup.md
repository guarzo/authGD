# authGD Local Development Setup — Specification

**Status:** **Stages 1–2 approved** and ready to implement. **Stages 3–4 are an
outline, not an approved design** — Stage 3 still has an undecided question with
persisted-data consequences (§Stage 3, "Rerun semantics"), and D8 is provisional.
Do not implement Stage 3 from this document; it needs its own design pass and
approval first.
**Date:** 2026-08-03
**Branch:** `worktree-local-dev-setup`
**Supersedes:** `docs/ops.md` "Local development" (lines 86–94), which is factually wrong today

**Goal:** A fresh clone reaches a browsable, logged-in app in one documented pass,
and a developer who points a local worker at real credentials cannot destroy
their EVE contacts, a Wanderer ACL, Discord roles, or a production refresh
token by accident.

**Scope:** four stages, landing as four PRs in order. Stage 1 (the safety guard)
must merge before Stage 2 (env loading), because Stage 2 is what creates the
hazard Stage 1 defends against — see "Ordering is load-bearing" below.

---

## 1. Verified current state

Everything in this section was checked against the tree at `dd78815`, not
assumed. Commands and file:line citations are given so a reviewer can re-run
them.

### 1.1 One Postgres, two databases — `npm test` cannot touch dev data

`docker-compose.dev.yml` starts a single `postgres:16-alpine` published on
host port **5433** (`docker-compose.dev.yml:9`). Its entrypoint runs
`scripts/init-test-db.sql`, whose entire content is:

```sql
CREATE DATABASE authgd_test OWNER authgd;
```

So one server hosts two databases:

| Database | Used by | Destructive operations |
|---|---|---|
| `authgd` | `npm run dev`, `npm run worker`, `npm run db:migrate` | none automatic |
| `authgd_test` | `npm test`, `npm run test:e2e` | `TRUNCATE` between every test |

`tests/helpers/db.ts:6` and `playwright.config.ts:4` both default to
`postgres://authgd:authgd@localhost:5433/authgd_test`. The `TRUNCATE ... RESTART
IDENTITY CASCADE` in `e2e/helpers.ts:14-18` is issued on that connection only.

**This must be stated explicitly in the docs.** The truncation is alarming when
read out of context, and the isolation is invisible unless you happen to open
`scripts/init-test-db.sql`. Developers currently avoid running the test suite
because nothing tells them their dev data is safe. It is safe.

### 1.2 Nothing in this repository loads `.env`

There is no `dotenv` dependency, no `--env-file` flag, no `process.loadEnvFile()`
call. Verified:

```
$ grep -rn "dotenv\|loadEnvConfig\|loadEnvFile\|env-file" src scripts *.config.ts package.json fly.toml
$ echo $?
1
```

`next dev` loads `.env` and `.env.local` because Next.js does it internally.
`npm run worker` (`tsx src/worker/index.ts`) and `npm run db:migrate`
(`tsx src/db/migrate.ts`) do not.

```
$ node -v && npx tsx src/worker/index.ts
v26.5.0
worker failed to start ZodError: [
  { "code": "invalid_type", "expected": "string", "received": "undefined",
    "path": [ "DATABASE_URL" ], "message": "Required" },
  { "code": "invalid_type", "expected": "string", "received": "undefined",
    "path": [ "TOKEN_ENCRYPTION_KEY" ], ...
```

`src/db/migrate.ts:7` throws `DATABASE_URL not set` for the same reason.

**Consequence:** the documented local-dev flow in `docs/ops.md:86-94` does not
work on a fresh clone. Two of its four commands fail.

### 1.3 `.env.example` cannot boot the app

`ESI_CONTACT` is absent from `.env.example` entirely, and it is required
(`src/config.ts:57`). `TOKEN_ENCRYPTION_KEY` and every OAuth secret are blank,
which `z.string().min(1)` rejects. `cp .env.example .env` therefore produces a
multi-error `ZodError` even once env loading works.

### 1.4 Required environment surface

`src/config.ts` declares 24 keys. **18 are required with no default:**
`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `APP_BASE_URL`, `ALLIANCE_ID`,
`EVE_SSO_CLIENT_ID`, `EVE_SSO_CLIENT_SECRET`, `EVE_SSO_SCOPES`,
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`,
`DISCORD_GUILD_ID`, `DISCORD_ROLE_ID_FLYGD`, `DISCORD_ROLE_ID_BLUE`,
`DISCORD_ROLE_ID_GREEN`, `WANDERER_BASE_URL`, `WANDERER_API_KEY`,
`WANDERER_ACL_ID`, `ESI_CONTACT`.

The six with defaults or optionality: `SESSION_COOKIE_NAME`,
`BOOTSTRAP_ADMIN_CHARACTER_IDS`, `EVE_SCOPE_SET_VERSION`,
`DISCORD_OPS_WEBHOOK_URL`, `STANDINGS_LABEL`, `STANDINGS_VALUE`. Counts
re-derived mechanically from `src/config.ts`, not by hand.

`playwright.config.ts:8-31` is the proof that fake values satisfy all of them.
It is the authoritative reference for the fake set — Stage 2 derives from it
rather than inventing values.

### 1.5 The six external write surfaces

Not three destructive jobs. Six write surfaces, three of them non-obvious:

| Job | External mutation | Citation |
|---|---|---|
| `contacts` | ESI `addContacts` / `editContacts` / `deleteContacts` | `src/jobs/contacts.ts:125,144,160` |
| `wanderer` | ACL `addAclMember` / `removeAclMember` / `updateAclMemberRole` | `src/jobs/wanderer.ts:57,68,80` |
| `discord-roles` | Guild `addMemberRole` / `removeMemberRole` | `src/jobs/discord-roles.ts:71,134,137` |
| `token-health` | **EVE refresh-token rotation** | `src/jobs/token-health.ts:29` → `src/services/tokens.ts:78` |
| `purge` | Database `DELETE` only — no external client | `src/jobs/purge.ts` |
| *(cross-cutting)* | **Discord ops-webhook POST**, bypassing all three clients | `src/lib/ops-webhook.ts:18` |

**`token-health` is the surface nobody anticipates.** It walks every `character`
row and calls `getFreshAccessToken`, which calls `refreshEveToken`. EVE SSO
rotates the refresh token on every use. A local worker pointed at a *copy* of
the production database silently invalidates every production refresh token,
because production's stored blob becomes the superseded one. No API named
"delete" was called; the damage is a side effect of a read-shaped operation.
Any guard scoped to "the two destructive jobs" misses this entirely.

**`purge` defines the guard's hard limit.** It deletes rows through `db`, not
through an HTTP client. No integration-boundary guard can protect the database.
That is a documentation problem with exactly one solution: never put a
production `DATABASE_URL` in a local `.env`.

### 1.6 The three integration clients have two construction sites

```
$ grep -rn "createEsiClient\|createDiscordClient\|createWandererClient" src scripts | grep -v "^src/lib/"
src/worker/index.ts:28:    esi: createEsiClient({ userAgent: `authgd/0.1.0 (${cfg.esiContact})` }),
src/worker/index.ts:29:    wanderer: createWandererClient(cfg),
src/worker/index.ts:30:    discord: createDiscordClient(cfg),
scripts/wanderer-smoke.ts:25:  const wanderer = createWandererClient(cfg);
```

All three integration clients are constructed in two files, and jobs receive them
by injection (`JobDeps`, `src/worker/handlers.ts:39-46`). Within the ESI,
Discord, and Wanderer APIs, that makes the client boundary a *fail-safe* guard
rather than an opt-in one: a job cannot reach those three APIs any other way.

**This does not mean guarding the two factories covers everything.** Jobs have
two further routes to the network that do not pass through any client:

| Boundary | Route | Decision |
|---|---|---|
| ESI / Discord / Wanderer clients | injected via `JobDeps` | D2 |
| EVE token refresh | `services/tokens.ts` → `lib/esi/sso.ts` | D4 |
| Discord ops webhook | `lib/ops-webhook.ts` → bare `fetch` | D9 |
| Login / link OAuth exchange | route handlers → `lib/esi/sso.ts` | D3 — deliberately unguarded |

The complete safety design is **four guarded boundaries plus one deliberate
exclusion**, not two. A reviewer checking only the client factories has checked
roughly half of it.

### 1.7 Session forging already exists, pinned to e2e

`e2e/helpers.ts` provides `seedMember()` and `sessionCookieFor()`. The cookie
carries a raw 32-byte base64url token; the `session` row stores its SHA-256
(`helpers.ts:71-82`), mirroring `src/services/session.ts`. Both are hardcoded to
the **test** database (`helpers.ts:7`) and to `http://localhost:3111`
(`helpers.ts:81`).

### 1.8 Signature detail that shapes the design

`createEsiClient(opts: EsiClientOptions = {})` (`src/lib/esi/client.ts:61`) does
**not** receive `Config` — unlike the Discord and Wanderer factories, which do.
The sync mode must therefore reach it through `EsiClientOptions`, not `cfg`.

---

## 2. Decisions

### D1 — `SYNC_MODE` is required, with no default (option E1)

```ts
SYNC_MODE: z.enum(["live", "dry-run"]),   // no .default()
```

surfaced as `cfg.syncMode`.

**Rationale.** The alternatives both have a silent failure mode:

- Defaulting to `dry-run` means forgetting the production secret silently turns
  production sync into a no-op — recoverable, but potentially unnoticed for days.
- Defaulting to `live` means the dangerous configuration is the one you get by
  forgetting, which defeats the purpose.
- Requiring it means **no configuration mistake is silent.** Both environments
  state intent.

**Production impact — corrected; an earlier draft of this spec overstated the
safety net.** What actually happens if the secret is missing, traced rather than
assumed:

| Component | Behavior | Why |
|---|---|---|
| Release command | **Succeeds** | `src/db/migrate.ts` never calls `getConfig()` |
| `worker` | **Crash-loops at startup** | `getConfig()` at `src/worker/index.ts:16`, before any work |
| `web` | **Boots fine, then 500s on every request** | `getConfig()` is lazily cached (`src/config.ts:99-103`) and every caller is inside a route handler or page — `src/app/page.tsx:16`, `src/lib/request-session.ts:9`, etc. Nothing validates at module load |

**There is no automatic rollback.** `fly.toml` defines no `[checks]` and no
`[[http_service.checks]]` — the whole file is 24 lines and contains neither. The
`web` machine passes its implicit start check while serving errors.

**Therefore the deploy procedure is mandatory ordering, not a safety net:**

```bash
fly secrets set SYNC_MODE=live     # BEFORE the Stage 1 deploy, not with it
fly deploy
```

`fly secrets set` triggers its own rolling restart, so running it first means the
new code never runs without the value. This goes in the Stage 1 PR body and in
`docs/ops.md` as a required pre-step.

**Optional follow-up, not in scope:** a `/api/health` route that calls
`getConfig()` plus a `[[http_service.checks]]` entry pointing at it would make
*any* future config error fail the deploy instead of silently serving 500s.
Worth doing, but it is a new route and a `fly.toml` change with its own blast
radius — raised separately rather than smuggled into a local-dev PR.

Two other env-building sites must gain the key in the same commit or they break:
`playwright.config.ts` (→ `dry-run`) and the `fly secrets set` block in
`docs/ops.md` (→ `live`). `tests/helpers/config.ts` also needs it — see D10 for
why its value must be `live`.

### D2 — Enforcement lives at the external-client boundary (option D)

The mutating methods of `createEsiClient`, `createDiscordClient`,
`createWandererClient`, plus the token-refresh path, refuse to issue their
request when `syncMode === "dry-run"`, logging the intended call instead.

**Rationale.** Job code cannot bypass it, because jobs reach the network only
through injected clients (§1.6). A destructive call added to a future job is
guarded the day it is written, with nobody needing to remember. Guarding inside
each job (~8 call sites across 3 files) is opt-in per site — the wrong failure
direction for something whose worst case is deleting a real person's contacts.
Guarding in the scheduler is too coarse: it prevents exercising the jobs at all,
while the dispatcher keeps enqueuing work that never runs.

**Per-method, not per-`fetchImpl`.** All three clients accept
`fetchImpl: typeof fetch`, so a single dry-run fetch wrapper intercepting every
non-`GET` would be one function covering everything. Rejected: each client
strictly zod-parses its responses (`aclSchema` in `wanderer/client.ts:47`,
`parseBody` in `discord/rest.ts:27`), so a fetch-level fake must synthesize
per-endpoint bodies that satisfy those schemas — fragile, and it breaks silently
when a schema changes. Per-method wrapping is type-checked against each client's
own interface.

### D3 — Authentication is never guarded

`exchangeEveCode` (`src/app/auth/eve/callback/route.ts:40`) and the Discord
OAuth exchange are **excluded** from the guard. They mint new credentials from a
fresh authorization code and invalidate nothing. Guarding them would break local
login against real EVE SSO, which is precisely what Stage 4 sets out to enable.

The guard's subject is **sync writes**, not authentication.

### D4 — Dry-run blocks token refresh, and this degrades the contacts job

`getFreshAccessToken` (`src/services/tokens.ts:56`) refreshes *and* CAS-writes
the rotated blob. In dry-run it returns a new
`{ ok: false, reason: "dry_run" }` without calling EVE.

**This is a real functional limitation, not a paper cut.** Consequences:

- `token-health` becomes a full no-op in dry-run — but **only once it handles the
  new reason explicitly.** Its current fallback is `else counts.invalid++`
  (`src/jobs/token-health.ts:31`), which would silently classify every character
  as having an invalid token. No data damage (the permanent invalidation happens
  inside `tokens.ts`, which will not fire for `dry_run`), but the run report
  would be a lie. `src/jobs/token-health.ts` is therefore in Stage 1's file list,
  with `dry_run → counts.skipped` and a job-level test.
- `contacts` cannot obtain an access token, so it cannot read contacts, so it
  **cannot show you a diff preview**. Every eligible character records
  `recordResult(..., "dry_run", false)` and lands in `counts.skipped`.
- `wanderer` and `discord-roles` are unaffected — they authenticate with the ACL
  API key and the bot token, not per-character EVE tokens. Both give a **full**
  diff preview in dry-run: reads happen, the diff is computed, `sync_run` counts
  populate, and the intended writes are logged.

The alternative — refresh but skip the DB write — is strictly worse: it
invalidates the production token *and* discards the replacement. Rejected.

Accepting this limitation is the whole point. The scenario the guard exists for
is a developer with real credentials and a copy of production data; there,
refreshing is the damage.

### D5 — A startup banner, not a heuristic tripwire

`src/worker/index.ts` prints, before `boss.start()`, a banner naming the mode and
the three targets it would touch: `WANDERER_BASE_URL`, `DISCORD_GUILD_ID`,
`STANDINGS_LABEL`. "Which credentials is this terminal holding?" becomes
answerable at a glance.

**Rejected:** refusing to start when `DATABASE_URL` points at localhost while
`SYNC_MODE=live`. It is a heuristic with real false positives (anyone tunnelling
a production database to a local port), and a guard that cries wolf gets
disabled.

### D6 — Dry-run runs must never claim a mutation happened

The guarded client methods for Wanderer and Discord return `void` and, in
dry-run, return *normally*. Job code cannot tell the difference, so today's
control flow would record success for work that never happened:

```
src/jobs/wanderer.ts:57-61      await wanderer.addAclMember(id);
                                added++;
                                await logAudit(db, { action: "wanderer.added", ... });
src/jobs/discord-roles.ts:133-145   await discord.addMemberRole(...)  → logAudit "discord.role_changed"
```

Wrong counts are cosmetic. **Audit rows are not** — `audit_log` is the record of
what the system did to people's accounts, and filling it with fabricated
`wanderer.added` / `discord.role_changed` entries corrupts the one artifact an
operator trusts when reconstructing an incident.

**Decision.** In dry-run, `wanderer` and `discord-roles`:

- write **no** `logAudit` rows, and
- report under distinctly named counters — `wouldAdd`, `wouldRemove`,
  `wouldUnblock`, `wouldChangeRoles` — never `added` / `removed` / `unblocked`.

This deliberately reintroduces a small amount of job-level mode awareness, which
D2 otherwise avoids. The split is principled: **safety stays fail-safe at the
client boundary; honest reporting is a separate, non-safety-critical concern.** A
site missed here costs a misleading line in a developer's own log, not data. A
site missed at the boundary costs someone's contact list. The two failure
modes do not deserve the same mechanism.

`contacts` needs no equivalent change: per D4 it never reaches
`recordResult(..., "ok", true)` in dry-run, because it never obtains a token.

**Deferred:** a `sync_run.mode` column, the right long-term answer to "was this
run real?". It is a migration touching persisted data, which `CLAUDE.md` says to
stop and ask about. **Not in scope**, recorded as follow-up. The `would*` counter
names are the interim substitute and need no schema change (`counts` is already
a free-form object on `JobResult`).

### D7 — Env loading via Node's native `--env-file`, verified not assumed

Stage 2 makes `npm run worker` and `npm run db:migrate` read `.env`. (`db:seed`
does not exist until Stage 3 and adds the same flags when it is created — the
mechanism is decided here, the script's ownership stays with Stage 3.) Preferred
mechanism, on Node v26.5.0:

```
--env-file-if-exists=.env --env-file-if-exists=.env.local
```

No new dependency. **Semantics verified empirically on v26.5.0, not assumed:**

```
$ printf 'FOO=from_env\nONLY_ENV=yes\n' > .env && printf 'FOO=from_env_local\n' > .env.local
$ node --env-file-if-exists=.env --env-file-if-exists=.env.local \
    -e 'console.log("FOO=",process.env.FOO," ONLY_ENV=",process.env.ONLY_ENV)'
FOO= from_env_local  ONLY_ENV= yes

$ node --env-file-if-exists=.env.local --env-file-if-exists=.env -e 'console.log(process.env.FOO)'
from_env

$ node --env-file-if-exists=.nope -e 'console.log("ok")'
.nope not found. Continuing without it.
ok

$ FOO=from_shell node --env-file-if-exists=.env -e 'console.log(process.env.FOO)'
from_shell
```

Three properties confirmed, all of them the ones we need:

1. **The later flag wins**, and keys merge rather than replace — so
   `.env` then `.env.local` reproduces Next.js's precedence exactly, which
   Stage 4 depends on.
2. **A missing file is tolerated** (one stderr line, exit 0), so the flags are
   safe in an image that ships neither file.
3. **A real environment variable beats the file.** This is the important one for
   production: Fly injects secrets as actual environment variables, so adding
   these flags to `npm run worker` cannot let a stray `.env` inside the image
   override a Fly secret. The flags are safe to apply unconditionally rather
   than only in development.

`dotenv` is therefore not needed.

#### D7a — the flag requires Node ≥ 22.9.0, and that reaches production

`--env-file-if-exists` was added in Node 22.9.0. Below it, the flag does not
degrade — **it hard-fails before the program runs:**

```
$ for v in 22.0.0 22.8.0 22.9.0; do docker run --rm node:$v-alpine \
    sh -c 'printf "FOO=bar\n" > /tmp/.env; node --env-file-if-exists=/tmp/.env -e "console.log(process.env.FOO)"'; done
node: bad option: --env-file-if-exists=/tmp/.env     # 22.0.0
node: bad option: --env-file-if-exists=/tmp/.env     # 22.8.0
bar                                                  # 22.9.0
```

Two facts make this a production concern, not just a quickstart concern:

- `README.md:68` promises **"Requires Node.js 22+"** — broader than what works.
- `fly.toml:8` is `release_command = "npm run db:migrate"`. Fly runs the **npm
  script**, inside `node:22-alpine` (`Dockerfile:2,12`). Adding the flags to
  `db:migrate` therefore puts them on the deploy's critical path. A base image
  below 22.9 would fail **every deploy** at the release command.

It works today only because `node:22-alpine` currently resolves to v22.23.2
(verified above). That is a floating tag, so the current safety is incidental.

**Resolution, all three parts required in Stage 2:**

1. Add `"engines": { "node": ">=22.9" }` to `package.json` (there is no
   `engines` field today).
2. Correct `README.md:68` to "Node.js 22.9+".
3. Add `.npmrc` with `engine-strict=true`, so `npm install` fails loudly on an
   unsupported Node instead of producing a clone that breaks later at an
   unrelated-looking command.

The `Dockerfile` keeps `node:22-alpine`; with `engines` declared, a future
regression below 22.9 surfaces at install time in CI and locally.

**Rejected:** plain `--env-file` (Node 20.6+, wider support). It errors on a
missing file, which breaks both the production image (no `.env` shipped) and the
optional `.env.local` override. The `-if-exists` tolerance is exactly the
property we need.

### D8 — Dev seeding is extracted, not duplicated (Stage 3 — provisional)

Provisional pending Stage 3 detail work. Current intent: extract the shared
insert logic into a module that takes the database URL and base URL as
parameters, and have `e2e/helpers.ts` delegate to it while keeping its exact
current signatures and its test-DB/:3111 pins. The e2e suite must not change
behavior; a green `npm run test:e2e` is the acceptance gate.

### D9 — Dry-run suppresses ops-webhook posts

`src/lib/ops-webhook.ts` POSTs directly to `cfg.discord.opsWebhookUrl` via
`fetch` (`ops-webhook.ts:18`), bypassing all three client guards. Callers: the
dead-letter handler (`src/worker/index.ts:53`), `src/jobs/wanderer.ts:47`, and
`src/jobs/discord-roles.ts:30,44`. This is a sixth external write surface,
missed in §1.5's original inventory.

**Decision: suppress in dry-run**, logging the message locally instead. Both
`postOpsWebhook` and `postOpsWebhookOrThrow` already take `cfg`, so this is one
file and two early returns.

**Rationale.** Unlike authentication (D3), no local-development workflow needs a
real post to succeed. A developer running a worker against a real `.env` would
otherwise page the alliance's actual ops channel with alerts about their laptop
— noise landing on operators who reasonably conclude production is broken. It is
a notification, not state, so suppressing it costs nothing and cannot mask a
production problem, since production never runs dry-run.

`postOpsWebhookOrThrow` must resolve *successfully* when suppressed, not throw —
throwing would make the dead-letter handler retry the alert forever.

### D10 — `testConfig()` defaults to `live`

The shared unit-test helper `tests/helpers/config.ts` gets `SYNC_MODE: "live"`,
**not** `dry-run`.

**Rationale.** 13 test files build config through that helper, and the existing
suite asserts *live* behavior through it — `tests/tokens.test.ts:10` drives a
real refresh path, `tests/wanderer-job.test.ts:85-87` asserts
`{ added: 1, removed: 2 }` and `w.reads() === 2`. Defaulting the helper to
dry-run would suppress the very requests those tests exist to verify, turning a
large part of the suite green-but-meaningless — **the worst available failure
mode, because it would still pass.**

New safety tests pass `testConfig({ SYNC_MODE: "dry-run" })` explicitly. The
helper already takes `Partial<NodeJS.ProcessEnv>` overrides, so this needs no
signature change.

`playwright.config.ts` stays `dry-run`: e2e never exercises an external
integration, so nothing there depends on live behavior, and dry-run is the
correct default for a browsable app.

---

## 3. Ordering is load-bearing

Stage 1 must merge before Stage 2.

Today the worker cannot read `.env` (§1.2), so reaching real credentials requires
deliberately exporting them into the shell. **The hazard is currently latent.**
Stage 2 hands the worker whatever is in `.env` — it *creates* the exposure. If
Stage 2 lands first, there is a window in which a fresh clone with pasted-in real
credentials does the damage on the first `npm run worker`.

---

## 4. Stages

### Stage 1 — Safety guard (this spec's core)

| File | Change |
|---|---|
| `src/config.ts` | `SYNC_MODE` enum, required, no default → `cfg.syncMode` |
| `src/lib/esi/client.ts` | `syncMode` in `EsiClientOptions` (§1.8); guard `addContacts`/`editContacts`/`deleteContacts` |
| `src/lib/discord/rest.ts` | guard `addMemberRole`/`removeMemberRole` |
| `src/lib/wanderer/client.ts` | guard `addAclMember`/`removeAclMember`/`updateAclMemberRole` |
| `src/lib/ops-webhook.ts` | suppress both post functions in dry-run (D9) |
| `src/services/tokens.ts` | dry-run short-circuit → `reason: "dry_run"` (D4) |
| `src/jobs/contacts.ts` | handle the new reason; record `"dry_run"` |
| `src/jobs/token-health.ts` | `dry_run → counts.skipped`, not `counts.invalid` (D4) |
| `src/jobs/wanderer.ts` | no audit rows in dry-run; `would*` counters (D6) |
| `src/jobs/discord-roles.ts` | no audit rows in dry-run; `would*` counters (D6) |
| `src/worker/index.ts` | pass mode into `createEsiClient`; startup banner (D5) |
| `package.json`, `README.md:68`, `.npmrc` | `engines: node >=22.9`, `engine-strict` (D7a) |
| `playwright.config.ts` | `SYNC_MODE: "dry-run"` |
| `tests/helpers/config.ts` | `SYNC_MODE: "live"` — **not** dry-run (D10) |
| `docs/ops.md` | env table row; `fly secrets set SYNC_MODE=live`; the §1.5 database warning |

D7a lands in Stage 1 rather than Stage 2 because `engines` must be declared
before anything depends on the flag.

**Verification:** `npm test` (271 tests must stay green plus new coverage),
`npm run typecheck`, `npm run test:e2e`. New tests:

- config rejects a missing and an invalid `SYNC_MODE`
- each guarded client method issues **zero** matching requests in dry-run and
  exactly one in live (asserted with msw)
- `getFreshAccessToken` returns `dry_run` without calling EVE
- `token-health` reports `dry_run` as `skipped`, never `invalid`
- **`wanderer` and `discord-roles` write no `audit_log` rows in dry-run** —
  asserted by row count, since this is the finding with the worst blast radius
- `postOpsWebhook` / `postOpsWebhookOrThrow` issue no request in dry-run, and
  `postOpsWebhookOrThrow` resolves rather than throwing

**Deploy note carried in the PR body:** `fly secrets set SYNC_MODE=live`.

### Stage 2 — Runnable in one pass

Env loading for the non-Next entry points (D7); `.env.example` completed from
`playwright.config.ts`'s block plus `SYNC_MODE=dry-run` and a real
`ESI_CONTACT` placeholder; `docs/ops.md`'s "Local development" section
**replaced** (not duplicated elsewhere) with a first-run sequence that actually
works, an explicit statement of the §1.1 database isolation, a table of what
works on fakes versus what needs real credentials, and the warning that
`npm test` and `npm run test:e2e` share the test database and must never run
concurrently (`playwright.config.ts:35`, `workers: 1`).

`README.md:91` documents `npm run worker` too. `docs/ops.md` becomes canonical;
the README links to it rather than repeating it.

**Open item for Stage 2 — SUPERSEDED by #8, retained to record the change.**

This spec originally said `.env.example` should use `STANDINGS_LABEL=FLYGD`,
matching the then-current default. **That advice is now wrong.** #8
(`8cf303a`, merged after this spec was drafted) changed the default to `authgd`
for exactly the reason this whole spec exists: the contacts job deletes every
contact under its label that is not a member, and pointing that at `FLYGD` — a
list humans curate by hand — is what destroyed 130 contacts.

`.env.example` therefore uses **`STANDINGS_LABEL=authgd`**, or omits it and
takes the default. The complementary framing is worth stating: #8 makes the
blast radius small by default, this spec's guard stops the blast from reaching
a real account at all. Neither replaces the other.

The case-sensitivity note still holds — the match is exact
(`src/jobs/contacts.ts`), so a typo makes the job find no label and skip every
character, a confusing no-op rather than a visible error. `playwright.config.ts`
and `tests/helpers/config.ts` keep their lowercase `flygd`: no test resolves a
real label, and changing them would be churn.

### Stage 3 — Dev seed script — ⚠️ OUTLINE ONLY, NOT APPROVED

`npm run db:seed`. Seeds accounts across `flygd`/`blue`/`green`, alts, and an
admin; prints a paste-ready session cookie per account. Extraction decision per
D8, justified in the PR against the constraint that the e2e suite must not
regress.

**Two questions this spec does not answer. The first has persisted-data
consequences, which `CLAUDE.md` says to stop and ask about — so Stage 3 does not
begin until it is decided and approved.**

- **Rerun semantics.** `e2e/helpers.ts` gets a truncated database before every
  test, so `seedMember` never had to be idempotent — and its character ids come
  from a module-level `let nextCharId = 90_000_001` (`helpers.ts:21`) that resets
  each process. A dev seed run twice must not collide on that primary key or
  silently double every account. Candidates: truncate-then-seed (destructive,
  needs a confirmation prompt), upsert on a stable id range, or refuse to run
  against a non-empty database without `--force`. Not yet decided.
- **How the cookie actually gets used.** Printing a value is not a procedure.
  The docs must state the exact steps — the cookie name comes from
  `SESSION_COOKIE_NAME` (default `authgd_session`), the value is the raw token,
  the domain is `localhost`, path `/` — and note that it is `HttpOnly` in the
  app (`src/app/auth/eve/callback/route.ts:64`) but must be created manually via
  devtools, plus the Stage 4 interaction where an `https` `APP_BASE_URL` flips
  the cookie to `Secure` (`route.ts:66`:
  `secure: cfg.appBaseUrl.startsWith("https")`) and a cookie pasted for
  `http://localhost` will then be ignored.

### Stage 4 — Real OAuth against a tunnel

Documentation only. `APP_BASE_URL` with **no trailing slash** — it is
string-concatenated into both callbacks (`src/lib/discord/oauth.ts`,
`src/lib/esi/sso.ts`). Redirect URIs to register in the EVE and Discord
developer portals. `.env.local` for the override, since `.gitignore` is
`.env*` with `!.env.example` and `.env.local` takes precedence. Note that the
session cookie flips to `Secure` once `APP_BASE_URL` starts with `https`, and
how to switch back to localhost.

---

## 5. Out of scope

- `sync_run.mode` column (D6) — migration, deferred.
- Any change to the tier state machine, admin guard, or OAuth state flow.
- Protecting the database from a production `DATABASE_URL` in `.env` (§1.5) —
  documented, not engineered.
- Offline mode. Dry-run still performs reads; that is deliberate (§D2).

---

## 6. Baseline

Recorded in this worktree at `dd78815` before any change:

```
Test Files  39 passed (39)
     Tests  271 passed (271)
  Duration  35.88s
```

Note: host port 5433 was already held by a running `authgd-design-postgres-1`
container from an earlier compose project. It is the same image and credentials,
so it was reused rather than fought. Stage 2's docs should mention that a second
compose project cannot bind 5433 — `docker compose ... up -d` fails with
`Bind for 0.0.0.0:5433 failed: port is already allocated`, which reads like a
broken setup and is not.

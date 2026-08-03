# Ops hardening: health endpoints, machine sizing, dead config removal

Date: 2026-08-03

## Intent

Close the code-side half of seven open operational issues. External monitoring
currently has nothing to watch: the app exposes no health endpoint, and a
monitor pointed at `/login` would prove only that a web machine serves HTML —
it touches neither Postgres nor the worker, so it would not have caught the
worker outage that prompted this work.

This spec covers only work that lands in the repository. The remaining items
(key escrow, restore drill, Postgres patching, scope-change rehearsal, uptime
monitor signup) become `docs/runbooks.md` in a separate pass.

## Repository evidence

- No `src/app/api/**` routes exist. `/` redirects to `/login` (commit dd78815).
- `runJob` (`src/services/sync-run.ts`) writes one `sync_run` row per
  execution, including failures — `started_at` defaults to insert time.
- `membership` is scheduled `*/30 * * * *` (`src/worker/queues.ts:75`), the
  most frequent job, so it sets the natural staleness floor.
- The only `sync_run` index is `sync_run_job_type_id_idx` on
  `(job_type, id desc)` (`src/db/schema.ts:160`). There is no index supporting
  a global `max(started_at)`.
- `EVE_SCOPE_SET_VERSION` is parsed at `src/config.ts:39` and exposed as
  `scopeSetVersion` at `src/config.ts:77`, and read nowhere else. Bumping it
  has no effect. Re-auth flagging actually derives from comparing stored
  scopes against `EVE_SSO_SCOPES` in `src/jobs/token-health.ts:96-118` and
  `src/services/accounts.ts:70`.
- Sessions (`src/services/session.ts`) and OAuth PKCE state
  (`src/services/oauth-tx.ts`) are both Postgres-backed. The web tier holds no
  in-process request state, so it is safe to run more than one instance.
- `createDb` caps the pool at `max = 5` per process (`src/db/index.ts:12`).

## Design

### Endpoints

**`GET /api/health`** — liveness. Runs `select 1`. Returns 200
`{"ok":true,"db":"ok"}`, or 503 if the query throws. Both routes set
`dynamic = "force-dynamic"` and send `Cache-Control: no-store`: a health check
cached anywhere between the monitor and the app reports the past, which is
worse than no check at all.

**`GET /api/health/sync`** — worker freshness. Returns 200 if the newest
`sync_run` row is younger than 90 minutes, else 503 with
`{"ok":false,"newestRunAgeSec":…,"newestJobType":…}`.

Both are public. Neither body contains secrets, account data, or counts.

Three decisions:

- **Threshold is 90 minutes**, a constant in code with a comment tying it to
  the 30-minute `membership` schedule. Not configurable — a second knob that
  can drift from `queues.ts` buys nothing here.
- **The query is `order by id desc limit 1`**, not `max(started_at)`. The
  serial primary key makes this index-backed and effectively constant at this
  scale; `max(started_at)` has no supporting index and would seq-scan a table
  growing ~122 rows/day. Since `started_at` defaults to insert time, id order
  and insertion order agree closely enough for a staleness check — this is not
  a formal timestamp ordering guarantee under concurrent inserts, and does not
  need to be: the two orders can only disagree by the width of a race, far
  below a 90-minute threshold.
- **Zero rows returns 503.** "The worker has never run" is exactly the failure
  this endpoint exists to catch. Accepted consequence: a brand-new deploy
  reads red for up to 30 minutes, until the first `membership` tick.

Staleness is decided by a pure function in `src/core/health.ts` over
`(newestStartedAt, now, thresholdMs)`, consistent with the purity rule for
`src/core/`, so the threshold logic is testable without a database.

A run whose status is `failed` still counts as fresh. It proves the worker is
alive, which is what this endpoint measures. Job failures already surface on
`/admin/sync` and, for permanent Wanderer read errors, through
`DISCORD_OPS_WEBHOOK_URL`. Folding them in here would let one permanent config
error (for example `missing_label`) hold the check red indefinitely and train
the operator to ignore it.

### Fly configuration

Add `[[vm]]` blocks pinning `memory = "512mb"` for both process groups, making
sizing declarative and reviewable instead of living only in `fly scale` state.
The worker runs `npx tsx src/worker/index.ts`, transpiling at runtime, so it
carries more memory risk than the compiled web server; both are raised rather
than only one, to keep the groups uniform.

Add an HTTP check on `/api/health` for the `web` process only. A failing
`[[http_service.checks]]` check takes that Machine out of the load balancer's
rotation and gates deployment health; it does not restart the Machine.
`/api/health/sync` is deliberately never wired to it regardless: a stalled
worker would pull healthy web Machines out of rotation, taking the site down in
response to a fault that has nothing to do with serving pages, and could stall
a deploy that was never unhealthy.

`web=2` is a `fly scale count` operation, not a `fly.toml` field, so it belongs
in the runbook. It closes the deploy gap caused by `web=1`. `worker=1` and
single-node Postgres are retained deliberately: the Wanderer reconcile is
destructive, and HA Postgres adds real operational weight to an unmanaged
`postgres-flex` cluster.

Connection budget at `web=2`, which must be checked against the cluster rather
than assumed:

| Source | Connections |
|---|---|
| web pools (2 machines × `max` 5) | 10 |
| worker `createDb` pool | 5 |
| worker pg-boss pool (`src/worker/index.ts:19`) | 5 |
| **steady state** | **20** |
| release command (`src/db/migrate.ts`, capped at 1) | +1 |
| rolling replacement overlap, worst case (one web + one worker in flight) | +15 |
| **deploy peak, worst case** | **~36** |

The release command is capped at a single connection deliberately and its
comment already anticipates holding it while web and worker pools are live. The
deploy-peak figure assumes every replacement overlaps simultaneously, which is
pessimistic for Fly's default rolling strategy but is the number to size
against. **Before scaling to `web=2`, run `SHOW max_connections` on the
production cluster and confirm headroom above ~36**, accounting for the
superuser-reserved connections. If headroom is short, the lever is lowering the
per-pool `max` in `src/db/index.ts:12`, not skipping the check.

### Removing `EVE_SCOPE_SET_VERSION`

Delete from `src/config.ts` (both the schema entry and the `scopeSetVersion`
field), `.env.example`, the `docs/ops.md` environment table, and the
first-deploy `fly secrets set` block. Three test-support files set it and must
be updated: `tests/config.test.ts:13`, `tests/helpers/config.ts:14`, and
`playwright.config.ts:17`.

The authoritative design also states the contradiction and must be corrected:
`docs/superpowers/specs/2026-08-02-authgd-design.md:117` opens with "the
configured scope set carries a version" and then correctly describes the
mechanism that actually exists — the token health job flagging characters whose
granted scopes no longer cover the required set. Strike the version clause and
keep the rest of the sentence, which was accurate all along.

The variable documents behavior the code does not implement, which is worse
than absent. The real re-auth lever is `EVE_SSO_SCOPES`, and that is what the
rehearsal runbook will exercise. Leaving the secret set on Fly is harmless; the
runbook can `fly secrets unset` it.

### Documentation

`docs/ops.md` gains a monitoring section covering both endpoints, what each
proves, which one Fly watches and why the other must not be, and the external
monitor setup. The redundancy and sizing choices are recorded there as
decisions with their reasoning, so they are chosen rather than inherited.

## Verification

Unit tests over the pure freshness function: fresh, stale, no-rows, and the
exact 90-minute boundary (defining whether the boundary itself is fresh, so the
comparison operator is pinned by a test rather than by accident).

Route-handler tests against the test database, following the
`tests/auth-routes.test.ts` pattern:

- `/api/health` returns 200 with `{"ok":true,"db":"ok"}`.
- `/api/health` returns 503 when the database is unreachable — injected by
  pointing the handler at a closed or bad-credential pool, not by asserting the
  happy path and assuming the failure branch works.
- `/api/health/sync` returns 503 with an empty `sync_run`, and the response
  body carries the documented no-row shape.
- `/api/health/sync` returns 503 with a row older than the threshold, and
  `newestRunAgeSec` reflects it.
- `/api/health/sync` returns 200 after inserting a recent row.
- Both routes send no-store cache headers and are not statically rendered, so a
  cached 200 cannot mask an outage.

Then the existing suite, lint, typecheck, and build.

Post-deploy, before scaling to `web=2`: `SHOW max_connections` on the
production cluster, checked against the ~36 worst-case deploy peak above.

## Out of scope

Per-job staleness thresholds; any authentication on the health endpoints; HA
Postgres; `worker=2`; and the four non-code items — key escrow, restore drill,
Postgres patching, and the scope-change rehearsal. Those become
`docs/runbooks.md`.

The restore drill depends on the `TOKEN_ENCRYPTION_KEY` escrow decision:
a restored volume is unreadable without that key, so the key's location must be
settled before a restore test means anything.

# Contributing

Thanks for looking. This is a small project with a live deployment behind it, so
the conventions below are less about style and more about the handful of rules
that keep a real corp's data safe.

## Getting set up

See [Quickstart](README.md#quickstart-local-development) — Docker for Postgres,
`cp .env.example .env`, `npm run db:migrate`, `npm run dev`. The example env is a
complete set of working fakes: the app, the migrations, and both test suites run
against it with no editing, and `SYNC_MODE=dry-run` means nothing can reach EVE,
Discord, or Wanderer.

[`docs/ops.md` → Local development](docs/ops.md#local-development) is the longer
guide: what works on fakes and what needs real credentials, running tests
alongside another checkout, and logging in without EVE SSO.

## Verification

CI runs four jobs. Before you push, run what the first and last cover:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test          # needs the dev Postgres running
npm run test:e2e
```

**`typecheck`, `lint`, and `format:check` are one CI job**, and any one of them
fails the whole thing — a green `typecheck` proves a third of it. `format:check`
runs `prettier --check .` over the whole repo, so checking only your own files
will pass locally while CI fails; `npm run format` fixes it.

The other two CI jobs are `npm run build` and `docker build .`. The Docker one
exists because `.dockerignore` prunes the build context: a file that reaches into
an ignored directory typechecks clean on every PR and only fails at deploy.

Note that starting the dev server — including the one Playwright boots — rewrites
the tracked `tsconfig.json` and `AGENTS.md`. Both are tracked files: restore them
with `git checkout --`, never delete them, and never `git add -A` after an e2e
run.

## The rules that matter

**Web enqueues; the worker executes.** A page or server action never performs a
sync itself — it writes its state change and enqueues a job. The worker
(`src/worker/`, `src/jobs/`) owns every outbound call to ESI, Discord, and
Wanderer. This is what makes a slow or failing integration a background retry
instead of a hung request, and it is why every sync job is an idempotent
diff-and-apply: re-running one must always be safe.

**`src/core/` is pure.** Diff logic, the tier state machine, health verdicts,
scheduling maths. No database handle, no `fetch`, no ambient clock — inputs in,
decision out. It imports types and error classes, nothing that does I/O. This is
where the logic worth testing exhaustively lives, and its tests need no fixtures.
If a function in `src/core/` wants a database, it belongs in `src/services/`.

**Every state change writes an audit row.** Tier changes, links, unlinks, admin
actions, sync outcomes — with the actor and the cause. A code path that changes
what a member is entitled to and leaves no audit trail is a bug, not an
omission.

**Derole, don't boot.** Someone leaving the alliance drops to a lower tier. They
keep their account, their linked characters, their ESI tokens, and their Discord
link. Nothing in a normal flow deletes a member's data — returning has to be
frictionless.

**Migrations are generated, never hand-written.** Edit the Drizzle schema in
`src/db/schema.ts`, then run `npm run db:generate` and commit what it produces.
Never edit a migration that has already been applied to a running deployment —
`fly.toml` runs migrations as a release command on every deploy, so an edited one
either fails or silently diverges. Destructive or data-rewriting migrations
(renaming an enum value, dropping a column) need a deploy runbook in
`docs/ops.md` alongside them: the scale-down and scale-up steps, the exact SQL
to revert, and how to clear the migration's row from
`drizzle.__drizzle_migrations` so the next forward deploy re-applies it.

**Secrets stay out of the repo and out of logs.** ESI refresh tokens are
encrypted at rest with `TOKEN_ENCRYPTION_KEY`; don't log decrypted tokens, and
don't log the key. `.env.example` holds fakes only.

**Branding is configuration.** No corp name, tier label, or motto is compiled in.
If you find yourself typing a real corporation's name into `src/`, it belongs in
a `BRAND_*` or `TIER_LABEL_*` variable instead — see
[Making it yours](README.md#making-it-yours).

**Planning artifacts stay local.** `docs/superpowers/` is gitignored. Specs,
plans, and handovers written while working on a change are a record of one
deployment's internal reasoning and vocabulary, not documentation for anyone
running a fork — don't force-add them. Anything durable that comes out of that
work belongs in `README.md`, `CONTRIBUTING.md`, `docs/ops.md`, or a code comment
next to the decision it explains.

## Pull requests

- One change per PR, with the reasoning in the description. If it touches a
  migration, say so in the first line.
- Conventional commit subjects (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
  `chore:`), scoped where it helps (`fix(payouts): …`).
- Add or update tests for meaningful behaviour changes. Pure logic goes in
  `src/core/` with unit tests; anything a member or admin can see is worth an
  e2e assertion.
- Comment intent and trade-offs, not a restatement of the code. The existing
  comments explain *why* a value or ordering is what it is — match that.

## Reporting a security issue

Please do not open a public issue for anything involving tokens, sessions, the
admin guard, or the OAuth flows. Report it privately — a GitHub security advisory
on the repository if private reporting is enabled, otherwise contact the
maintainer directly.

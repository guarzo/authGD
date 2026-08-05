# Open-source de-branding — design

Date: 2026-08-04

## Goal

Make authGD self-hostable by another EVE Online corporation. Today the corp's
own vocabulary is baked into the schema, the code, the CSS, the env var names,
and the art: `flygd`, `blue` and `green` appear 352 times across 73 files, and
`tier` is a Postgres enum holding those literal values.

Two outcomes:

1. **Operational security.** No published artifact and no default install
   carries the corp's tier names. This is a direct request from the CEO.
   Scope is deliberate and narrow: **this deployment's own UI continues to show
   FlyGD / Blue / Green** to signed-in members, via label configuration. The
   concern is public disclosure, not internal display. Consequences of that
   choice are enumerated under *Publication prerequisites*.
2. **Reusability.** Another corp can clone, configure, and deploy without
   editing code — within the audience below.

### Target audience

**Alliance-affiliated corporations already running both Discord and a Wanderer
map.** Discord, Wanderer, standings push, and a single positive `ALLIANCE_ID`
all remain mandatory (D6), and membership is tested against the main
character's *alliance*. Standalone corporations, corporations not in an
alliance, deployments without a Wanderer map, and deployments that want auth
without standings are **not supported** and are not made to work by this change.
Stated rather than implied, because "another corp can deploy it" reads wider
than what ships.

Deployment model is **self-hosted, one corp per deploy**. Multi-tenancy is out
of scope.

## Decisions

| #   | Decision | Rationale |
| --- | -------- | --------- |
| D1 | Tier enum renamed to `member \| associate \| alumni` (+ existing `pending`) | Semantic and corp-neutral. Display labels are separate config, so the published source carries no corp vocabulary in live code — a display-only rename would have left `flygd` on every line of a public repo. |
| D2 | Migration deployed behind a maintenance window, single `RENAME VALUE` | `fly.toml` runs migrations as a release command *before* machines are replaced, so old code would query a type with no `flygd` value. Expand/contract would avoid the window at ~3× the work, which does not pay for itself at this scale. |
| D3 | Migration hand-written if `db:generate` emits a destructive recreate | `CLAUDE.md` says migrations are generated, never hand-written. Drizzle-kit prompts on renamed tables and columns, not enum *values*, so the likely generated diff is a drop-and-recreate with a column cast on a live `NOT NULL` column. That is materially riskier than the rule is trying to prevent. Documented exception. |
| D4 | `audit_log` history left as-is, **no alias map**; legacy rows render their raw stored string | The audit trail is append-only. An alias was considered and rejected: the audit page renders `summarizeDetails()` output as plain text (`admin/audit/page.tsx:444-447`), never a `<Tier>` badge, and every `account.tier` value is rewritten by the migration — so a legacy value reaches text only. With `TIER_LABEL_MEMBER="FlyGD"` set, an unaliased pre-rename row reads `flygd` where a new row reads `FlyGD`: a casing difference on historical rows, for one deployment. Not worth a permanent `flygd`/`blue`/`green` literal in published source. |
| D5 | Label resolution split across the purity boundary | Pure `resolveTierLabel(tier, labels)` lives in `src/core/`; a thin `tierLabel(tier)` in the app layer supplies `getConfig().tierLabels`. `summarize.ts` stays pure and receives `labels` as a parameter, matching its existing `roleNames` pass-in (line 168). |
| D6 | Discord/Wanderer/standings/`ALLIANCE_ID` stay mandatory | The target audience runs all of them. Making each optional would add config branches, job skips, and UI states for users this release does not serve. Narrows the audience — stated above. |
| D7 | `?tier=flygd` bookmarks not redirected | Admin-only bookmarks; the existing whitelist already drops unknown values safely (falls through to "no filter"). A redirect map would put the old vocabulary in the published source indefinitely. |
| D8 | No back-compat shim for the old `DISCORD_ROLE_ID_*` names | The maintenance window means both sets are present before the new image boots. A shim would leave corp vocabulary in the published source as a permanent fallback. |
| D9 | Git-history handling deferred to publish time | Decided once the clean tree is visible. **Does not by itself satisfy goal 1** — see *Publication prerequisites*. |
| D10 | Branding reaches client components via React context from the root layout | `src/app/error.tsx` is a `"use client"` boundary that hoists its own `<title>` (line 138) and cannot call `getConfig()`. A `NEXT_PUBLIC_` var would bake the value at build time, defeating configuration for anyone deploying a prebuilt image. |

## Repository evidence

| Fact | Source |
| ---- | ------ |
| `tier` declared `('flygd','blue','green')`, `pending` appended later | `drizzle/0000_slim_james_howlett.sql:4`, `drizzle/0006_powerful_infant_terrible.sql:1` |
| Column default is `'green'` | `src/db/schema.ts:45` |
| Migrations run as a Fly release command every deploy | `fly.toml` `[deploy] release_command` |
| Role IDs keyed by tier name in config and in core logic | `src/config.ts:71-73`, `src/core/role-diff.ts:1` |
| Audit details stored in a `jsonb` column named `details` | `src/db/schema.ts:196` (`payload` at `:115` belongs to `outbox`) |
| Audit details render as text, never as a tier badge | `src/app/admin/audit/page.tsx:444-447` |
| Tier is an admin URL parameter | `src/app/admin/accounts/page.tsx:55,101,171` |
| CSS keys tone classes off the enum value | `src/app/globals.css:52-54,1233-1242` |
| Payout operator access gated on the top tier literal | `src/app/payouts/access.ts:17,35,55` |
| No raw tagged-template SQL contains a tier literal — all access is via Drizzle | grep over `src` |
| No `ORDER BY tier` — enum sort order is not load-bearing | `src/services/admin-accounts.ts` |
| `.env.example` exists and pins the old role vars | `.env.example:49-51` |
| `error.tsx` is a client component | `src/app/error.tsx` (`"use client"`) |

### Runtime branding inventory

Complete, not a sample:

| Site | What |
| ---- | ---- |
| `src/app/layout.tsx:24,25` | `metadata.title` default and template |
| `src/app/layout.tsx:27` | `description` — contains `[FLYGD]` |
| `src/app/error.tsx:138` | hoisted `<title>` in a client boundary |
| `src/app/_components/ui.tsx:101` | header wordmark |
| `src/app/login/page.tsx:39` | seal `alt` text |
| `src/app/login/page.tsx:43` | login `<h1>` |
| `src/app/login/page.tsx:45-47` | corp motto |
| `src/app/login/page.tsx:82` | footer — `Est. MMXXV · [FLYGD]` |

Corp vocabulary also appears in comments at `src/services/account-view.ts:22`
and `src/app/error.tsx:133`; both are updated with the code they describe.

## Data model and migration

Mapping: `flygd → member`, `blue → associate`, `green → alumni`. `pending` is
untouched. `RENAME VALUE` preserves declaration order, so the type's sort order
stays `member, associate, alumni, pending`.

```sql
ALTER TYPE "public"."tier" RENAME VALUE 'flygd' TO 'member';--> statement-breakpoint
ALTER TYPE "public"."tier" RENAME VALUE 'blue' TO 'associate';--> statement-breakpoint
ALTER TYPE "public"."tier" RENAME VALUE 'green' TO 'alumni';--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "tier" SET DEFAULT 'alumni';
```

`RENAME VALUE` rewrites no rows — it is a catalog update, instant regardless of
table size, with no lock-duration concern.

`audit_log.details` is **not** migrated. Historical rows keep
`{"from":"flygd","to":"green"}` and render that string verbatim (D4).

### Deploy procedure

Added to `docs/ops.md` **in PR1**, alongside the migration it describes.

1. `fly scale count web=0 worker=0`
2. Set `DISCORD_ROLE_ID_MEMBER`, `_ASSOCIATE`, `_ALUMNI` — values copied
   verbatim from the existing three secrets. Leave the old three set.
3. Deploy; the release command runs the migration
4. `fly scale count web=1 worker=1`, verify `/api/health` and one admin page
5. `fly secrets unset DISCORD_ROLE_ID_FLYGD DISCORD_ROLE_ID_BLUE DISCORD_ROLE_ID_GREEN`

Step 5 is last and separate so a rollback still has a bootable old image.

### Rollback

Retaining the old secrets is **necessary but not sufficient**: after the rename,
the old image's queries use enum values Postgres no longer accepts, so it fails
on every tier read regardless of its configuration. The enum must be reverted
*before* the old image starts. Ordered recovery:

1. `fly scale count web=0 worker=0`
2. Run the inverse SQL against the database:
   ```sql
   ALTER TYPE "public"."tier" RENAME VALUE 'member' TO 'flygd';
   ALTER TYPE "public"."tier" RENAME VALUE 'associate' TO 'blue';
   ALTER TYPE "public"."tier" RENAME VALUE 'alumni' TO 'green';
   ALTER TABLE "account" ALTER COLUMN "tier" SET DEFAULT 'green';
   ```
3. Confirm the old `DISCORD_ROLE_ID_FLYGD/_BLUE/_GREEN` secrets are still set;
   re-set them if step 5 above already ran
4. Deploy the previous image
5. `fly scale count web=1 worker=1`

Also delete the applied row for this migration from `__drizzle_migrations`,
or the next forward deploy will skip re-applying it.

The inverse SQL lives in the PR description and in `docs/ops.md`, **not** as a
committed migration file — committing it would apply it on the next deploy.

## Configuration

### Tier labels

```
TIER_LABEL_MEMBER     optional, default "Member"
TIER_LABEL_ASSOCIATE  optional, default "Associate"
TIER_LABEL_ALUMNI     optional, default "Alumni"
TIER_LABEL_PENDING    optional, default "Pending"
```

Surfaced as `config.tierLabels: Record<Tier, string>`. Defaults are the generic
names, so a fresh clone shows generic vocabulary; only this deployment's own
secrets make it read "FlyGD / Blue / Green".

### Branding

```
BRAND_NAME      optional, default "authGD"
BRAND_TAGLINE   optional, default "Auth"
BRAND_MOTTO     optional, default "" (hidden when empty)
BRAND_FOOTER    optional, default "" (hidden when empty)
BRAND_MARK_URL  optional, default "/brand/seal-sm.webp"
BRAND_SEAL_URL  optional, default "/brand/seal.webp"
```

`layout.tsx` exports a static `metadata` object today; it becomes
`generateMetadata()` reading config, covering the title default, template, and
description. `SiteHeader` and `login/page.tsx` read the same values, with image
alt text derived from `BRAND_NAME`. The motto and footer are optional strings
rather than hardcoded copy, and render nothing when unset — a fresh install has
no motto, and this deployment sets its own.

`error.tsx` is a client boundary and cannot read config (D10). The root layout
renders a small server-side provider carrying `{name, tagline}`; `error.tsx`
consumes it for its hoisted `<title>`. Error boundaries mount inside the root
layout, so the provider is always above them.

### Discord role IDs

`DISCORD_ROLE_ID_FLYGD/_BLUE/_GREEN` → `_MEMBER/_ASSOCIATE/_ALUMNI`.
`config.discord.roleIds` keys become `{member, associate, alumni}`. Still
required, still `z.string().min(1)` — a missing one still fails at boot.
`.env.example:49-51` is updated in the same PR.

### Label resolution

`src/core/tier-labels.ts` exports the pure function:

```ts
resolveTierLabel(tier: string, labels: Record<string, string>): string
```

It returns `labels[tier]` and falls back to `tier` verbatim for anything
unrecognised — which is what renders pre-rename audit values (D4) and any
unexpected data.

`src/app/_components/labels.ts` exports `tierLabel(tier: string): string`, a
thin server-only wrapper calling `resolveTierLabel(tier, getConfig().tierLabels)`.
`Tier` in `ui.tsx` uses it. `summarize.ts` takes `labels` as a parameter from
the page and calls `resolveTierLabel` directly, so it stays a pure function of
its arguments, as its own comment at line 169 requires.

## Rename sweep

**Core** (`src/core/`, stays pure): `tier.ts` — the `Tier` union and
`decideTier`'s `"member" | "alumni" | null` return; `role-diff.ts` —
`ManagedRoleIds = {member, associate, alumni}` and the three `input.managed.*`
reads across `diffRoles`, `stripManagedRoles`, `validateRoleConfig`.

**Services**: `desired.ts` is the widest rename — `FlygdCharacter` →
`MemberCharacter`, `getFlygdCharacters` → `getMemberCharacters`, and
`isContactsTarget`'s literal; the type and function are imported by
`contacts.ts`, `wanderer.ts`, and their tests. Also `admin-accounts.ts` (the
tier parameters and the `tier === "blue"` locking rule), `accounts.ts`,
`account-view.ts`, `payouts.ts`.

**Jobs**: `membership.ts`, `contacts.ts`, `wanderer.ts`.

**App**: `payouts/access.ts` (the operator gate), `admin/accounts/page.tsx`
`TIER_FILTERS`, `admin/accounts/actions.ts`, `admin/audit/summarize.ts`,
`payouts/*`, `account/account-payouts.tsx`, `globals.css`.

**CSS**: `--tier-flygd/-blue/-green` → `--tier-member/-associate/-alumni`;
`.tier--flygd` → `.tier--member` and so on. The oklch values are unchanged, so
the palette is visually identical. `.tier--unknown` and `.tier--pending` are
untouched.

**Tests**: `tests/helpers/seed.ts:10,20` and `e2e/helpers.ts:26,43` (union type
and the `?? "green"` default → `?? "alumni"`); `tests/helpers/config.ts:24`'s
`STANDINGS_LABEL: "flygd"` → `"authgd"`, matching the production default.

Doc comments carrying the old vocabulary are updated alongside the code they
describe — `desired.ts`'s "every character of every FlyGD account",
`admin-accounts.ts:27,116`, `tier.ts`'s membership rule, `access.ts`'s three
references, `account-view.ts:22`, `error.tsx:133`.

### Method

`flygd` is safe to sweep mechanically: 352 unambiguous occurrences. `blue` and
`green` are **not** — they collide with colour identifiers throughout
`globals.css` and elsewhere (221 `green` hits, mostly not tiers). Those two are
reviewed per-hit and filtered to tier context. `code-reviewer` runs on the diff
before the PR, asked specifically to look for a missed literal and for an
over-eager colour rename.

## Error handling

- An unrecognised tier value returns verbatim from `resolveTierLabel()` and
  renders `.tier--unknown` (neutral grey) — existing behaviour at
  `ui.tsx:220-222`, deliberately preserved. A data problem stays visibly a data
  problem rather than borrowing another tier's colour.
- `TIER_LABEL_*` and `BRAND_*` are optional with defaults and cannot fail
  startup.
- `validateRoleConfig`'s "three distinct role ids" check is unchanged; only the
  key names move.

## Testing

- **Unit** (`npm test`, Postgres on :5433): `tier.test.ts`, `role-diff.test.ts`,
  `desired.test.ts`, `admin-accounts.test.ts`, `deprovision-flow.test.ts`,
  `audit-summarize.test.ts` and `config.test.ts` move to the new vocabulary.
  New: `resolveTierLabel()` returns the configured label for a known tier and
  the raw string for an unrecognised one (including a legacy `flygd`).
- **E2E** (`npm run test:e2e`): specs assert against the *default* generic
  labels, never this deployment's, so the suite does not depend on secrets.
- **Migration**: verified on a scratch database — apply, confirm row values and
  that `pg_enum` order is preserved, then apply the documented inverse and
  confirm the round-trip.
- `npm test`, `npm run typecheck`, `npm run test:e2e` and `npm run format:check`
  output is quoted, not asserted. `format:check` runs per task, not only at the
  final gate.

## Delivery

Three PRs, each in its own linked worktree.

1. **Rename sweep + migration + runbook.** Ships with `TIER_LABEL_*` absent, so
   the UI reads the generic names. Includes `.env.example` and the `docs/ops.md`
   deploy and rollback procedures — the runbook must exist before the migration
   ships. This is the deploy needing the maintenance window.
   Dispatch: `sync-engine-dev` takes `src/{core,services,jobs,db}` and
   `drizzle/`; `frontend-dev` takes `src/app/` and `e2e/`. They run in parallel
   against the shared rename map recorded in the implementation plan, so the two
   halves cannot drift.
2. **Labels, branding config, and neutral assets.** `TIER_LABEL_*`, `BRAND_*`,
   `resolveTierLabel`/`tierLabel`, `generateMetadata()`, the client-boundary
   provider — *and* the neutral placeholder art in `public/`. Assets ship here,
   not in PR3: shipping configurable branding whose defaults still point at corp
   artwork would leave a deployable state that violates goal 1. This deployment
   sets its own secrets and asset URLs and reads "FlyGD / Blue / Green" again.
3. **Documentation.** README rewritten with a generic tier table, the stated
   audience, and a real setup section (EVE SSO app registration, Discord bot and
   three roles, Wanderer ACL key, `TOKEN_ENCRYPTION_KEY` generation, Postgres,
   `SYNC_MODE`); `PRODUCT.md` and `DESIGN.md` de-branded; `CONTRIBUTING.md`.
   `art/` and `docs/assets/hero.png` move out of the repo as source art rather
   than runtime assets.

## Publication prerequisites

Goal 1 is about published artifacts, and the three PRs above do **not** by
themselves achieve it. After PR3, the working tree still contains the corp's
tier names in:

| Location | Why it persists |
| -------- | --------------- |
| `drizzle/0000_slim_james_howlett.sql:4` and the six `drizzle/meta/*_snapshot.json` | Applied migration history; editing them breaks the checksum against the production `__drizzle_migrations` table |
| The new rename migration (`drizzle/0007_*.sql`) | Its whole content is the old → new mapping |
| `docs/superpowers/specs/` and `docs/superpowers/plans/` | ~12 existing documents, including this one |
| Git history and blobs | D9 |

Options, to be decided at publish time alongside D9:

- **Sanitized baseline.** Publish with `drizzle/` squashed to a single baseline
  generated from the post-rename schema. Removes every migration leak. Cost:
  the public repo's migration history diverges from this deployment's, and
  rebaselining against the live `__drizzle_migrations` table is itself risky —
  it is only safe if the public repo is a separate artifact, not this one.
- **Exclude `docs/superpowers/`** from the published tree. Cheap; loses the
  design trail that makes the project legible to a contributor.
- **Publish a fresh repo** whose initial commit is the sanitized tree, keeping
  this repo private as the working history. Solves migrations, docs, and history
  in one move; costs the public repo its blame and provenance, and creates two
  repos to keep in sync.
- **Accept the residual disclosure** and narrow goal 1 to "no live code and no
  default install carries the names", explicitly excluding migration history and
  design docs.

This section exists so that decision has a concrete inventory rather than being
rediscovered at publish time.

## Out of scope

`src/lib/triff/`, the payouts subsystem itself, git-history rewriting,
multi-tenancy, making any integration optional, and configurable
corp-vs-alliance membership. Noted, not touched.

## Residual risks

1. If `db:generate` emits something other than `RENAME VALUE`, the actual SQL is
   reported before anything is committed (D3).
2. Between deploys 1 and 2 the admin UI shows "Member / Associate / Alumni".
   Deliberate; the reason PR2 follows closely.
3. Old `?tier=flygd` bookmarks silently show all accounts rather than erroring
   (D7).
4. Pre-rename audit rows read `flygd` where new rows read `FlyGD` (D4).
5. Goal 1 is not met until a publication option is chosen — see above.

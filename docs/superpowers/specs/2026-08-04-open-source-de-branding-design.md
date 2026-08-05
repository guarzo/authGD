# Open-source de-branding — design

Date: 2026-08-04

## Goal

Make authGD self-hostable by another EVE Online corporation. Today the corp's
own vocabulary is baked into the schema, the code, the CSS, the env var names,
and the art: `flygd`, `blue` and `green` appear 352 times across 73 files, and
`tier` is a Postgres enum holding those literal values.

Two outcomes:

1. **Operational security.** No deployment shows, and no published source
   contains, the corp's tier names. This is a direct request from the CEO.
2. **Reusability.** Another corp can clone, configure, and deploy without
   editing code.

Deployment model is **self-hosted, one corp per deploy**. Multi-tenancy is out
of scope.

## Decisions

| # | Decision | Rationale |
| - | -------- | --------- |
| D1 | Tier enum renamed to `member \| associate \| alumni` (+ existing `pending`) | Semantic and corp-neutral. Display labels are separate config, so the public source carries no corp vocabulary at all — a display-only rename would have left `flygd` on every line of a public repo. |
| D2 | Migration deployed behind a maintenance window, single `RENAME VALUE` | `fly.toml` runs migrations as a release command *before* machines are replaced, so old code would query a type with no `flygd` value. Expand/contract would avoid the window at ~3× the work, which does not pay for itself at this scale. |
| D3 | Migration hand-written if `db:generate` emits a destructive recreate | `CLAUDE.md` says migrations are generated, never hand-written. Drizzle-kit prompts on renamed tables and columns, not enum *values*, so the likely generated diff is a drop-and-recreate with a column cast on a live `NOT NULL` column. That is materially riskier than the rule is trying to prevent. Documented exception. |
| D4 | `audit_log` history left as-is, legacy values aliased on read | The audit trail is append-only; rewriting it to hide vocabulary would break the one promise an audit log makes. Cost is a three-entry alias map, permanently. |
| D5 | Labels resolved via `tierLabel()` reading config, not threaded as props | `ui.tsx`, `standing.tsx` and `admin/accounts/page.tsx` are all server components — the only `"use client"` in `ui.tsx` is inside a comment (line 314). `src/core/` and `summarize.ts` stay pure and receive labels as arguments, matching the existing `roleNames` pass-in. |
| D6 | Discord/Wanderer/standings/`ALLIANCE_ID` stay mandatory | The target audience runs all of them. Making each optional would add config branches, job skips, and UI states for users who do not exist. |
| D7 | `?tier=flygd` bookmarks not redirected | Admin-only bookmarks; the existing whitelist already drops unknown values safely (falls through to "no filter"). A redirect map would put the old vocabulary in the public source indefinitely. |
| D8 | No back-compat shim for the old `DISCORD_ROLE_ID_*` names | The maintenance window means both sets are present before the new image boots. A shim would leave corp vocabulary in the public source as a permanent fallback. |
| D9 | Git-history handling deferred | Decided at publish time, once the clean tree is visible. |

## Repository evidence

| Fact | Source |
| ---- | ------ |
| `tier` declared `('flygd','blue','green')`, `pending` appended later | `drizzle/0000_slim_james_howlett.sql:4`, `drizzle/0006_powerful_infant_terrible.sql:1` |
| Column default is `'green'` | `src/db/schema.ts:45` |
| Migrations run as a Fly release command every deploy | `fly.toml` `[deploy] release_command` |
| Role IDs keyed by tier name in config and in core logic | `src/config.ts:71-73`, `src/core/role-diff.ts:1` |
| Audit payloads store raw tier strings in `jsonb` | `src/db/schema.ts:115,187`, `src/app/admin/audit/summarize.ts:132,143,149` |
| Tier is an admin URL parameter | `src/app/admin/accounts/page.tsx:55,101,171` |
| CSS keys tone classes off the enum value | `src/app/globals.css:52-54,1233-1242` |
| Payout operator access gated on the top tier literal | `src/app/payouts/access.ts:17,35,55` |
| No raw tagged-template SQL contains a tier literal — all access is via Drizzle | grep over `src` |
| No `ORDER BY tier` — enum sort order is not load-bearing | `src/services/admin-accounts.ts` |
| Branding hardcoded in three places | `src/app/layout.tsx:22-27`, `src/app/_components/ui.tsx:98-104`, `src/app/login/page.tsx:38-43` |

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

`audit_log.payload` is **not** migrated. Historical rows keep
`{"from":"flygd","to":"green"}`.

### Rollback

The inverse migration lives in the PR description, not as a committed migration
file — committing it would apply it on the next deploy. If the release is rolled
back, the operator runs the three inverse `RENAME VALUE` statements by hand.
`docs/ops.md` carries the exact commands.

### Deploy procedure (added to `docs/ops.md`)

1. `fly scale count web=0 worker=0`
2. Set `DISCORD_ROLE_ID_MEMBER`, `_ASSOCIATE`, `_ALUMNI` — values copied
   verbatim from the existing three secrets
3. Deploy; the release command runs the migration
4. `fly scale count web=1 worker=1`
5. `fly secrets unset DISCORD_ROLE_ID_FLYGD DISCORD_ROLE_ID_BLUE DISCORD_ROLE_ID_GREEN`

Step 5 is last and separate: unsetting before the new image is confirmed healthy
leaves no bootable image to roll back to.

## Configuration

### Tier labels

```
TIER_LABEL_MEMBER     optional, default "Member"
TIER_LABEL_ASSOCIATE  optional, default "Associate"
TIER_LABEL_ALUMNI     optional, default "Alumni"
TIER_LABEL_PENDING    optional, default "Pending"
```

Surfaced as `config.tierLabels: Record<Tier, string>`. Defaults are the generic
names, so a fresh clone shows generic vocabulary; only the deployment's own
secrets make it read "FlyGD / Blue / Green".

### Branding

```
BRAND_NAME      optional, default "authGD"
BRAND_TAGLINE   optional, default "Auth"
BRAND_MARK_URL  optional, default "/brand/seal-sm.webp"
```

`layout.tsx` currently exports a static `metadata` object with
`"Zoo Landers · Flight Ops"` hardcoded; it becomes `generateMetadata()` reading
config. `SiteHeader` and `login/page.tsx` read the same values, with image alt
text derived from `BRAND_NAME` rather than a hardcoded corp string.

### Discord role IDs

`DISCORD_ROLE_ID_FLYGD/_BLUE/_GREEN` → `_MEMBER/_ASSOCIATE/_ALUMNI`.
`config.discord.roleIds` keys become `{member, associate, alumni}`. Still
required, still `z.string().min(1)` — a missing one still fails at boot.

### Label resolution

New `src/app/_components/labels.ts` exports `tierLabel(tier: string): string`.
It applies a three-entry legacy alias map (`flygd→member`, `blue→associate`,
`green→alumni`) before lookup, then falls back to the raw string for unknown
values. That single map covers all three readers: the audit summarizer, the
`Tier` badge's known-tier check (`ui.tsx:220`), and Discord role-name
resolution. It is the only place the old vocabulary appears in the published
source, and it carries a comment saying why.

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
references.

### Method

`flygd` is safe to sweep mechanically: 352 unambiguous occurrences. `blue` and
`green` are **not** — they collide with colour identifiers throughout
`globals.css` and elsewhere (221 `green` hits, mostly not tiers). Those two are
reviewed per-hit and filtered to tier context. `code-reviewer` runs on the diff
before the PR, asked specifically to look for a missed literal and for an
over-eager colour rename.

## Error handling

- An unknown tier value returns the raw string from `tierLabel()` and renders
  `.tier--unknown` (neutral grey) — existing behaviour at `ui.tsx:220-222`,
  deliberately preserved. A data problem stays visibly a data problem rather
  than borrowing another tier's colour.
- `TIER_LABEL_*` and `BRAND_*` are optional with defaults and cannot fail
  startup.
- `validateRoleConfig`'s "three distinct role ids" check is unchanged; only the
  key names move.

## Testing

- **Unit** (`npm test`, Postgres on :5433): `tier.test.ts`, `role-diff.test.ts`,
  `desired.test.ts`, `admin-accounts.test.ts`, `deprovision-flow.test.ts`,
  `audit-summarize.test.ts` and `config.test.ts` move to the new vocabulary.
  Two new tests: `tierLabel()` maps a legacy `flygd` payload value to the
  configured member label, and returns the raw string for an unknown value.
- **E2E** (`npm run test:e2e`): specs assert against the *default* generic
  labels, never the production ones, so the suite does not depend on secrets.
- **Migration**: verified on a scratch database — apply, confirm row values and
  that `pg_enum` order is preserved, then apply the inverse and confirm the
  round-trip.
- `npm test`, `npm run typecheck`, `npm run test:e2e` and `npm run format:check`
  output is quoted, not asserted. `format:check` runs per task, not only at the
  final gate.

## Delivery

Three PRs, each in its own linked worktree.

1. **Rename sweep + migration.** Ships with `TIER_LABEL_*` absent, so the UI
   reads the generic names. This is the deploy needing the maintenance window.
   Dispatch: `sync-engine-dev` takes `src/{core,services,jobs,db}` and
   `drizzle/`; `frontend-dev` takes `src/app/` and `e2e/`. They run in parallel
   against the shared rename map recorded in the implementation plan, so the two
   halves cannot drift.
2. **Labels and branding config.** `TIER_LABEL_*`, `BRAND_*`, `tierLabel()`,
   the legacy alias map, `generateMetadata()`. The deployment's secrets go in
   and the UI reads "FlyGD / Blue / Green" again. Should follow PR 1 closely.
3. **Open-source polish.** README rewritten with a generic tier table and a real
   setup section (EVE SSO app registration, Discord bot and three roles,
   Wanderer ACL key, `TOKEN_ENCRYPTION_KEY` generation, Postgres, `SYNC_MODE`);
   `.env.example`, which does not exist today; `docs/ops.md` generalised with
   placeholders plus the migration runbook; `PRODUCT.md` and `DESIGN.md`
   de-branded; `CONTRIBUTING.md`. Neutral placeholders replace the corp art in
   `public/`; `art/` and `docs/assets/hero.png` move out of the repo as source
   art rather than runtime assets.

## Out of scope

`src/lib/triff/`, the payouts subsystem itself, git-history rewriting,
multi-tenancy, making any integration optional, and configurable
corp-vs-alliance membership. Noted, not touched.

## Residual risks

1. If `db:generate` emits something other than `RENAME VALUE`, the actual SQL is
   reported before anything is committed (D3).
2. Between deploys 1 and 2 the admin UI shows "Member / Associate / Alumni".
   Deliberate; the reason PR 2 follows closely.
3. Old `?tier=flygd` bookmarks silently show all accounts rather than erroring
   (D7).
4. The corp's own art and vocabulary remain in git history until the deferred
   publication decision (D9).

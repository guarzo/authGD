# Account-merge follow-ups — design

Three independent changes that came out of PR #94 (`merge_*` error codes,
782bf9c). They share no code and can land in any order; they are specified
together because they were scoped together.

Base: `origin/main` at 782bf9c.

## 1. Discord unlink

### Problem

`src/services/discord-link.ts` exports only `linkDiscord`. The one
`discord.unlinked` audit row it writes (lines 69-77) covers the implicit
replacement case, when an account links a *different* Discord user. Nothing —
member-facing or admin-facing — can unlink and leave an account with none.

This is not only a missing button. `mergeBlocker` returns `"discord"` when the
source account holds a Discord link (`src/services/accounts.ts:302-304`), and
`merge_discord` is one of three codes in the "no cheap fix, ask an admin" group
of `ACCOUNT_ERRORS`. An unlink control moves it into the four-code "an admin
clears a field in seconds" group that PR #94 established.

### Service

One new export in `src/services/discord-link.ts`:

```ts
export async function unlinkDiscord(
  dbx: DbTx,
  actor: string,
  accountId: string,
  reason: "self" | "admin",
): Promise<{ ok: true } | { ok: false; error: "not_found" | "not_linked" }>;
```

Order of operations:

1. Lock the account row `FOR UPDATE` — the same first move as `linkDiscord`, so
   a concurrent link and unlink serialize rather than interleave. A missing row
   is `not_found`.
2. `DELETE FROM discord_link WHERE account_id = $1 RETURNING discord_user_id`.
   `discord_link.accountId` is a plain PK referencing `account.id` with no
   `onDelete` (`src/db/schema.ts:77-80`), so this is an explicit delete and
   nothing cascades. No rows deleted is `not_linked`.
3. `logAudit` with `action: "discord.unlinked"`, `target: <freed id>`,
   `details: { reason }` — the same payload shape the replacement path already
   writes (`{ reason: "replaced" }`), so summarize's existing `scalar("reason")`
   renderer covers the new rows with no change to item 3.
4. `enqueueSync(dbx, { kind: "discord-user", discordUserId })`.

Step 4 is what actually strips the member's roles, so it is mandatory rather
than tidiness. It is also sufficient: `src/jobs/discord-roles.ts:59-60` is
written for exactly this payload ("strip managed roles from a user who
unlinked"), and its first action is to check whether a `discord_link` row still
exists for that id and skip if so — which the transaction above has already
removed. The job handles the re-link race itself (`:104-110`), handing ownership
back to the account path with a fresh outbox row.

`{ kind: "account" }` is deliberately **not** enqueued. The replacement path
enqueues it only because it has a *new* Discord user to provision; an unlink has
none, and contacts/wanderer sync are unaffected by Discord state.

### Member surface — `/account`

`unlinkDiscordAction()` in `src/app/account/actions.ts`, behind the existing
`requireAccount()`. Both error cases are a silent no-op: the control renders
only when `view.discordLinked`, the same reasoning `unlinkAction` already
applies to its `last_character` case.

The Discord row (`src/app/account/page.tsx:252-268`) currently renders
`<Status>linked</Status>`; the unlink form sits beside it as a `ConfirmSubmit`,
since it revokes roles. That row is **outside** the page's existing
`ConfirmArmScope` (which covers only the character manifest, `:305-408`), and
`ConfirmSubmit` throws without a scope (`confirm-submit.tsx:113-116`) — so the
Discord row gets its own scope. A scope of one is correct here regardless: this
control should not share arm state with the manifest's.

### Admin surface — `/admin/accounts`

`unlinkDiscordAction(accountId)` in `src/app/admin/accounts/actions.ts` behind
`requireAdminAction()`. `not_found` routes through the existing
`redirectOnMutationError`, which already handles it for precisely this reason
(the merge can delete a targeted row between render and click); `not_linked` is
a silent no-op for a stale tab.

**No new `?error=` code**, so `redirectOnMutationError`'s two exhaustiveness
axes — the service error union and the `keyof ADMIN_ACCOUNTS_ERRORS` union —
are unchanged.

The control goes in the row's existing Discord cell (`page.tsx:420-426`), which
already renders `linked` / `none` from `AdminAccountRow.discordLinked`
(`account-view.ts:221`, populated `:311`) — so no query or row-model change.
`ConfirmArmScope` already wraps the whole `<tbody>` (`page.tsx:253-271`), so the
new `ConfirmSubmit` is inside a scope automatically. It follows the cell's
sibling controls in naming its row (`restName` / `confirmName` carry the
account identity, per the comment at `:450-456`).

### Copy

`merge_discord` moves from the "no cheap fix" group to the "an admin clears a
field" group:

> That character sits on an account with its own Discord link. An admin can
> remove it, then link it again.

The module doc's "the first four / the last three" sentence becomes five and
two. `src/lib/error-redirects.ts` gains **no import** — the change is copy and
prose only.

### Not fixed (noted)

`discord.unlinked` targets the freed Discord id, whose `discord_link` row no
longer exists, so `resolveAuditRows` renders it `targetKind: "unresolved"` — a
raw snowflake in the audit table. This is already true of the existing
replacement path; the new rows are consistent with it. Fixing it means a
target-resolution change outside this scope.

## 2. Pending-approval badge in the admin nav

### Problem

`src/app/admin/accounts/page.tsx:148-153` shows "N accounts awaiting approval"
only on that page. An admin on `/admin/audit` or `/admin/sync` gets no signal.

### Cost

Lower than it appears. `AdminNav` is rendered by `src/app/admin/layout.tsx`,
already an async server component awaiting `requireAdminPage()`. `SiteHeader`
renders plain `<a href>` — full navigations, no soft transitions — so the layout
re-runs on every admin page load and the badge cannot go stale. One indexed
`COUNT` (`countAccountsByTier`, deliberately tier-only and cheap by its own doc
at `account-view.ts:350-367`) in one place.

### Shape

`NavItem` gains:

```ts
badge?: { count: number; description: string };
```

`SiteHeader` renders it only when `count > 0`, as a **sibling `<span>` after
the `<a>`, not inside it**. This is the one non-obvious decision in item 2.
Putting the count inside the link makes its accessible name "Members 3 awaiting
approval" on one load and "Members" on the next — the same destination named
two ways, which is exactly what the `ITEMS` comment in `admin-nav.tsx:6-12`
invokes WCAG 3.2.4 Consistent Identification to prevent. As a sibling, the
link's name stays exactly "Members" and the count still lands in reading order.
`description` travels with the count rather than being hardcoded in
`SiteHeader`, which is shared with the member nav.

Existing e2e would **not** have caught the inside-the-link version:
`admin.spec.ts:645`'s `.toBe("Members")` asserts the Scroller region's
`aria-label`, not the nav link, and `error-boundary.spec.ts:172` matches the
link name as a substring. Worth an assertion.

`AdminNav` keeps its static `ITEMS` and takes `pendingCount?: number`, applying
the badge to the Members entry at render. `admin/layout.tsx` fetches the count
after `requireAdminPage()`. The member nav passes no badge and is unaffected.

One scoped rule in `globals.css` for the badge; no shared tokens touched, since
two design-sweep PRs (#91, #93) just landed there.

The accounts-page banner stays. It links to `?tier=pending` and does a job the
badge does not; two signals on one page say different things.

## 3. Audit summarizer renderers

`PARTS` (`src/app/admin/audit/summarize.ts:131-153`) maps an action to a curated
line; anything absent falls through to key=value capped at `FALLBACK_KEYS = 3`.

Every `action:` passed to `logAudit` across `src/services/` and `src/jobs/` was
cross-referenced. Three earn a renderer:

| Action | Payload | Why |
| --- | --- | --- |
| `tier.approved` (`admin-accounts.ts:140`) | `{to, locked}` | Fallback reads `to=green, locked=false`. `transition("from","to")` already renders `→ green` when `from` is absent, and `flag("locked","locked")` exists — no new machinery, and it stops drifting from `tier.changed`. |
| `account.merged` (`accounts.ts:365`) | `{sourceAccountId, characterId}` | Fallback dumps a raw uuid and a bare number with no labels. |
| `payout.item_repriced` (`payout-loot.ts:213`) | `{itemId, poolId, name, unitPrice}` | Four keys against the cap of 3 — the **only** action in the repo the fallback truncates, and what it drops is `unitPrice`, the reason the row exists. |

Everything else stays on the fallback, deliberately:

- **No `details` at all**, so they render `—` and need nothing:
  `character.linked`, `character.reauthed`, `discord.linked`, `admin.demoted`,
  `character.affiliation_invalid`, `wanderer.added`, `wanderer.unblocked`,
  `sync.requested`, `sync.recheck_requested`, `payout.created`,
  `payout.finalized`, `payout.unlocked`.
- **One to three self-describing keys**, under the cap and untruncated:
  `payout.corp_share_changed`, `payout.roster_set`, `payout.participant_added`,
  `payout.participant_updated`, `payout.participant_removed`, `payout.paid`,
  `payout.pool_added`, `payout.pool_deleted`.
- `admin.promoted` stays absent, per the module doc: the old declaration named a
  scope and note no writer produces.

All three renderers are built from the existing `part` / `transition` / `flag` /
`labelled` combinators and read only from `d`. `summarize.ts` stays a pure
function of its arguments, imports nothing new, and keeps `roleNames` as its
only injected dependency.

## Testing

- `tests/discord-link.test.ts` — unlink deletes the row, writes
  `discord.unlinked` with `reason`, enqueues the `discord-user` deprovision and
  **not** `{kind:"account"}`, and returns `not_found` / `not_linked`.
- `tests/audit-summarize.test.ts` — the three renderers, plus a table-driven
  case asserting the twelve no-details actions render `—`. That records the
  cross-reference as behavior rather than as a claim in a PR description.
- Nav badge — assert the Members link's accessible name is exactly `Members`
  with a badge present, which is the invariant the sibling-span decision exists
  to hold.
- `/account` and `/admin/accounts` both change, so `npm run test:e2e` runs.

Full gate, output quoted: `npm test`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run test:e2e`.

## Out of scope

- Audit target resolution for freed Discord ids (see item 1).
- Any change to `admin.promoted`'s absence from `PARTS`.
- Any change to the accounts-page approval banner.
- Renderers for actions whose fallback is already accurate.

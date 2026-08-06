# Prompt for the second-pass session

Copy everything below the line into a fresh Claude Code session started in the
authGD repo.

---

Work the deferred backlog from the Aug-5 design sweep. The list is
`docs/design-sweep/SECOND-PASS.md` — read it first; every item says who deferred
it and why, so treat it as a record of decisions already made rather than as
suggestions to re-litigate.

That file lives on branch `worktree-design-sweep-2026-08-05` (PR #128), not on
`main`. If #128 has merged by the time you start, it will be on `main` — check
before you go looking for it. Start a linked worktree before your first write,
per the global working agreement, and land everything through a PR; never merge
to local `main`.

## What to do, in order

**1. `discord-roles` drops the audit record of role changes that succeeded.**
Item 1 in the doc, `src/jobs/discord-roles.ts:193-212` and `:84-114`. This is the
one that matters and the only one I'd call urgent-ish: a partial failure applies
some role changes and then skips the `logAudit` entirely, so `audit_log` says
nothing happened for changes that did happen. It bears directly on the project
rule that every state change gets an audit write.

The doc sketches the fix (track the applied subset, write the audit row from the
catch as well as the success path) but do not take that on faith — the dedupe in
`logAuditIfChanged` interacts with it, and the doc says so. Read
`src/services/audit.ts` and work out what the new `details` payload does to the
suppression before you write anything.

This is `src/jobs/` work: dispatch `sync-engine-dev` rather than editing in the
main thread, and run `code-reviewer` before declaring it done. Both are standing
requests in this repo.

**2. The cheap type fixes.** Section 4's table. `accountsConfirmation`'s
`done: string` (`admin/accounts/view.ts:157`) is flagged in the doc itself as the
cheapest real fix on the list, and `detailAccountNames` (`services/audit.ts:87`)
is pure cleanup with a sibling argument already showing the right shape. Do these
as one small commit each; they need no product decision.

**3. The two add-forms that keep their values after a successful add**
(`payouts/[id]/flat-pool-form.tsx`, `add-participant-form.tsx`). An operator can
press "Add flat pool" twice and get two pools. When the doc was written this was
open on *how* to fix it; it isn't anymore — `payouts/[id]/appraise-form.tsx` now
does exactly this, with a controlled value and a `setPaste("")` in a success
effect. Copy that shape. Its docblock explains why `defaultValue` cannot clear a
dirty field, which is the trap here.

**4. Item 2, the nav's membership between sections,** needs a product decision
from the user about which destinations belong at which membership tier. Ask;
don't guess. If they don't want to decide now, leave it and say so.

**5. Everything else in section 4 and section 5** — read, judge, and either do it
or write down why not. Section 5's `audit_log` index needs a generated migration
(`npm run db:generate`, never hand-written), which means it needs the user's
sign-off first: migrations are on this repo's stop-and-ask list.

## Constraints that are not optional here

- **Stop and ask** before anything that touches persisted data, an applied
  migration, `TOKEN_ENCRYPTION_KEY`, or the OAuth state flow.
- **Cite test output.** Do not claim `npm test`, `npm run typecheck`,
  `npm run test:e2e`, or `npm run format:check` passed without quoting the run.
  `format:check` is cheap and reading a diff cannot substitute for it — run it
  per task, not only at the end. CI bundles typecheck, lint and format:check into
  one job, so all three have to be clean before you push.
- **Stay in scope.** These items are specific. Note adjacent improvements in the
  doc; don't make them.
- Both test suites are worktree-safe and pick their own database — just run
  them, no `TEST_DATABASE_URL` to set.
- There is no jsdom in this project. Pure logic goes in `tests/`, anything about
  browser behaviour goes in `e2e/` with Playwright.

## When you finish

Update `docs/design-sweep/SECOND-PASS.md` in the same PR: mark what you resolved,
and for anything you deliberately left, say who decided and why, in the same form
the existing entries use. An item nobody worked is still open — the whole point
of that file is that the next sweep recognises it instead of rediscovering it.

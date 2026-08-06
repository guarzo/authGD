# Second pass — carried forward from the Aug-5 sweep

Everything the Aug-5 sweep found and deliberately did not fix. An item is here
because it was deferred on purpose, not because it was missed, and each one says
who deferred it and why — so the next sweep recognises it as a known open item
rather than rediscovering it as a new finding.

Two sources feed this list: the sweep's own backlog (`SYNTHESIS.md`), and the
`my:polish-core` pass run over the resulting diff, which reviewed the sweep's
own work and found things the sweep introduced or walked past.

---

## Where this work lives now

The sweep's branch is `worktree-design-sweep-2026-08-05`, open as PR #128, and it
has merged `origin/main` twice since (through #129). Everything below is
committed. Items marked **(resolved by the merge)** were overtaken by main and
need no work; they are left in place so a reader diffing against `SYNTHESIS.md`
can see what happened to them rather than assuming they were dropped.

---

## 1. `discord-roles` drops the audit record of role changes that succeeded

**Source:** `my:polish-core` / `silent-failure-hunter`, verified by reading the
code. **Severity: Warning, HIGH confidence.** This is the most consequential
open item on the list.

`src/jobs/discord-roles.ts:193-212`. The `logAudit(discord.role_changed)` call
sits *inside* the `try`, after both the add loop and the remove loop. A member
needing `+alumni −member` gets the add applied; if the remove then throws a
non-transient `DiscordApiError`, control jumps to the catch at :213 and both
`counts.changed++` (:203) and the audit write (:205) are skipped. The role was
added. `audit_log` says nothing happened.

It compounds with the dedupe added in this same change. The catch's
`logAuditIfChanged` (:230) writes `details` that are byte-identical on the next
hourly tick, so `src/services/audit.ts` suppresses the failure row too — a tick
that really changed roles can leave no audit record at all. `sync_run.errorSummary`
still carries the failure text; the record of the change that landed is what
vanishes.

Same shape on the deprovision path at `:84-114`: three roles to strip, two
removals succeed, the third fails permanently, and the `logAudit` at :108 is
never reached.

This bears directly on the project rule that every state change gets an audit
write. **Deferred because:** it is a behaviour change in `src/jobs/`, outside
what the sweep's single Phase 4 gate authorized. Decided 2026-08-05 by the user,
explicitly, to carry rather than fix in-pass.

**Shape of the fix:** log what actually succeeded before rethrowing — track the
applied subset as the loops go, and write `discord.role_changed` for it from the
catch as well as the success path. Note that this changes what the dedupe sees,
so re-check the `logAuditIfChanged` interaction rather than assuming it holds.

## 2. The nav's membership changes between sections

**Source:** sweep backlog item 21. **Deferred because:** it needs a product
decision about which destinations belong in the nav at which membership tier,
which is the user's call and not derivable from the code. Decided 2026-08-05 by
the user: "leave it, defer to a second pass."

## 3. Remaining sweep backlog items

Carried unchanged from `SYNTHESIS.md`'s backlog: items **6, 10, 20**, plus
everything under its "Deferred as cosmetic" heading. Item **9** (Discord
role-sync audit rows) was authorized at the gate and is done; it is listed here
only so a reader comparing against `SYNTHESIS.md`'s own "left for a second pass"
line does not double-count it.

## 4. Open findings from the polish pass

Reviewed and left deliberately. None were fixed, because the polish rules hold
bugs, type design, and over-engineering to `report` rather than auto-fix.

| Finding | Where | Why deferred |
|---|---|---|
| `workerHeartbeat` returns `null` for every error, the same value as "worker never ran" — a grant problem renders "no heartbeat recorded" on a live worker | `src/services/health.ts:70-74` | Behaviour change; also a regression vs. `newestSyncRun`, which had no catch and let DB faults reach the error boundary |
| Both add-forms keep their values after a successful add, so a flat pool can be created twice | `payouts/[id]/flat-pool-form.tsx:33`, `add-participant-form.tsx:41` | Pre-existing behaviour, not introduced here; the false comment was fixed, the behaviour was not. `AppraiseForm` now shows the pattern to copy — a controlled value plus `setPaste("")` in a success effect — so this is no longer an open design question, only unwritten |
| `ConfirmingForm` without a `ConfirmGroup` ancestor silently discards its confirmation | `_components/confirm-group.tsx:122` | All four current call sites are correct; nothing enforces it for the fifth |
| `accountsConfirmation` takes `done: string` while `AdminAccountsDoneCode` is exported ten lines above; a typo'd code typechecks and returns `""` | `admin/accounts/view.ts:157` | Cheapest real fix on this list; `doneUrl` in the same file already types it correctly |
| `ActionOutcome = {text: string} \| null` admits `{text: ""}`, which bumps `seq` and focuses an unnamed `div` | `_components/confirm-group.tsx:104` | Both producers have documented `""` paths |
| `detailAccountNames` is a `Record` but its only consumer takes `ReadonlyMap`, forcing a per-row `new Map(...)` | `services/audit.ts:87`, `admin/audit/page.tsx:646` | Sibling argument `roleNames` is a Map end to end; pure cleanup |
| ~~`InlineEditField`'s unused props~~ **(resolved by the merge)** | — | The component was deleted. Main's #124 shipped its own `InlineEdit`, this branch folded its value preservation into that one, and `inline-edit-field.tsx` is gone |
| `unlinkDiscord`'s `not_found` shares the silent same-page reload documented only for the no-op `not_linked` | `account/actions.ts:108` | Lower confidence; reachable only after an account merge |
| `CONTACT_SYNC_RESULTS`' partition comment enumerates seven of nine, omitting `sync_failed` | `core/contact-result.ts:53-56` | May be deliberate, but neither this comment nor `services/accounts.ts:139-144` says so |
| pg-boss's `maintained_on` is a gated single-row update, so the "three missed ticks" margin is nearer 1.5 | `core/health.ts:28` | The liveness conclusion holds; only the margin arithmetic is off |

## 5. Also known

The `audit_log` index on `(action, target, id desc)` that `logAuditIfChanged`'s
docblock asks for. It needs a generated migration, which the sweep's gate did not
cover. Not urgent — the lookup runs only on the exceptional failure path — but it
degrades monotonically, since `audit_log` is append-only.

CodeRabbit's review of PR #128 raised it independently (`src/services/audit.ts:73`),
which is corroboration rather than a new finding: two reviewers, one unresolved
item, still blocked on the same migration sign-off.

The same review's `admin/accounts/view.ts:131` note — derive one of
`AdminAccountsDoneCode` / `DONE_CODES` from the other — is the same defect as
section 4's `accountsConfirmation` row, reached from the other end. Fix them
together.

Everything else CodeRabbit raised on #128 was resolved in the branch: the flat-pool
action's regex admitted a negative total (it reached `addFlatPool`, threw, and cost
the operator the note and paste the state shape exists to preserve), the pgboss
version-row fixtures in `tests/health-service.test.ts` and `e2e/sync.spec.ts` leaked
past their files, `/admin/accounts` named its search field and its submit button both
"Find", and one zoom test measured `.scroller` where it meant `.scroller--tall`.

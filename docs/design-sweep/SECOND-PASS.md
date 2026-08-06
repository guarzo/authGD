# Second pass — carried forward from the Aug-5 sweep

Everything the Aug-5 sweep found and deliberately did not fix. An item is here
because it was deferred on purpose, not because it was missed, and each one says
who deferred it and why — so the next sweep recognises it as a known open item
rather than rediscovering it as a new finding.

> **Status as of 2026-08-06.** A follow-up pass (branch
> `worktree-design-sweep-backlog`) worked this list rather than re-running the
> sweep — the Aug-5 review was still current, so re-reviewing would have
> re-derived it and risked re-flagging entries in
> `docs/settled-design-decisions.md`. **Closed:** section 1 (discord-roles audit
> gap), section 5's `audit_log` index, and three of section 4's rows — the
> `workerHeartbeat` null conflation, both add-forms' duplicate-submit hazard,
> and `accountsConfirmation`'s loose signature (merged with CodeRabbit's
> `DONE_CODES` note, which was the same defect from the other end). Each is
> marked inline below. **Still open:** section 2 (nav membership, needs a
> product decision), section 3 (sweep backlog items 6, 10, 20 and the cosmetics),
> and the remaining section 4 rows.

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

## 1. `discord-roles` drops the audit record of role changes that succeeded — **CLOSED 2026-08-06**

> Fixed on `worktree-design-sweep-backlog`. Both paths now accumulate what
> actually landed and write `discord.role_changed` with `partial: true` from the
> catch. Two things worth knowing before touching it again: the partial write
> sits **above** the permanence check on both paths deliberately — a transient
> failure rethrows for pg-boss to retry, and the retry re-derives its work from
> current state, so it only ever audits the remainder and the first batch's
> record would be lost for good. And the strip path guards its audit write in
> try/catch while the main sweep path deliberately does not; the comment at the
> guard explains why, and the asymmetry is intentional. Covered by three tests in
> `tests/discord-roles-job.test.ts` (permanent mid-sweep, permanent mid-strip,
> transient mid-strip).

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
| ~~`workerHeartbeat` returns `null` for every error~~ **CLOSED 2026-08-06** | `src/services/health.ts` | Now a tagged union `{status:"ok"\|"never"\|"error"}`. `42P01` and an empty table still map to `"never"`; anything else is `"error"` and `/admin/sync` says the check failed rather than claiming nothing ran. The catch was kept, not removed — it still protects the page from a DB fault on an auxiliary read |
| ~~Both add-forms keep their values after a successful add~~ **CLOSED 2026-08-06** | `payouts/[id]/flat-pool-form.tsx`, `add-participant-form.tsx` | Converted to controlled state per `AppraiseForm`'s pattern, cleared in an effect only on `state.ok`. Note the rejection path needed no restore code at all: these forms settle through `formAction`, so nothing ever clears what was typed — the missing half was always the reset, never the restore |
| `ConfirmingForm` without a `ConfirmGroup` ancestor silently discards its confirmation | `_components/confirm-group.tsx:122` | All four current call sites are correct; nothing enforces it for the fifth |
| ~~`accountsConfirmation` takes `done: string`~~ **CLOSED 2026-08-06** | `admin/accounts/view.ts` | One signature, `AdminAccountsDoneCode \| undefined`; `isDoneCode` exported so `page.tsx` narrows the query string at the boundary. **An overload pair was tried first and reverted as inert** — TypeScript resolves overloads in declaration order, so a permissive second signature always catches what the narrow one rejects, and a typo'd literal still compiled. Verified this time by compiling a probe against the real module: `"teir"` now raises TS2345. Fixed together with section 5's `DONE_CODES` note, being the same defect from the other end |
| `ActionOutcome = {text: string} \| null` admits `{text: ""}`, which bumps `seq` and focuses an unnamed `div` | `_components/confirm-group.tsx:104` | Both producers have documented `""` paths |
| `detailAccountNames` is a `Record` but its only consumer takes `ReadonlyMap`, forcing a per-row `new Map(...)` | `services/audit.ts:87`, `admin/audit/page.tsx:646` | Sibling argument `roleNames` is a Map end to end; pure cleanup |
| ~~`InlineEditField`'s unused props~~ **(resolved by the merge)** | — | The component was deleted. Main's #124 shipped its own `InlineEdit`, this branch folded its value preservation into that one, and `inline-edit-field.tsx` is gone |
| `unlinkDiscord`'s `not_found` shares the silent same-page reload documented only for the no-op `not_linked` | `account/actions.ts:108` | Lower confidence; reachable only after an account merge |
| `CONTACT_SYNC_RESULTS`' partition comment enumerates seven of nine, omitting `sync_failed` | `core/contact-result.ts:53-56` | May be deliberate, but neither this comment nor `services/accounts.ts:139-144` says so |
| pg-boss's `maintained_on` is a gated single-row update, so the "three missed ticks" margin is nearer 1.5 | `core/health.ts:28` | The liveness conclusion holds; only the margin arithmetic is off |

## 4b. Found while closing the above (2026-08-06) — open, deliberately out of scope

Three things the follow-up pass surfaced and chose not to fix, so the branch
would not keep growing. None is urgent; all are recorded so the next sweep
recognises them.

| Finding | Where | Why deferred |
|---|---|---|
| `/admin/audit`'s action filter has no index that serves it | `services/audit.ts`'s `queryAuditLog` | It matches `action` with a LIKE prefix, and under this deployment's `en_US.utf8` collation a plain btree cannot answer `LIKE 'x%'` — EXPLAIN puts it in `Filter`, not `Index Cond`. `audit_log_action_target_id_idx` does **not** cover it, despite looking like it should; the index's own comment now says so. A `text_pattern_ops` index would fix it and is a separate migration and a separate decision |
| The `"error"` variant's `message` has no reader | `services/health.ts` | Logged by `console.error` already. Harmless today, but it is a raw Postgres string (`"permission denied for schema pgboss"`) sitting in a server-component return value — if anyone later renders it to answer "why did the check fail", an unfiltered DB error reaches the page |

(An earlier draft of this table also listed `workerHeartbeat` tagging an
Invalid Date as `"ok"`. That was closed in the same pass, not deferred: an
unparseable `maintained_on` now returns `"error"` rather than `"never"`,
on the grounds that a non-null raw value means pg-boss wrote *something* —
the evidence exists and simply isn't parseable, which is the check failing
rather than an absence of evidence. Covered by an e2e test using
`timestamptz`'s `'infinity'`.)

## 5. Also known

~~The `audit_log` index on `(action, target, id desc)`~~ **CLOSED 2026-08-06.**
Added via `npm run db:generate` (never hand-written) as
`drizzle/0009_useful_frightful_four.sql`; no already-applied migration was
touched. `logAuditIfChanged`'s docblock was updated too, since it described the
index as missing and that claim is now false. This also closes CodeRabbit's
independent report of the same item on PR #128 (`src/services/audit.ts:73`) —
one item, two reviewers, one migration.

~~The same review's `admin/accounts/view.ts:131` note — derive one of
`AdminAccountsDoneCode` / `DONE_CODES` from the other~~ **CLOSED 2026-08-06**,
together with section 4's `accountsConfirmation` row as that entry advised. On
inspection the two types were *already* derived from each other
(`(typeof DONE_CODES)[number]`), and `isDoneCode` already existed as the runtime
fail-safe; the real remaining gap was the exported function accepting a bare
`string` at call sites that know their code at authorship time. Closed by
narrowing the single signature to `AdminAccountsDoneCode | undefined` and
moving the runtime guard out to `page.tsx`'s query-string boundary — not by
overloads, which were tried first and are inert for this (see the section 4
row above).

Everything else CodeRabbit raised on #128 was resolved in the branch: the flat-pool
action's regex admitted a negative total (it reached `addFlatPool`, threw, and cost
the operator the note and paste the state shape exists to preserve), the pgboss
version-row fixtures in `tests/health-service.test.ts` and `e2e/sync.spec.ts` leaked
past their files, `/admin/accounts` named its search field and its submit button both
"Find", and one zoom test measured `.scroller` where it meant `.scroller--tall`.

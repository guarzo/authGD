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
>
> **Update, later on 2026-08-06** (branch `worktree-audit-action-index`): both
> index-related rows in section 4b are now settled, by measurement rather than
> by argument. The action filter got its `text_pattern_ops` index; the
> migration-runner question was answered **no, not yet**, with a trigger
> condition recorded in `docs/ops.md`. Section 4c records what the measurement
> checked. Section 4b's third row (`health.ts`'s unread `"error"` message)
> remains open.

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

## 2. The nav's membership changes between sections — **RESOLVED 2026-08-06**

**Source:** sweep backlog item 21. **Deferred because:** it needs a product
decision about which destinations belong in the nav at which membership tier,
which is the user's call and not derivable from the code. Decided 2026-08-05 by
the user: "leave it, defer to a second pass."

**The product decision, made 2026-08-06.** The nav is keyed to the viewer, not
the section: it offers every destination the viewer is *provably authorized* to
reach — `Your account` always, `Payouts` iff `canReadPayouts`, and
`Members`/`Audit log`/`Sync` iff `isAdmin` — in one fixed order, broadest access
first. The three surfaces that cannot read the session (`error.tsx` and both
`not-found.tsx` boundaries) run the same rule on weaker evidence: the strongest
membership the path alone proves. Each of those three therefore renders exactly
the set it rendered before; what changed is that they are now the rule under a
weaker premise rather than three hand-maintained exceptions to it.

The decisive fact, and the reason a plain "show everything and let the target
gate it" rule was rejected: `isAdmin` and `tier` are orthogonal columns, and the
default tier is `alumni`. An admin is not necessarily a payouts reader, so an
unconditional `Payouts` in the admin bar would eject a real and ordinary
account — which is the thing `not-found.tsx`'s docblock already forbids.

The ten hand-copied definitions across eight components collapsed to one item
table in `src/app/_components/nav-items.ts`. `error.tsx`'s standing request that
a future editor keep its `ADMIN_ITEMS` in step with `admin-nav.tsx`'s `ITEMS` by
hand is gone: each label string now exists once, so the WCAG 3.2.4 divergence it
was guarding against is structurally impossible rather than merely watched for.

Recorded in `DESIGN.md` ("Nav membership is keyed to the viewer"), `PRODUCT.md`
(Users), and `docs/settled-design-decisions.md`.

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

## 4b. Found while closing the above (2026-08-06) — all three now settled

Three things the follow-up pass surfaced and chose not to fix, so the branch
would not keep growing. All three have since resolved, in different ways: the
audit-filter row by **adding** the index, after measuring; the index-build row
by **deciding** against the machinery and recording the triggers in
`docs/ops.md`; and the heartbeat-`message` row **without a code change**, the
concern it records having turned out to be already written into the type's own
docblock.

| Finding | Where | Why deferred |
|---|---|---|
| ~~`/admin/audit`'s action filter has no index that serves it~~ **CLOSED 2026-08-06** | `services/audit.ts`'s `queryAuditLog` | Added `audit_log_action_pattern_idx` on `action text_pattern_ops`. Measured first, and the measurement moved the argument: the *slow seq scan this row assumed* is not what most filters do. At the page's real query shape — `ORDER BY id DESC LIMIT 100`, since `/admin/audit` passes no limit and `queryAuditLog` falls back to `AUDIT_PAGE_SIZE` — any prefix with recent matches is answered by a backward scan of `audit_log_pkey` in **under 0.2 ms** and never touches the new index. The cost is entirely in the tail — a prefix with few or **no** recent rows falls back to a full seq scan: **2.3 ms at 40k rows, 26 ms at 500k, 52 ms at 1M, 80 ms at 2M**, growing linearly, and `audit_log` is never purged (`src/jobs/purge.ts` covers sessions, OAuth transactions and outbox only). With the index those same queries are a flat **0.08–0.09 ms**. The case that decided it: the filter is a **free-text box**, so a typo (`teir.`, `discrod.`) is a zero-match prefix, and zero-match is the *worst* case — a full scan for a page that returns nothing. See section 4c for what was verified and what was rejected |
| ~~`audit_log` index migrations block writes while they build~~ **DECIDED 2026-08-06 — no runner, trigger recorded** | `drizzle/`, `fly.toml`, now `docs/ops.md` | Decision: keep the transactional build; do **not** add a non-transactional runner. The mechanics as stated were right but understated in one respect — drizzle's migrator wraps the **entire pending batch** in a single transaction, not one per migration (`pg-core/dialect.cjs`: `session.transaction` sits outside the `for await` loop), and `__drizzle_migrations` is read as a high-water mark, not a set. That makes a custom runner *more* dangerous than the row assumed: decoupling the DDL from the bookkeeping insert lets a mid-batch failure commit statements the high-water mark still sits behind, so the retry re-runs them and wedges the deploy — and a failed `CONCURRENTLY` build is precisely the case that triggers it. Against that, the avoided cost is a sub-second `SHARE` lock during one index build, on the only table whose size makes the lock worth discussing at all. Recorded with the revisit triggers (~5M rows, a >5s timed build, multi-tenant, or a third such index) and a watched out-of-band procedure in `docs/ops.md` → *Migrations run in one transaction — deliberately*. Raised by CodeRabbit on #163, answered there, and **withdrawn by the reviewer**. **Since measured**, closing the estimate that decision rested on: the build is **33 ms at ~40k rows**, 367 ms at 500k, 816 ms at 1M and 1.58 s at 2M, so the ~5M / >5 s triggers are mutually consistent and neither is close. Note the decision is self-limiting in one direction — adding the action index *now*, while the build is 33 ms, is part of what keeps the runner unnecessary; deferring it lands the build in the regime that would have justified the machinery |
| ~~The `"error"` variant's `message` has no reader~~ **CLOSED 2026-08-06 — no code change** | `services/health.ts` | Re-read at e9ff584: the risk this row describes is *already* written into `WorkerHeartbeat`'s own docblock (`services/health.ts:46-51`), which names the field's only reader today (`console.error` and a log aggregator), says in as many words that it is not vetted for a browser, and assigns the "is an unfiltered DB error string safe to show" decision to whichever future caller renders it. That is the whole of what this row was asking for, so restating it here would be duplication, not work. Not rendered on `/admin/sync` (nothing there reads `.message`, verified by grep): the page is admin-gated, so severity is low, but a raw driver string can carry query text and parameter values, and this project already logs `.message`-only in the OAuth callbacks for exactly that reason. Not dropped either: `message` is the only structured carrier of *why*, `console.error` is a lossy one-way channel, and a non-browser caller (a health JSON endpoint, a future alert) is the plausible reader. Kept, documented, decision delegated |

(An earlier draft of this table also listed `workerHeartbeat` tagging an
Invalid Date as `"ok"`. That was closed in the same pass, not deferred: an
unparseable `maintained_on` now returns `"error"` rather than `"never"`,
on the grounds that a non-null raw value means pg-boss wrote *something* —
the evidence exists and simply isn't parseable, which is the check failing
rather than an absence of evidence. Covered by an e2e test using
`timestamptz`'s `'infinity'`.)

## 4c. What the index measurement checked (2026-08-06)

Recorded because two of these would have silently defeated the index, and the
next person to touch `queryAuditLog` needs to know they were tested rather than
assumed. Postgres 16.11, `en_US.utf8`, `audit_log` seeded to a production-shaped
action distribution, queried at the page's real shape (`ORDER BY id DESC LIMIT
100`). Every figure here and in the 4b rows comes from that one sweep.

- **The escaped-underscore path works.** `queryAuditLog` escapes `%`, `_` and
  `\` before building the pattern, and half the action names contain `_` (25 of
  the 49 action literals in `src/` — `discord.role_changed`,
  `payout.pool_added`). Postgres still extracts a prefix from
  `LIKE 'payout.pool\_addex%'` — `Index Cond: ((action ~>=~
  'payout.pool_addex') AND (action ~<~ 'payout.pool_addey'))`. The escaping does
  not cost the index.
- **Bind parameters do not defeat it.** A prefix `LIKE` against a *parameter*
  cannot be turned into an index range under a generic plan, which would have
  made this index useless through Drizzle. Verified with a named `PREPARE`
  executed seven times — past the five-execution custom-plan threshold, every
  execution still planned `Index Cond`, because the generic plan costs more and
  Postgres keeps re-planning custom.
- **A composite was measured and rejected.** `(action text_pattern_ops, id DESC)`
  gave no measurable gain over the single column and could not help the
  scattered-rare case either. It costs **82 MB vs 14 MB** at 2M rows (and 2.24 s
  to build against 1.58 s): `id` is distinct per row, which defeats the btree
  deduplication that makes the single-column index small (a handful of distinct
  `action` values collapse to **304 kB at 40k rows**).
- **The new index does not disturb the fast plans.** Common prefixes still
  choose the backward `audit_log_pkey` scan with it present — 0.152 ms with the
  index at 500k against 0.155 ms without — so no query got slower.
- **`audit_log_action_target_id_idx` is still needed** and was not replaced. It
  serves `logAuditIfChanged`'s equality lookup on `(action, target)`; the new
  index serves prefix ranges. Folding them into one would mean dropping and
  recreating an index from an applied migration to change its operator class —
  more risk than the 304 kB it would save.

## 5. Also known

~~The `audit_log` index on `(action, target, id desc)`~~ **CLOSED 2026-08-06.**
Added via `npm run db:generate` (never hand-written) as
`drizzle/0010_even_jetstream.sql`; no already-applied migration was
touched. (An earlier draft of this line said `0009_useful_frightful_four.sql`,
copying the name CodeRabbit's review used. That file does not exist — #162 took
`0009`, so this migration was renumbered to `0010` before merge.)
`logAuditIfChanged`'s docblock was updated too, since it described the
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

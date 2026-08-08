# Owner walkthrough — 2026-08-07

A page-by-page walkthrough of every rendered surface, conducted with the
project owner reading production screenshots alongside a reviewer reading the
source. Nine surfaces, one session.

**Why this document exists separately from `design-sweep/`.** That sweep was
eighteen AI reviewers reading code. This was the person who runs the tool
saying what bothers him when he uses it. Where the two disagree, this one wins:
a sweep can tell you a control is inconsistent, and only the owner can tell you
that `MAIN` and `UNLINK` are almost never pressed — which is the fact that
turns three separate `/account` findings into one fix.

## Read these first, in this order

1. **`docs/settled-design-decisions.md`** — the "do not re-open" index. Several
   findings below deliberately overturn entries in it. Those are marked
   **OVERTURNS**, and closing them means editing that file too, or the next
   sweep reverts the work.
2. **`docs/design-sweep/SECOND-PASS.md`** — the authoritative open set from the
   Aug-5 sweep. Two items below are already tracked there; they are cross
   referenced rather than restated.
3. `PRODUCT.md` and `DESIGN.md` — the design record.

## Relationship to the existing backlog

| This walkthrough found | Status in the Aug-5 sweep |
|---|---|
| `/payouts` cannot answer "was I paid?" | `SYNTHESIS.md` item **7**. Open, and **absent from both** the worked chain and the "left for a second pass" list — it fell through. Re-confirmed against the current tree: `payouts/page.tsx` renders Name / Date / Status / Total / Paid, with no viewer-relative column. |
| Finalize explains its consequence only after you commit to it | `SYNTHESIS.md` item **6**, explicitly carried forward as open in `SECOND-PASS.md` section 3. |
| Everything else below | New. |

`SYNTHESIS.md` item 15 (`/admin/accounts` has no way to find a person) is
**done** — a search field shipped in the worked chain. Do not re-file it.

---

## Rulings taken during the walkthrough

These are decisions, not findings. Session 0 writes them down; every later
session depends on them.

### R1. A disclosure drawer is not "in-row" — **OVERTURNS** `settled-design-decisions.md:82`

`DESIGN.md:227-232` rations hit targets to two grades: 36px standalone, 28px
in-row. `Disclosure as="row"` renders a literal second `<tr>`, so the
`/admin/accounts` drawer inherited the 28px grade by structural accident.

The 28px grade exists for *density on rows that each carry a control set*. A
one-at-a-time full-width panel has no density problem. The drawer takes 36px.

This is precedent, not invention: `payouts/[id]/notes-form.tsx:90-95` already
reasons exactly this way for a panel field, and takes the 36px grade on those
grounds.

Closing this also retires the 22-line defence at
`_components/note-form.tsx:55-76`, which names the ruling as "a call for a
human, not a sweep." The human has now called it.

### R2. Rare destructive controls do not hold permanent width in a scanning table

PRODUCT.md principle 3 is that scanning is the primary act. `MAIN` and `UNLINK`
on `/account` (40 permanent controls across 20 rows) and `UNLINK` on
`/admin/accounts` are rare *and* destructive *and* occupy the widest columns.
They move behind per-row disclosure.

Note the constraint from #108/#111/#112, recorded at
`settled-design-decisions.md` and `_components/confirm-submit.tsx:89-98`:
reveal-on-arm inside a `<td>` widens the cell, moves the armed button out from
under the pointer, and disarms it. That is a reason these controls cannot be
progressively disclosed **where they currently sit**. It is an argument for
moving them, not for keeping them.

### R3. `/payouts` is a corp-wide ledger; `/account` is where a member sees their own money

Settled with the owner. The split is coherent and matches the transparency
argument already written at `payouts/page.tsx:77-83`.

The page currently contradicts itself about it: `page__stamp` says **"Flight
log"** one line above an `<h1>` that says **"Payouts"**, and the nav item says
"Payouts", which a member reads as *my* payouts. Resolve the naming collision.

This does **not** cancel item 7 above. A corp-wide ledger can still mark the
viewer's own rows, and should.

### R4. Information may not live only in the assistive-tech channel

Two instances found, and they are the inverse of the usual a11y defect:

- `payouts/[id]/notes-form.tsx:102` — the save confirmation is real, correct,
  and `visually-hidden`. Screen readers hear "notes saved". Nobody else gets
  anything, which is why it was reported as a missing confirmation.
- `payouts/[id]/appraise-form.tsx:185` — the accessible name is `"Add another
  paste — appraise more loot, or enter a flat value"`. The visible summary says
  only "add another paste", so the flat-value control is discoverable by screen
  reader and invisible to everyone else.

Parity in both directions: anything the AT channel is told, the visual channel
is told too.

---

## Sessions

One session per block. Each is a branch and a PR (never a local merge to
`main`). Gates at the end of every session:

```
npm run typecheck && npm run lint && npm run format:check
npm test
npm run test:e2e          # local runs `next dev`; CI builds for production
npm run build             # a CI gate in its own right
./scripts/check-node-version.sh
```

### Session 0 — rulings and cross-cutting sweep

Small, mechanical, unblocks everything after it. Do this first or the later
sessions will each solve the shared items differently.

- Record **R1** in `DESIGN.md` (scope the 28px grade to dense control-set rows,
  name the drawer exception) and in `docs/settled-design-decisions.md` (mark
  the superseded row rather than deleting it).
- Record **R2** and **R4** in `DESIGN.md` as design laws.
- Remove the four em dashes from rendered copy: `admin/accounts/page.tsx:1097`,
  `payouts/[id]/appraise-form.tsx:185`, `payouts/[id]/flat-pool-form.tsx:82`,
  `login/page.tsx:56`. Em dashes in *comments* are fine and out of scope.
- Delete the lede that restates its own table: `payouts/page.tsx:92-96` **first
  sentence only** — the second sentence routes to `/account` and must survive,
  and deleting the first promotes it.

The equivalent `/account` lede ("Membership, characters, and the state authGD
is pushing out…") is **deliberately left to Session 3**, not done here.
`e2e/account.spec.ts:1583-1592` uses it as the narrow-capped sibling that proves
the manifest opts out of the cap, so deleting it breaks that test — and finding
3.1 changes what the right anchor is. Doing it in Session 0 means editing that
test twice.

**Acceptance:** no rendered em dashes; the `/payouts` lede reduced; `DESIGN.md`
and `settled-design-decisions.md` state R1, R2 and R4.

---

### Session 1 — `/payouts/[id]`

Carries both P0s. Highest value, do it first.

| # | Finding | Where |
|---|---|---|
| 1.1 **P0** | The `edit` control beside the battle report only appears on hover. It does not exist on touch, and a keyboard user finds it by tabbing into something with no visible affordance. Every other control on the page is visible at rest. | `payouts/[id]/inline-edit.tsx` |
| 1.2 **P0** | Finalize's cost sentence — *"Closes the pools, roster and shares to editing. Reversible with Unlock until the first payment is recorded, and permanent after that"* — is good copy that renders only **after** the button is armed. The user must commit before they can read what they are committing to. Inverts PRODUCT.md principle 2 (state before action). Tracked as `SYNTHESIS.md` item 6. | `payouts/[id]/page.tsx:489-503` |
| 1.3 | Save confirmation is `visually-hidden`. See **R4**. The fix is to surface it, not to add one — `_components/note-form.tsx:98` shows the visible form (`· saved`, `dim mono`). | `payouts/[id]/notes-form.tsx:102` |
| 1.4 | "Add a flat value" is reachable only through a disclosure labelled "add another paste". The accessible name already names both; the visible summary does not. See **R4**. | `payouts/[id]/appraise-form.tsx:185` |
| 1.5 | `source` and `value` are columns that never vary and cannot be acted on. A column that is neither variable nor actionable is a label wearing a table's clothes. | `payouts/[id]/page.tsx` pool items |
| 1.6 | `payments (N)` hides a single row behind a disclosure. `N` is genuinely unbounded — `payout_payment_kind` is `["paid","reverted"]` (`db/schema.ts:300`), so paid → reverted → paid is three rows — but it is 1 in the overwhelmingly common case. Render inline at 1; collapse at 2+. | `payouts/[id]/payment-history.tsx:36` |
| 1.7 | The `locked` paragraph is four lines of prose about revert-versus-unlock semantics parked permanently in the page body. Accurate and hard-won; belongs next to the control it constrains. | `payouts/[id]/page.tsx:478-485` |
| 1.8 | The page computes `primaryStage` (appraise → roster → finalize) and never shows it. The order of operations exists in the code and not on screen. | `payouts/[id]/page.tsx:233` |

**Acceptance:** the battle-report edit control is visible at rest and reachable
on touch; Finalize's consequence is readable before arming; the notes save
confirms visibly; the flat-value path is discoverable without a screen reader.

---

### Session 2 — `/payouts`

| # | Finding | Where |
|---|---|---|
| 2.1 | The list cannot answer "was I paid?". `SYNTHESIS.md` item 7 — open and untracked in both follow-up lists. The fix is a `where` clause on a participants query already issued at `payout-view.ts:135-139`. | `payouts/page.tsx` |
| 2.2 | No search, filter, or sort on a log that only grows and is never purged. Paging is one-page-at-a-time cursor. Invisible at one row; structural at two hundred. The correctness rule for a future filter is already pre-written at `payouts/page.tsx:222-225` (a filter must DROP `before`). | `payouts/page.tsx:226-249` |
| 2.3 | Naming collision per **R3**: `page__stamp` "Flight log" above `<h1>` "Payouts", with a nav item that promises the personal reading. | `payouts/page.tsx:76-85` |

**Deliberately preserved** — do not "simplify" these, they are correct and
subtle: the `total` vs `shown` distinction (`page.tsx:53-64`), the past-end
pager recovery (`page.tsx:197`), the role-dependent empty states
(`page.tsx:204`), and the `Paid` column's tone logic (`page.tsx:167-190`), which
deliberately renders a draft mid-payment as neutral rather than amber.

---

### Session 3 — `/account`

| # | Finding | Where |
|---|---|---|
| 3.1 | The health strip (`N characters — all healthy`) is right-aligned to a 912px header row while the manifest table below runs 1198px. Measured: strip right edge **1032**, table right edge **1319**, a **287px** shortfall. Cause is `.page--narrow > :where(*)` capping direct children at `60rem - 2 × --s-5 = 912px`, which the table escapes via `full-measure` at `account/page.tsx:572`. The page runs on two measures; right-aligning one element exposed the seam. Fix is one class on the head row. **Also re-anchor `e2e/account.spec.ts:1583-1592`**, which currently proves the opt-out by comparing the manifest against the lede — an anchor this fix invalidates. | `globals.css:566`, `account/page.tsx:264` |
| 3.1b | Deferred here from Session 0: delete the lede ("Membership, characters, and the state authGD is pushing out to standings, the map, and Discord"), which restates the sections beneath it. Blocked on 3.1 because it is the current test anchor. | `account/page.tsx:335-338` |
| 3.2 | `MAIN` and `UNLINK` are 40 permanent controls across 20 rows, in the widest columns, for actions the owner reports as almost never used. Apply **R2**. This is the unlock for 3.3 and 3.4: reclaiming that width is what makes room for both. | `account/page.tsx` manifest |
| 3.3 | Dead horizontal space in the manifest, downstream of 3.2. | — |
| 3.4 | The location column is 20 mostly-identical strings. Owner's proposal, adopted: show only locations that differ from the main character's. | `account/page.tsx` |

Note the budget constraint: the manifest's density was already worked twice
(#169, #174). Re-measure before assuming there is room; the one-line layout was
measured and rejected once (413px against a 286px region at 320px).

---

### Session 4 — `/admin/accounts`

| # | Finding | Where |
|---|---|---|
| 4.1 | Apply **R1**: whole drawer to the 36px grade. Retire the defence comment. | `_components/note-form.tsx:55-76` |
| 4.2 | Apply **R2**: `UNLINK` out of the collapsed row. It is the one rare control on this page not already in the drawer, and it forces every row taller by stacking handle over button. | `admin/accounts/page.tsx` |
| 4.3 | The tier-lock note is 34 words capped at 34ch, so it renders ~7 lines deep in a control column, and contains a matched em-dash pair (see Session 0). Suggested: *"Locks the tier. The membership job stops changing it, even if they leave the alliance, until you press auto."* | `admin/accounts/page.tsx:1097` |
| 4.4 | The crew table is a horizontally-scrolling region nested inside the page's own horizontally-scrolling region. A scrollbar inside a scrollbar has no good visual state. `globals.css:3582-3617` is two `min-width: 0` floors documented with measured pixel values, tracking how the overflow escaped one box and reappeared one level in — correct engineering on the premise that a `<tr>` can be a panel. **Structural; stage separately from 4.1.** | `globals.css:3535-3617` |

**Constraint:** `0/8 OK` rendered in red alongside `8 re-auth` reads as
contradictory. Not separately filed because it may resolve under 4.2's
re-layout; check it after.

---

### Session 5 — `/admin/sync`

| # | Finding | Where |
|---|---|---|
| 5.1 | The cadence column renders four formats plus one raw cron: `every 30m`, `hourly :05`, `daily 03:00 UTC`, `Sun 04:00 UTC`, and `2,17,32,47 * * * *`. `location` falls through every branch of `formatCadence` because its minute field is a comma list, hitting the bare `return cron`. It is every-15-minutes offset by 2; one branch for evenly-spaced comma lists fixes it. | `core/schedules.ts:95-111`, `JOB_CRON.location:21` |
| 5.2 | UTC is stamped on three rows of eight. The rule is correct — `every 30m` and `hourly :05` are timezone-invariant and labelling them would be noise — but no reader can infer it, so correct behaviour reads as inconsistency. | `core/schedules.ts:89-112` |
| 5.3 | Housekeeping is a third full strip at equal rank with the two strips that have controls, and `groupFor` defines it as *"not reachable from any page control"* (`schedules.ts:52`). Do not delete it — a failing `purge` or `token-health` is a real fault with no other surface. Collapse to one health line that expands only on fault. | `admin/sync/page.tsx` |
| 5.4 | `location` is grouped as housekeeping but its output is rendered to every member on `/account`. The grouping is by control-reachability, not by whether anyone reads the result, so the one housekeeping job with user-visible output sits in the strip 5.3 hides. | `core/schedules.ts:60-69` |
| 5.5 | The expanded run panel is ~280px tall for one line of content; the JSON block stretches the row and roughly three quarters is empty. | `admin/sync/page.tsx` |
| 5.6 | An inner border ends ~85px short of the outer table edge, reading as a rendering fault rather than a boundary. | `admin/sync/page.tsx` |
| 5.7 | `5 runs` sits beside `last 5 runs`. The count restates its own label. | `admin/sync/page.tsx` |

---

### Session 6 — `/admin/audit`

| # | Finding | Where |
|---|---|---|
| 6.1 | The `Action prefix` hint is `e.g. tier.` — and the trailing dot is the entire meaning, disguised as a full stop. Read as "e.g. tier" it teaches nothing, and typing `tier` still works, so the misreading is never corrected. | `admin/audit/page.tsx:485` |
| 6.2 | The hint is not the same kind of thing as its neighbours: Actor says "who did it" and Target describes its field, both in plain language. This one skips describing and gives an example. | `admin/audit/page.tsx:470-490` |
| 6.3 | "Prefix" is implementation vocabulary in a label. It parses only if you already know actions are dot-namespaced — and the admin who most needs the filter is the one who doesn't. | `admin/audit/page.tsx:475` |
| 6.4 | It is the wrong control. The namespace set is closed and small: `discord.`, `character.`, `token.`, `wanderer.`, `payout.`, `tier.`, `status.`, `account.`, `admin.`, `sync.` (`services/audit.ts:154-168`). A select or ten chips removes 6.1, 6.2 and 6.3 at once and makes the vocabulary discoverable. If it stays free text, the minimum is a hint that describes rather than demonstrates, with visible syntax: *"matches the start of an action, like `tier.granted`"*. | `admin/audit/page.tsx:470-490` |

**Preserved:** the action cell links to itself as a filter
(`admin/audit/page.tsx:618`), so once you have one row you can pivot off it.
The gap is only the cold start. Also note the action-prefix index shipped
(`drizzle/0010_even_jetstream.sql`) — this session is copy and control shape,
not query performance.

---

## Not a session — decide before scheduling

### Pay before finalize

Today the pay controls are gated on `status === "finalized"`
(`payouts/[id]/page.tsx:837`). The owner's position is that this should be an
option rather than a precondition.

That is a product decision with a correctness consequence, and it touches
persisted financial state and reconciliation, so it is a **stop-and-ask**
surface. It must not be folded into Session 1.

The question to answer first: **what happens when a share is recalculated after
someone has already been paid?** The strongest candidate is that paying a
participant freezes that participant's share, and Finalize becomes "freeze
everyone remaining" rather than a prerequisite — preserving the invariant per
row instead of per operation. That needs a schema look before it needs a design.

---

## Heuristic baseline (for re-scoring after the sessions land)

Nielsen, 0-4, scored at the end of the walkthrough. Deterministic scan
(`impeccable detect src`) returned clean, so all of this is design review.

| Heuristic | Score |
|---|---|
| Visibility of system status | 3 |
| Match with the real world | 2 |
| User control and freedom | 4 |
| Consistency and standards | 2 |
| Error prevention | 4 |
| Recognition over recall | 2 |
| Flexibility and efficiency | 2 |
| Aesthetic and minimalist design | 2 |
| Error recovery | 4 |
| Help and documentation | 2 |

**27/40.** The spread is the finding: everything about *safety* scores 4,
everything about *finding and understanding* scores 2. This is an application
built by someone who thought hard about what happens when things go wrong, and
less about the ordinary case where nothing is wrong and you just need to locate
something.

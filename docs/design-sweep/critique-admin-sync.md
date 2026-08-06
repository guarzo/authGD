# critique — /admin/sync

Register: **product**.

Traced: `page.tsx` in full, `view.ts`, `run-health.ts`, `run-summary.ts`,
`schedules.ts`, `core/health.ts`, `services/sync-status.ts`, `services/health.ts`,
`actions.ts`, `relative-time.tsx`, `format-ago.ts`, `ui.tsx`, and the `.strip*`,
`.log--runs`, `.worker`, `.btn-row__stamp` rules in `globals.css`.

The scenario driving the findings below: **Discord roles stopped updating an hour
ago; an admin opens this page cold.** That is the page's stated reason to exist,
and it is the case the page currently handles worst — because "an hour" lands
inside a window where every liveness signal on the page reads normal.

## Findings

### 1. A dead worker reads as healthy for its first 90 minutes, and the page says so in prose

- **Severity:** blocking
- **Where:** `src/app/admin/sync/page.tsx:143-172`, `src/core/health.ts:10`, `src/app/admin/sync/view.ts:100-107`, `src/core/run-health.ts:32`
- **Cost:** An admin who noticed at 14:00 that Discord roles stopped at 13:00 opens this page, reads "the worker picks it up within a few seconds" and a quiet grey `worker · last run 58m ago`, sees no drawer opened and no red anywhere, and closes the tab believing the tool is fine — during the exact outage they came to diagnose.
- **Principle:** PRODUCT.md principle 2 ("every screen answers what is true right now"); the same over-claim class commit e5d76df just removed from `queuedNotice`.
- **Fix:** The thresholds are inconsistent by construction and the page never reconciles them. Rows escalate to `overdue` at their own cadence plus `OVERDUE_GRACE_MS` — 35 minutes for `membership`, 65 for the three hourly jobs — while `STALE_AFTER_MS` holds the worker line at "fresh" until 90. In the 35-to-90-minute gap, four of seven rows are amber, `needsAttention.overdue === false` keeps every one of them shut, and the worker line, which `view.ts:100-107` names as the compensating signal ("A dead worker is a page-level condition and it is the worker line above the strip that says so"), has not fired yet. The suppression is load-bearing and correct; the thing it defers to is asleep. Two changes, both small:
  1. Derive the worker line from the rows, not only from the global threshold. When `overdue`/`missing` covers more than one group, or more than half the scheduled jobs, escalate to `Notice tone="bad"` regardless of the 90-minute clock: `worker · N of 7 jobs past due, last recorded run 58m ago`. Simultaneous-overdue-across-groups is exactly the shape a dead worker makes and nothing else does, and it is available at render from the `health` values already computed in the map at `page.tsx:241`.
  2. Make the lede state the age instead of a verdict, the same correction `view.ts:229-235` already argues for `queuedNotice`: "the worker last ran 58m ago" is true in both branches and needs no threshold. The current ternary spends the page's most-read sentence asserting a several-seconds pickup on the strength of a boolean whose own docblock says it "could not actually support that within ten minutes of a worker dying."
  3. While there: `.worker` is `--ink-dim` at `--t-label` when fresh (`globals.css:2150-2156`). The one line on the page that reports the process rather than a job is the dimmest, smallest thing above the strip. It does not need to shout when fresh, but it should not be quieter than the column headers.

### 2. On a tab left open, the ages tick and the health tokens do not

- **Severity:** serious
- **Where:** `src/app/_components/relative-time.tsx:6-14,62-84`, `src/app/admin/sync/page.tsx:112-114,336-339`, `globals.css:1754-1760`
- **Cost:** An admin who left this tab open since lunch sees a green `ok` sitting beside a live-updating `3h ago` on a 30-minute job, and reads the row as healthy because the green token is the thing the strip trained them to scan.
- **Principle:** none (Nielsen 1, visibility of system status).
- **Fix:** `RelativeTime` was added precisely so a server-computed "3s ago" would not "sit there claiming freshness for as long as the tab stays open" — but it was applied to the age only. `rowHealth`, `HEALTH_TONE`, `evidenceSince` and the worker line are all frozen at `renderedAt` (`page.tsx:112`). The half-fix is worse than either whole one: it makes the page *look* live (the only moving element on screen is a clock) while its verdicts are hours old, and it puts the two halves of one row into visible contradiction. The page must not poll (settled, and right). The honest fix is to make the render's own age visible and let it escalate: render the `RuleHead` aside through `RelativeTime` as `checked 2h ago` rather than the frozen `checked 14:03:11 UTC`, and past roughly one `membership` cadence swap it into a `Notice tone="warn"` above the strip saying the health below is that old and to reload. Today that stamp is `--ink-faint`, uppercase, at label size — the faintest element on the page is the only thing that could have told the admin the green was stale. Keep the absolute UTC value too (it is what an admin pastes into chat); add the relative one beside it.

### 3. A wedged dispatcher's only sighted signal is an unlabelled 8px dot

- **Severity:** serious
- **Where:** `src/app/admin/sync/page.tsx:321-334`, `src/app/admin/sync/view.ts:295-338`, `globals.css:2505-2537`
- **Cost:** Work has sat undispatched for 40 minutes, the admin's own "Sync now" press among it; the row says green `ok` (its last scheduled run really did succeed), and the entire report of the wedge is an amber circle 8 pixels wide whose meaning appears nowhere on the page.
- **Principle:** PRODUCT.md accessibility, "never colour alone" — inverted here: the words exist only for screen readers, and sighted users get shape and colour alone.
- **Fix:** `view.ts:295-301` is explicit that `startDispatcher` swallows dispatch failures into `console.error` and that "the marker is the only thing that can" surface this. That makes the marker a page-level alarm, and it is currently rendered as decoration. The 7.5rem-track argument in `globals.css:2505-2515` is sound for the *ordinary* queued ring and should stay. The escalation should not live in that track at all: apply the same page-level-condition reasoning the code already applies to a dead worker, and when any row's `queuedMarkerStuck` is true, render a `Notice tone="bad"` above the strip — `work has been queued for 40m without being dispatched; the dispatcher is not draining the outbox`. That costs the fixed track nothing, gives the sighted admin the sentence the screen-reader user already gets from `queuedMarkerText`, and puts it where a page-level fault belongs. Secondarily, nothing on the page defines the ring even in its calm state; a stuck row should also open its drawer, which today it cannot, because `needsAttention` keys off `RowHealth` and the queued marker is deliberately outside that type.

### 4. `overdue` is the one state with no drawer and no lever

- **Severity:** moderate
- **Where:** `src/app/admin/sync/view.ts:109-119`, `src/app/admin/sync/page.tsx:712-719,733-748`
- **Cost:** An admin looking at a single amber `overdue` on `discord-roles` has exactly one visible control that touches it — the gold fan-out, which re-runs four jobs and re-hits ESI and Wanderer for three that were fine — because `Re-run discord-roles` only exists inside a drawer that this state does not open and gives no hint contains a control.
- **Principle:** PRODUCT.md principle 3 (scanning is the primary act) — the scan finds the row and then dead-ends.
- **Fix:** The auto-open exclusion for `overdue` is right and must stay (a dead worker would expand all seven). The per-job lever does not have to live behind it. Either surface the re-run control in the summary row for rows where `needsAttention` is false but the state is actionable, or — cheaper and more in keeping with the strip's density — make the disclosure marker say what is behind it for a non-fresh row. Right now `+` on an amber row and `+` on a green row promise the same thing, and only one of them holds an action the admin wants. At minimum, do not let the gold fan-out be the only visible response to a single-job fault; that is the page teaching the heavier action.

### 5. `failing` swallows "and nothing has tried since"

- **Severity:** moderate
- **Where:** `src/core/run-health.ts:204-217`
- **Cost:** A job that failed once at 03:00 and has not been attempted for eleven hours renders identically to one failing every thirty minutes; the admin presses Re-run, watches it fail again, and still does not know the schedule stopped firing.
- **Principle:** none.
- **Fix:** `rowHealth` returns `failing` on `status === "failed"` and returns before the `dueAfter`/`isLate` check below it, so schedule adherence is unreachable for any row whose last run failed — the two questions the admin actually asks ("did it work?" and "is it still running?") collapse into whichever one is answered first. The module's own opening docblock frames its purpose as adding the time model a status-only page lacks; it added it everywhere except the failure path, where the elapsed time matters most. Either let `failing` carry an overdue qualifier (`failed, none since`), or let the drawer state it: the runs table is open on exactly these rows and the `.strip__window` line beneath it is already the natural place for "last attempt 11h ago". Do not add a second token to the fixed track.

### 6. Auto-open breaks the single-column scan the strip exists for

- **Severity:** moderate
- **Where:** `src/app/admin/sync/page.tsx:259-260`, `globals.css:2431-2436`
- **Cost:** With two sweep jobs failing, each drawer expands to a header row plus up to five run rows plus a window line plus a button — several hundred pixels each — so the Housekeeping group is pushed off the first screen, and the admin scanning for "the one that's off" cannot see rows five through seven without scrolling past the two they already found.
- **Principle:** PRODUCT.md principle 3; `globals.css:2435` states the intent in as many words ("a failure is then found by scanning one narrow strip, not five tables").
- **Fix:** The strip's grid is built so seven health tokens form one scannable column; auto-open interrupts that column with arbitrary-height content at exactly the moment more than one row is bad. Give the reader the roll-up the strip can no longer supply on its own: the `RuleHead` currently spends the widest, highest slot above the strip on `7 jobs`, a constant that is true on every render of every deployment and answers nothing. Make it the verdict — `2 of 7 need attention`, or `all 7 ok` — and it becomes the sentence the arriving admin reads first, immune to how many drawers are open below it. Optionally cap auto-open at the first `needsAttention` row and mark the rest, though the roll-up alone would carry most of the value.

### 7. The runs table gives no elapsed time at the width admins actually use

- **Severity:** minor
- **Where:** `src/app/admin/sync/page.tsx:587-600,696-706`, `globals.css:922-940`
- **Cost:** An admin reading an opened failure drawer on a desktop monitor sees five ISO stamps and must subtract them by hand against a `checked 14:03:11 UTC` stamp at the top of the page to learn whether this started ten minutes or three days ago.
- **Principle:** none.
- **Fix:** The relative time is rendered only inside `.only-narrow` and is `display: none` above 40rem, so the wide layout — the one an admin on a 27-inch monitor is looking at — is the one with no elapsed value at all, while the narrow layout has both. The comment at `page.tsx:577-586` justifies the *narrow* substitution correctly; it does not argue against showing both when there is room, and `.log--runs` is `max-width: max-content`, so surplus width already becomes trailing space rather than stretched cells. Show the stamp plus a dim `(3h ago)` at wide widths. Separately, `.strip__window` reads `last 5 runs`, a caption stating a fact the reader can count, when the thing it was added to say (its own comment: "a job that has failed forty times looks identical to one that has failed five") is that there may be more. `showing the last 5 runs` says it in one word, and as a real `<caption>` it would also sit above the table rather than after it.

## What is good and must survive

- **The single `renderedAt` instant** (`page.tsx:112-114`) and everything derived from it. Finding 2 asks for the *staleness* of that instant to be visible; it must not be answered by reading the clock per row.
- **`evidenceSince` returning null when the worker is not fresh** (`view.ts:270-284`). This is what stops a dead worker flipping every never-run row to `missing` at once. A fix for finding 1 must not route through this.
- **`RowHealth` being disjoint from `SyncRunStatus`** (`run-health.ts:46-69`). The type is the only thing preventing a regression to status-only colouring, and finding 5's fix must not add `failed` to the health vocabulary as a shared literal.
- **The per-group `role="list"` with `aria-labelledby`** (`page.tsx:213-231`). The group headings are the only place a screen-reader user learns the fan-out's scope; a later "simplify to one list" pass would delete that silently.
- **`Absent`** (`page.tsx:83-90`) and the three distinct absences in the counts cells. These look like noise in a diff and are not.
- **`sameOutcome` refusing to collapse on differing `errorSummary`** (`run-summary.ts:225-233`), and the duration span on group rows. Both exist to stop the collapse hiding the thing the drawer was opened for, and both would look like removable complexity.
- **The `strip__health` wrapper being one grid item** (`page.tsx:274`). Splitting it re-breaks the aligned column for every row.
- **The gold button's placement below the strip.** Finding 4 asks for a *lighter* per-job affordance, never for the fan-out to move up.

## Could not evaluate

- **Whether the amber `.strip__queued--stuck` dot is actually noticeable at a glance across seven rows.** Judging an 8px filled-vs-outlined mark against `--ink-faint` needs rendered pixels; screenshots and a dev server are out of scope. Finding 3 does not rest on it — the missing *words* are the finding — but the visual half would be settled by one screenshot of a stuck row beside a queued-and-fine one.
- **Real-world drawer height.** Finding 6's "pushed off the first screen" assumes ~5 run rows at `.log td` padding plus the Scroller; it is arithmetic from `run-summary.ts:150-158`, not a measurement.
- **How often `queuedSince` is actually null in production.** The null path degrades to a bare ", queued" and never escalates, which is correct, but I could not tell whether that path is unreachable in practice or routine.
- **Whether an admin ever reaches this page at a width below 46rem.** The narrow layout carries strictly more temporal information than the wide one (finding 7); if narrow is the real usage, finding 7 inverts in severity rather than disappearing.

## Contested

Nothing on the settled list. The no-polling decision in particular is right, and findings 1 and 2 are written to be implementable without it — an aging "checked" stamp and a row-derived worker verdict both need only the render the page already does.

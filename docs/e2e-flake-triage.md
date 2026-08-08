# Telling a flake from a regression

The e2e suite runs `workers: 1` and `retries: 0`. Both are deliberate, and the
second one means a single red run is ambiguous: it could be a real defect that
only reproduces sometimes. **A single run proves nothing** on the tests listed
below. Resample before concluding anything.

## Resampling a test

```bash
npm run test:e2e:repeat -- e2e/payouts.spec.ts -g "twice running"
```

Defaults to 5 iterations. Override with `E2E_REPEAT`:

```bash
E2E_REPEAT=20 npm run test:e2e:repeat -- e2e/sync.spec.ts -g "second identical press"
```

Everything after `--` is passed straight to `playwright test`, so the usual
file-path and `-g` filters apply. Scope it to one spec — `--repeat-each` with no
filter re-runs the entire suite N times, and at `workers: 1` that is a long
afternoon.

The script defaults the count with POSIX `${E2E_REPEAT:-5}`, which needs an
`sh`-family shell. That covers Linux, WSL, macOS, and CI (`ubuntu-latest`); on
Windows `cmd.exe` it would not expand, so call `npx playwright test
--repeat-each=5 …` directly there.

**Five is a smoke test, not a measurement.** The default exists so a quick
resample is one command; it is not enough to conclude anything. The failure
modes catalogued below have been measured between 1% and 40% per run depending
on the machine, and at the low end of that — where most of them sit — five
iterations misses a real defect more often than it finds one. Do not report a
rate, and do not clear a test, from fewer than 20. This document has twice been
wrong in exactly that way.

Read the result as a rate, not a verdict:

| Outcome | Reading |
| --- | --- |
| 0/N fail | The single red run was environmental, or you did not reproduce it. Raise N before dismissing it. |
| 1..N-1 fail | A real intermittent defect. **Do not** add retries — find the race. |
| N/N fail | A deterministic regression. Bisect normally. |

The middle row is the one that gets mishandled. An intermittent failure is not a
flaky test; it is a flaky *product*, and the test is the only thing telling you.

### Write rates down as `k/N on <machine>`

Never as "the" rate. The same test has been measured at 4/10 on one machine and
roughly 5-10% on another, and at **0/60 on a third** — all three correct. The
mechanism section below explains why that spread is expected rather than
evidence that someone measured wrong. A rate quoted with no machine attached
cannot be checked and should not be trusted.

The machine used for every number in this document, unless it says otherwise:

> **machine A** — WSL2 (`Linux 6.6.87.2-microsoft-standard-WSL2`), 24 logical
> CPUs, `next dev`, Postgres in Docker with `fsync=on`, `synchronous_commit=on`,
> `full_page_writes=on`.

Note that local runs use `next dev` and CI serves a production build, so CI is
not machine A with a different CPU count — it is a different server too.

## Why not just add retries

`retries: 2` turns a defect that fails 40% of the time into a green run roughly
94% of the time (treating attempts as independent), annotated "flaky" and
filtered out of the report. The rationale lives next to the setting in
`playwright.config.ts`. If you are here because CI is red and retries look
tempting, that comment is aimed at you.

## The one root cause behind every entry below

**A test pressed a control before the previous action reached the client.**

That is the whole of it. Server actions on these pages mostly `revalidate` in
place rather than navigating, so nothing unmounts and nothing about the DOM
obviously says "still working". The three ways it goes wrong differ only in what
the too-early press collides with:

| # | Collides with | Symptom | Seen in |
| --- | --- | --- | --- |
| 1 | the submit guard's in-flight latch | the press is `preventDefault`ed: no POST, no row, no error | `payouts.spec.ts:1176` |
| 2 | a `ConfirmSubmit` re-render | the control un-arms between locator resolution and click, so the confirm press lands as a fresh *arm* press | `payouts.spec.ts:1969` |

Two, not "the two": nobody has enumerated the client state a revalidation can
reset. Mechanism 2 was found by measuring, not by reasoning from the guard, and
the next one probably will be too.

**Waiting on the database is the trap common to all of them.** The row commits
before the action's response reaches the browser, so an `expect.poll` against
Postgres can go green with the form still busy. Wait on a signal the *client*
produces, then check the database to prove the server agreed.

## Mechanism 1: the guard refuses a press while the last one is in flight

> **Corrected 2026-08-08.** This section once said the `useSubmitGuard` latch
> *sticks permanently* once a `pending` transition is swallowed, and closed by
> telling you to fix the guard. That was inferred from the symptom — a second
> save missing from the database — and it is wrong. It has since been measured
> directly, twice, and the correction is now reproducible rather than
> remembered: see "Proving it" below.

`src/app/_components/submit-guard.ts` latches `inFlight` synchronously on click
— on any click that will actually submit, i.e. past the `!form` and
`checkValidity()` gates — and releases it only after an effect observes
`pending` true and then false. So between the press and the client seeing that
action settle, **the button refuses further presses: `preventDefault`, no POST,
no visible trace**. That window is the feature. It is what stops a double-click
on `/payouts/new` from creating two operations, which is not idempotent and has
no delete path.

Two components use the guard:

- **`Submit`** (`submit.tsx`) — every validating click latches.
- **`ConfirmSubmit`** (`confirm-submit.tsx`) — with `confirm={true}` only the
  confirm press latches, because the arm press `preventDefault`s and returns
  before reaching the guard. With **`confirm={false}` the single press latches
  immediately** (`confirm-submit.tsx:409-413`), and two live callers flip that
  prop at runtime: `payouts/[id]/pay-flow.tsx:333` (`confirm={arm}`) and
  `admin/accounts/page.tsx:1046` (`confirm={!r.tierLocked}`). Rows in a paid
  table therefore hold the latch from their *first* press, not only a second.

### Proving it

The correction above originally rested on a scratch spec that was deleted, which
made it folklore. It is now a committed test:

```bash
npx playwright test e2e/submit-guard.spec.ts \
  -g "does not latch the guard" --repeat-each=20 --workers=1
```

`e2e/submit-guard.spec.ts:180` "a press refused mid-flight does not latch the
guard: the next press saves" presses `Save notes` three times on
`/payouts/[id]`, the second one immediately after the first with no wait at all,
and records per press whether a POST went out, what the row holds, and an
`aria-busy` `MutationObserver` log on the button. It fails loudly if a press is
ever refused with `aria-busy="false"` at click time after an earlier press was
dropped — which is what a leaked latch looks like.

Pressing immediately rather than waiting is deliberate: it **forces** the drop
every run instead of sampling a ~10% race, so this is a deterministic regression
test rather than a rare-event sampler.

Measured, 20 runs at `--repeat-each=20 --workers=1` on machine A:

| Ledger fact | Result |
| --- | --- |
| press 2 dropped (`preventDefault`, `aria-busy="true"` at click time) | **20/20** |
| `aria-busy` observed committing `true` | **20/20** |
| `aria-busy` transitions per run | **4** in every run — exactly two complete cycles for the two presses that fired |
| press 3 refused after press 2 was dropped (**a leaked latch**) | **0/20** |

A representative ledger:

```json
[{"at":2354,"busy":"false","prevented":false},
 {"at":2460,"busy":"true","prevented":true},
 {"at":2901,"busy":"false","prevented":false}]
```

`aria-busy` mirrors the same `pending` that gates the guard's release branch, so
an observed `true` commit proves that branch is reachable. The permanent-latch
theory requires a swallowed transition; it has never been observed, in ~60 runs
across two base commits before and 20 runs after.

Two traps for anyone extending this probe:

- **Instrument at page level** (`page.addInitScript`, `page.on("request")`), not
  by editing `submit-guard.ts`. An earlier attempt to add per-instance ids there
  crashed SSR with `window is not defined`, and a shared `window.__g` array
  conflates every `Submit` on the page, since they all share the hook.
- **Sample `defaultPrevented` from `setTimeout(…, 0)`, not `queueMicrotask`.**
  The DOM runs a microtask checkpoint *between* listener invocations, so a
  microtask samples before React's own handler has run. That silently reports
  `prevented: false` for a dropped press and turns the leak assertion into a
  no-op — this probe hit exactly that and reported a false green once.

### Why the rate moves so much between machines

Failure requires a specific ordering, so the useful quantity is a margin, not a
rate: **the time between the client settling and the test's next press.**
Negative margin means the press lands mid-flight and is dropped.

Measured on machine A, n=20 per row, with the pre-#184 sequencing (poll Postgres
between presses):

| CPUs available | margin min | p50 | max | press 2 dropped |
| --- | --- | --- | --- | --- |
| 24 | 40 ms | 64 ms | 100 ms | 0/20 |
| 2 (`taskset -c 0,1`) | 15 ms | 59 ms | 83 ms | 0/20 |

And the window the margin is measured against — row committed to client settled,
n=15 per row:

| CPUs | gap p50 | gap max | gap mean |
| --- | --- | --- | --- |
| 24 | 90 ms | 118 ms | 90 ms |
| 4 | 98 ms | 208 ms | 109 ms |
| 2 | 167-195 ms | **3797 ms** | 171-422 ms |

Total in-flight time per notes save at 24 CPUs: mean 181 ms, range 144-236 ms.

So the rate is `P(margin < 0)`, where the margin sits around 60 ms against two
independent latency distributions each of order 100 ms with heavy tails. Machine
A is roughly 60 ms away from failing, which is why it produced **0/60** on the
pre-#184 test (0/20 at 24 CPUs, 0/20 under `taskset -c 0,1`, 0/20 with `.next`
deleted so every route compiles cold) while other machines produced 4/10 and
5-10%. Those numbers are not in conflict; they are three samples of a margin
distribution.

**The knob is not simply CPU count.** Starving the machine widens the window
*and* slows Playwright's own re-press, so the two effects largely cancel — 2
CPUs did not raise the failure rate, it only compressed the minimum margin from
40 ms to 15 ms. What actually moves the rate is anything that lengthens the
server round trip *without* also delaying the test process: a slower database, a
cold route compile that the test does not pay for, network latency to a remote
Postgres, or CI's production build changing the server side alone.

Postgres durability settings move it the *counterintuitive* way. The container
runs `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`. Turning those
off would make the row visible *sooner* relative to the response, which widens
the commit-to-settle gap and makes the pre-#184 sequencing worse, not better.

### The fix, applied

Gate on a signal the *client* produces when its own `useActionState` resolves.
`NotesForm` renders `· saved` for exactly that. Adding

```ts
await expect(page.locator(".notes-form__saved")).toHaveText("· saved");
```

after each click, **with `submit-guard.ts` untouched**, took
`payouts.spec.ts:1176` to 20/20 green.

Note the shape of that signal: `· saved` renders only while the textarea still
holds the acknowledged text (`notes-form.tsx:140`). It is the right barrier
between two presses of the *same* text, and the wrong one after an edit — which
is why the probe spec above uses a balanced `aria-busy` ledger instead.

## Mechanism 2: a confirm press that lands as an arm press

Found while measuring the inventory below, and **not** a case of the guard.

`payouts.spec.ts:1969` "deleting an operation with a paid participant is refused
on the page" pressed `Set roster` and then went straight for `Finalize` with no
wait. When `Set roster`'s revalidation lands between Playwright resolving the
`confirm finalize` locator and the click actually dispatching, `ConfirmGroup`
re-renders, the control returns to rest, and the press arrives at a button that
is no longer armed — so `ConfirmSubmit` takes its arm branch, `preventDefault`s,
and re-arms. The operation stays `draft`, no notice renders, and `mark paid` —
which only exists once finalized — never appears. The test times out 30 s later
pointing at a button that was never going to exist.

The click ledger, from a replica of the test (`aria-label` captured at click
time):

```json
failing: [{"name":"Finalize","busy":"false","prevented":true},
          {"name":"Finalize","busy":"false","prevented":true}]
passing: [{"name":"Finalize","busy":"false","prevented":true},
          {"name":"confirm finalize","busy":"false","prevented":false}]
```

`busy: "false"` on both presses is the part that rules out mechanism 1: the
guard was never involved, and could not have been — `useSubmitGuard`'s latch is
per-form, and the Finalize form had not submitted anything yet. At the failing
runs' end the database read `status: "draft"` with `participants: 1`, so the
roster had committed; only the finalize had not.

Rates on machine A, replica without the settle wait: **7/86** (4/40, 2/40, 1/6).
With `await expect(page.getByText("Brain Tartare")).toBeVisible()` added after
`Set roster`: **0/40**. The real test, fixed the same way: **40/40**.

The lesson is the same as mechanism 1 with a different victim. A `ConfirmSubmit`
sequence needs a settle wait after the *previous* action, not just between its
own two presses, because arming is client state that an unrelated revalidation
resets.

## The inventory, measured

Every row below was sampled at `--repeat-each=20 --workers=1` on machine A on
2026-08-08. Reproduce a row with:

```bash
npx playwright test e2e/payouts.spec.ts -g "<title fragment>" \
  --repeat-each=20 --workers=1
```

A test is exposed when a guarded or armed control is pressed **while still
mounted from a previous action**, and the test's own wait does not prove that
action reached the client. Server actions that only `revalidate` do not unmount
the form. A press that ends in `redirect()` to a *different* route unmounts it
and is safe; a redirect to the same route is a soft navigation and is not.

**Shape (a) — the same guarded control pressed twice:**

| Test | Control | Result |
| --- | --- | --- |
| `payouts.spec.ts:1176` "notes save from an always-open textarea, twice running" | `Save notes` | 20/20 pass (fixed in #184; 4/10 fail before) |
| `sync.spec.ts:892` "a second identical press moves focus again" | `Sync now` (redirects to the *same* route — soft nav, instance survives) | **20/20 pass** |
| `sync.spec.ts:835` "the fan-out reports back, moves focus to the confirmation, and Refresh clears the flag" | `Sync now` | **20/20 pass** |
| `payouts.spec.ts:1766` "adding the same name twice is refused on the page, not on the error boundary" | `Add participant` | **20/20 pass** |
| `payouts.spec.ts:1409` "bad shares land on the page, not the error boundary" | `save shares for Alice Pilot` | **20/20 pass** |
| `payouts.spec.ts:977` "a battle report link is stored, and a bad scheme is refused without losing the rest of the form" | `Create operation` (rejection does not navigate) | **20/20 pass** |
| `payouts.spec.ts:1370` "a rejected create form comes back filled in" | `Create operation` | **20/20 pass** |

`sync.spec.ts:892` was previously cleared at 10/10 with the explanation that its
intervening `redirect()` is a round trip the test waits on. That explanation now
holds at n=20 as well. It is still an explanation rather than a proof — nothing
has instrumented that round trip the way `submit-guard.spec.ts:180` instruments
the notes one.

**Shape (b) — a guarded press after prior non-unmounting actions on the same
page.** All of `/payouts/[id]`, where every lifecycle action revalidates in
place:

| Test | Result |
| --- | --- |
| `payouts.spec.ts:1969` "deleting an operation with a paid participant is refused on the page" | **1/20 fail** — mechanism 2 above; **40/40 pass** once the settle wait is added |
| `payouts.spec.ts:1472` "override an item price, finalize, pay, revert, and pay again" — ten clicks, zero navigations, longest chain in the suite | **20/20 pass** |
| `payouts.spec.ts:197` "create, add a flat pool, paste a roster, finalize, mark paid" | **20/20 pass** |
| `payouts.spec.ts:404` "pasting two alts of one account collapses them into one participant row" | **20/20 pass** |
| `payouts.spec.ts:611` "a dropped-lines paste does not collapse an unrelated disclosure the operator left open" | **20/20 pass** |
| `payouts.spec.ts:779` "setting shares, excluding, and removing a participant each recompute exact ISK amounts…" | **20/20 pass** |
| `payouts.spec.ts:1092` "finalizing hands focus to the operation heading" | **20/20 pass** |
| `payouts.spec.ts:1886` "an admin deletes an operation, and the audit row outlives it" | **20/20 pass** |
| `payouts.spec.ts:2103` "an inline share edit saves without a page navigation" | **20/20 pass** |
| `payouts.spec.ts:2157` "replacing the roster from a paste requires confirmation" | **20/20 pass** |
| `payouts.spec.ts:2193` "exactly one gold primary control renders in each draft state" | **20/20 pass** |

**`ConfirmSubmit` in a table with `confirm` flipping true→false** — the exact
"unrelated re-render" the guard's own docblock names, and per the
`confirm={false}` note above these latch on a single press. This was the case
least covered by anything measured before:

| Test | Result |
| --- | --- |
| `payouts.spec.ts:2306` "the second payment advances again, on one click" | **20/20 pass** |
| `payouts.spec.ts:2440` "paying the last row focuses the roster heading and says all are paid" | **20/20 pass** |
| `payouts.spec.ts:2576` "running off the end wraps back to the skipped row and says so" | **20/20 pass** |

380 runs across the 19 payouts rows, 40 across the two sync rows: **one failure,
`payouts.spec.ts:1969`, now fixed.** Passing 20/20 bounds a row's rate at
roughly 14% with 95% confidence, not at zero — a 5% defect survives 20 runs
about a third of the time. These rows are cleared for machine A at n=20, not
proven safe.

### Why a red run here is easy to misread

Only `payouts.spec.ts:1176` and `e2e/submit-guard.spec.ts` assert against the
database. Everything else listed asserts on the DOM, so a refused press there
surfaces as a missing notice, an unmoved focus ring, or a stale amount — not as
an obvious lost write. `payouts.spec.ts:1969` is the concrete case: it presented
as a 30-second locator timeout on `mark paid`, which reads as "the button is
slow" and is actually "an action three steps earlier never ran".

## What a member sees when a press is dropped

Recorded here because it is a product question the measurements above raise and
do not answer.

`Submit` sets `aria-busy` and swaps in `pendingLabel` ("saving…" for notes), so
the in-flight *state* is visible. The **discarded press produces no feedback of
its own**: no POST, no error, no message. For `/payouts/new` that is correct and
deliberate — two clicks must never make two operations. For notes it is weaker:
the second press can carry different text, and dropping it drops an edit.

Nothing is destroyed — the controlled textarea still holds the text, and
pressing Save again saves it. And `NotesForm`'s confirmation is a comparison,
not a flag, so it correctly declines to claim a save that did not happen. What
is missing is a *positive* signal that the press did nothing; its absence is
indistinguishable from the at-rest state, and a screen-reader user gets nothing
for the press at all.

At the measured ~181 ms mean round trip on machine A this is unreachable by
hand: you cannot type new text and press again inside 200 ms. The exposure is a
slow action — cold machine, loaded database — where the window grows to seconds.

Left as-is for now. If it is revisited, the constraints are fixed:

- **Not `disabled`.** Disabling the pressed element moves focus to `<body>`, and
  these actions end in `redirect()` with no document load, so nothing puts it
  back. `error.tsx:275-278` already refuses `disabled` for this reason.
- **Not `useFormStatus().pending` as the latch.** `pending` is only true on the
  render *after* the first submit, and a double-click lands both clicks inside
  that window.
- **Not a bare `if (!pending)` release with no dependency array.**
- **The latch must stay skipped when the browser blocks the submit on constraint
  validation**, or the button ends up permanently dead.

Queueing the refused press and replaying it on release is the obvious idea and
is worse than it looks: it cannot live in the shared guard without turning a
double-click on `/payouts/new` into two serialized creates, and a replayed
`setNotes` can throw `PayoutLockedError` and redirect a page the member has
stopped interacting with.

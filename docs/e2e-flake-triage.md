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

Read the result as a rate, not a verdict:

| Outcome | Reading |
| --- | --- |
| 0/N fail | The single red run was environmental, or you did not reproduce it. Raise N before dismissing it. |
| 1..N-1 fail | A real intermittent defect. **Do not** add retries — find the race. |
| N/N fail | A deterministic regression. Bisect normally. |

The middle row is the one that gets mishandled. An intermittent failure is not a
flaky test; it is a flaky *product*, and the test is the only thing telling you.

## Why not just add retries

`retries: 2` turns a defect that fails 40% of the time into a green run roughly
94% of the time (treating attempts as independent), annotated "flaky" and
filtered out of the report. The rationale lives next to the setting in
`playwright.config.ts`. If you are here because CI is red and retries look
tempting, that comment is aimed at you.

## Known exposure: pressing a guarded button while the last one is in flight

> **Corrected 2026-08-08.** This section previously said the `useSubmitGuard`
> latch *sticks permanently* once a `pending` transition is swallowed, and
> closed by telling you to fix the guard. That was inferred from the symptom —
> a second save missing from the database — and it is wrong. See "Measured, not
> inferred" below: the swallowed transition was never observed, and a press
> after a dropped one always went through. The guard is doing what it is for.
> What follows is the corrected reading; the test inventory it grew out of is
> still worth having, so it is kept.

`src/app/_components/submit-guard.ts` latches `inFlight` synchronously on click
— on any click that will actually submit, i.e. past the `!form` and
`checkValidity()` gates — and releases it only after an effect observes
`pending` true and then false. So between the press and the client seeing that
action settle, **the button refuses further presses: `preventDefault`, no POST,
no visible trace**. That window is the feature. It is what stops a double-click
on `/payouts/new` from creating two operations, which is not idempotent and has
no delete path.

The window is also longer than it looks from a test's point of view, and that is
what makes a specific *shape* of test intermittently red. Those failures must
not be mistaken for noise, and must not be mistaken for a product defect either:
they are the test pressing again too early.

Two components use the guard:

- **`Submit`** (`submit.tsx`) — every validating click latches.
- **`ConfirmSubmit`** (`confirm-submit.tsx`) — with `confirm={true}` only the
  confirm press latches, because the arm press `preventDefault`s and returns
  before reaching the guard. With **`confirm={false}` the single press latches
  immediately** (`confirm-submit.tsx:409-413`), and two live callers flip that
  prop at runtime: `payouts/[id]/pay-flow.tsx:333` (`confirm={arm}`) and
  `admin/accounts/page.tsx:1046` (`confirm={!r.tierLocked}`). Rows in a paid
  table therefore hold the latch from their *first* press, not only a second.

`e2e/submit-guard.spec.ts` is the dedicated regression spec for this primitive.
It double-clicks `Create operation` on a form that redirects away, so the
component unmounts before a third press is possible — it proves the double-click
is refused, and says nothing about release.

### The exposed shape

A test is exposed when a guarded button is pressed **while still mounted from a
previous action**, and the test's own wait does not prove that action reached
the client. Server actions that only `revalidate` do not unmount the form, so
the latch is still held. A press that ends in `redirect()` to a different route
unmounts the form and is safe.

Waiting on the database is the trap. The row commits before the action's
response reaches the browser, so a `expect.poll` against Postgres can go green
with the form still busy.

**Shape (a) — the same guarded button pressed twice:**

| Test | Button |
| --- | --- |
| `e2e/payouts.spec.ts:1175` "notes save from an always-open textarea, twice running" | `Save notes` |
| `e2e/sync.spec.ts:859` "a second identical press moves focus again" | `Sync now` (redirects to the *same* route — soft nav, instance survives) |
| `e2e/payouts.spec.ts:1741` "adding the same name twice is refused on the page, not on the error boundary" | `Add participant` |
| `e2e/payouts.spec.ts:1384` "bad shares land on the page, not the error boundary" | `save shares for Alice Pilot` |
| `e2e/payouts.spec.ts:976` "a battle report link is stored, and a bad scheme is refused without losing the rest of the form" | `Create operation` (rejection does not navigate) |
| `e2e/payouts.spec.ts:1345` "a rejected create form comes back filled in" | `Create operation` |

**Shape (b) — a guarded press after prior non-unmounting actions on the same
page.** All of `/payouts/[id]`, where every lifecycle action revalidates in
place:

- `e2e/payouts.spec.ts:1447` "override an item price, finalize, pay, revert, and
  pay again" — ten clicks, zero navigations. Longest chain in the suite.
- `e2e/payouts.spec.ts:1944` "deleting an operation with a paid participant is
  refused on the page" — the assertion-bearing press comes last, after the whole
  create/pool/roster/finalize/pay sequence has revalidated the page in place.
- `e2e/payouts.spec.ts:778`, `:196`, `:1091`, `:1861`, `:2159`, `:2069`, `:403`,
  `:610`, `:2123` — several guarded presses in sequence on one document.
- `e2e/payouts.spec.ts:2272`, `:2406`, `:2542` — `ConfirmSubmit` in a table with
  `confirm` flipping true→false, the exact "unrelated re-render" the guard's own
  docblock names. Per the `confirm={false}` note above, these latch on a single
  press.

### Measured, not inferred

The original observation stands: `payouts.spec.ts:1175` fails intermittently,
and it fails as a missing row, not a timed-out DOM query.

```
$ npx playwright test e2e/payouts.spec.ts \
    -g "notes save from an always-open textarea, twice running" --repeat-each=10

  4 failed
    e2e/payouts.spec.ts:1175:5 › notes save from an always-open textarea, twice running
    ... (3 more)
  6 passed (4.0m)
```

```
Expected: "Third fleet, two losses. Salvage split later."
Received: "Third fleet, two losses."
```

The rate is machine-dependent — the same test on a second machine failed 1/15,
2/20, 2/20 and 1/20, roughly 5-10% against the 40% above. Do not treat any one
number as the rate; treat a non-zero count as the signal.

What the second POST's absence *means* was then measured directly, with a probe
that presses `Save notes` three times and records, per press, whether a POST was
emitted, the resulting row, and an `aria-busy` `MutationObserver` log on the
button itself. Sixty runs across two base commits, four drops observed:

- **`aria-busy` committed `true` on every run, including every failing run.**
  The swallowed `pending` transition the permanent-latch theory requires was
  never once observed. `started.current` is set; the release branch runs.
- **At the instant of a dropped press, `aria-busy` was still `true`** — the
  previous action had 335ms and 539ms of in-flight time left on the two runs
  examined closely. The guard refused a genuine second submit over a live one.
- **The press after a dropped one always went through**, in every run:
  `dropped3:false`, `afterThird:"third"`. A representative failing run logged
  `busy=true busy=false busy=true busy=false` — two complete pending cycles for
  the two presses that fired. The latch released.

A permanent latch predicts `dropped3:true`. It was never seen.

The corollary is the fix: gate on a signal the *client* produces when its own
`useActionState` resolves. `NotesForm` renders `· saved` for exactly that, and
`payouts.spec.ts:3085` already selected on it. Adding
`await expect(page.locator(".notes-form__saved")).toHaveText("· saved")` after
each click, **with `submit-guard.ts` untouched**, took the test to 20/20 green.

```
$ npx playwright test e2e/sync.spec.ts \
    -g "a second identical press moves focus again" --repeat-each=10

  10 passed (1.1m)
```

Exposure by shape is not the same as a current failure rate. `sync.spec.ts:859`
has the same shape and did not manifest in 10 runs; its intervening
`redirect()`, same-route or not, is a round trip the test waits on. The rest of
the table is unmeasured — listed because it shares the shape, not because it has
been seen red. Measure before you act on any row.

One more caveat on reading this document: only `payouts.spec.ts:1175` and
`e2e/submit-guard.spec.ts` assert against the database. Everything else listed
asserts on the DOM, so a refused press there surfaces as a missing notice, an
unmoved focus ring, or a stale amount — not as an obvious lost write. That makes
those failures easier to misread as rendering noise, which is the whole reason
they are inventoried here.

So: the tests are not wrong about *something* being off, but a database poll is
not a settle signal, and `payouts.spec.ts:1175` polling the row is what let it
press again mid-flight. Fix the wait, not the guard. If a row on this list turns
red, find the client-side signal that the previous action resolved and wait on
that; only then check the database, which is still the only thing that proves
the server agreed.

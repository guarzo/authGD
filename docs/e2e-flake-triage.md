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

## Known exposure: the `useSubmitGuard` latch

`src/app/_components/submit-guard.ts` latches `inFlight` synchronously on click
— on any click that will actually submit, i.e. past the `!form` and
`checkValidity()` gates — and releases it only after an effect observes
`pending` true and then false. When that transition is swallowed — the action
settles before a commit, or an unrelated re-render sequence covers it — the
latch sticks, and **every subsequent press on that button is
`preventDefault`'ed with no POST**. The user sees a button that does nothing
and a save that silently did not happen.

This is a live product bug, fixed separately. It is recorded here because it
makes a specific *shape* of test intermittently red, and those tests must not be
mistaken for noise.

Two components use the guard:

- **`Submit`** (`submit.tsx`) — every validating click latches.
- **`ConfirmSubmit`** (`confirm-submit.tsx`) — with `confirm={true}` only the
  confirm press latches, because the arm press `preventDefault`s and returns
  before reaching the guard. With **`confirm={false}` the single press latches
  immediately** (`confirm-submit.tsx:409-413`), and two live callers flip that
  prop at runtime: `payouts/[id]/pay-flow.tsx:333` (`confirm={arm}`) and
  `admin/accounts/page.tsx:1046` (`confirm={!r.tierLocked}`). Rows in a paid
  table are therefore exposed on their *first* press, not only a second.

`e2e/submit-guard.spec.ts` is the dedicated regression spec for this primitive.
It cannot catch the leak: it double-clicks `Create operation` on a form that
redirects away, so the component unmounts before a third press is possible and a
permanently-set `inFlight` still passes.

### The exposed shape

A test is exposed when a guarded button is pressed **while still mounted from a
previous action**. Server actions that only `revalidate` do not unmount the
form, so the stale ref survives. A press that ends in `redirect()` to a
different route unmounts the form and is safe.

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

```
$ npx playwright test e2e/payouts.spec.ts \
    -g "notes save from an always-open textarea, twice running" --repeat-each=10

  4 failed
    e2e/payouts.spec.ts:1175:5 › notes save from an always-open textarea, twice running
    e2e/payouts.spec.ts:1175:5 › notes save from an always-open textarea, twice running
    e2e/payouts.spec.ts:1175:5 › notes save from an always-open textarea, twice running
    e2e/payouts.spec.ts:1175:5 › notes save from an always-open textarea, twice running
  6 passed (4.0m)
```

Each failure is the second save missing from the database, not a timeout on a
DOM query:

```
Expected: "Third fleet, two losses. Salvage split later."
Received: "Third fleet, two losses."
```

The first value is still there. The second POST never happened — which is the
latch, observed end to end.

```
$ npx playwright test e2e/sync.spec.ts \
    -g "a second identical press moves focus again" --repeat-each=10

  10 passed (1.1m)
```

So exposure by shape is **not** the same as a current failure rate.
`sync.spec.ts:859` sits on the identical defect and did not manifest in 10 runs.
Why is not established — its redirect is same-route, so by this document's own
table the instance survives and unmounting is not what saved it. Treat that row
as "not reproduced at n=10", not as explained. The rest of the table is
unmeasured — listed because it shares the shape, not because it has been seen
red. Measure before you act on any row.

One more caveat on reading this document: only `payouts.spec.ts:1175` and
`e2e/submit-guard.spec.ts` assert against the database. Everything else listed
asserts on the DOM, so a stuck latch there surfaces as a missing notice, an
unmoved focus ring, or a stale amount — not as an obvious lost write. That makes
those failures easier to misread as rendering noise, which is the whole reason
they are inventoried here.

None of these tests should be rewritten to dodge the latch. They are correct;
`payouts.spec.ts:1175` in particular polls the database precisely so a lost
write cannot pass. Fix the guard.

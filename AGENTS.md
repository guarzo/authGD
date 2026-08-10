<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!--
  Everything below this point is hand-written. `next dev` rewrites only the
  block above, between its two markers, and preserves the rest of the file —
  see the `before`/`after` slices in generate-agent-files.js.
-->

# Running the e2e suite

`npm run test:e2e` — Playwright, `workers: 1` (shared test database), and
`retries: 0`.

## One run is not evidence

Zero retries is deliberate, so an intermittent *product* bug surfaces as a
single red test rather than a green run with a "flaky" annotation. The cost is
that one red run does not tell you which you are looking at. Resample before
concluding anything:

```bash
npm run test:e2e:repeat -- e2e/payouts.spec.ts -g "twice running"
```

Five iterations by default; `E2E_REPEAT=20` to raise it. Arguments after `--`
go straight to `playwright test`, so scope it to one spec — `--repeat-each`
with no filter re-runs the whole suite N times at one worker.

- 0/N fail → the red run was environmental, or you did not reproduce it.
- 1..N-1 fail → a real intermittent defect. Find the race.
- N/N fail → a deterministic regression.

**Do not add `retries` to `playwright.config.ts`.** A red run here is usually an
intermittent product defect, not a slow paint; retrying resamples a real defect
until it comes up green. The rationale is written next to the setting.

`docs/e2e-flake-triage.md` has the full triage workflow and lists the tests
currently exposed to the `useSubmitGuard` latch defect.

## A test written to prove a fix must be shown to fail without it

A passing new test is not evidence that it tests anything. Assertions written
alongside a fix pass for two indistinguishable reasons — the fix works, or the
assertion cannot fail — and a green run reports both identically. This is not a
rare slip: six assertions written during one sweep of this repo turned out to be
vacuous, each caught only by this check and none by review.

So, before a test that exists to prove a fix is committed: **take the fix out,
leave the test in, and watch it fail.** Then put the fix back and watch it pass.
If the failure message does not describe the defect you set out to fix, the test
is measuring something else.

The instrument matters as much as the discipline. Reverting *everything*
uncommitted is not a control when the test is part of the same uncommitted
change — stashing removes the test alongside the fix, nothing runs, and the
green result is read as confirmation. Revert only the code under test, by hand,
and leave the assertion standing.

The failures this catches are the quiet kind. `toBeVisible()` against a
`.visually-hidden` element passes either way, because a 1px clipped box still
has a bounding box. A row-count assertion on a table whose empty state is itself
one `<tr>` passes whether or not the filter ran. A colour assertion parsing
`getComputedStyle` output passes on garbage, because these tokens serialize as
`oklch(...)` and a naive parse reads lightness as red without erroring. None of
those announce themselves; all of them fail loudly the moment the fix is removed.


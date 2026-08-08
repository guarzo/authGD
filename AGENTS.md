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

**Do not add `retries` to `playwright.config.ts`.** These specs assert against
the database, so a failure is a lost write; retrying resamples a real defect
until it comes up green. The rationale is written next to the setting.

`docs/e2e-flake-triage.md` has the full triage workflow and lists the tests
currently exposed to the `useSubmitGuard` latch defect.


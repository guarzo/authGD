# Current Wingman v2 joint gate

**Status: opt-in and environment-blocked on the current development host.** The
user approved retaining this separately configured test without requiring a green
run on this WSL host before local completion or opening draft PRs. It is not part
of the regular Vitest suite, and remains failing rather than being silently
skipped or weakening the clock checks. This decision is not a passing end-to-end
result: a green regular suite does not prove this particular journey.

A read-only probe reproduced WSL clock-rate errors and wall-clock steps without
Wingman; Windows precise clocks stayed aligned and all 2,400 database timestamp
conversions agreed. Further WSL repair is outside the application change. Keep
production timing protections and deterministic timing regressions unchanged.

## What runs

`e2e/fleet-current-v2.test.ts` starts an owned loopback TLS adapter around the
actual v2 Next route handlers, real PostgreSQL, outbox dispatch, pg-boss and the
retained automatic discovery/source owners. Two independent current Wingman
Python processes use separate state/preferences roots and real Api, signed
client, file-backed gamelogs, discovery/metrics/admission and presentation code.
Actual `index.html` and `fleetbar.html` scripts run in isolated Chromium pages;
the WebView bridge is replaced by process RPC, not a mock fleet API.

The scenario clicks combat approval, this PC's participation and account
automatic verification separately; checks received directional DPS and named
tackle; terminates and recreates both Python processes; waits for a different
fleet ID under normal reservation pacing; checks new telemetry; and turns
automatic consent Off. It never rewrites due times or clears timing fences.

External ESI/JWT transport, account approval, DPAPI and native window/enumeration
operations are explicit seams. The test does not run live OAuth, Next ingress
middleware, real WebView2, source-window manipulation, or a production relay.
Those remain separate gates.

## Prerequisites and command

Use an exclusively owned disposable PostgreSQL database at
`127.0.0.1:55463/authgd_joint` (user/password `authgd`), with no concurrent DB test
runner. The test deliberately refuses another address. Do not substitute the
backend lane's existing 55462 database or the occupied default 5433 service.
Normal test global setup applies the existing migrations to this disposable DB.
Node dependencies and Chrome must already be installed. Wingman must be a clean,
pinned current checkout with its locked development Python dependencies.

```sh
TEST_DATABASE_URL=postgres://authgd:authgd@127.0.0.1:55463/authgd_joint \
E2E_WINGMAN_ROOT=/absolute/path/to/wingman-integration \
E2E_WINGMAN_PYTHON=/absolute/path/to/wingman-integration/.venv/bin/python \
E2E_WINGMAN_COMMIT=<exact-clean-Wingman-SHA> \
E2E_CHROME=/usr/bin/google-chrome \
npx vitest run e2e/fleet-current-v2.test.ts --config vitest.fleet-current.config.ts
```

For Windows Python launched from WSL, additionally set
`E2E_WINGMAN_NATIVE_ROOT` to that same checkout's Windows path, and set
`E2E_WINGMAN_PYTHON` to the Linux-accessible path of its Windows `python.exe`.
The driver uses `wslpath` for owned temporary state/certificate paths. Install
that environment from the unchanged lock with hashes; do not borrow the running
application's credentials or profile. No system/browser trust-store changes are
needed.

## Regular-suite evidence is separate

The complete regular Vitest suite passed **4,936 tests in 190 files**, with no
skips, after provisioning `authgd_test_fleet_v2_joint` and its distinct
`_legacy_migration` sibling inside the same owned 55463 container. Its existing
historical transport/lifecycle checks require Wingman `911ae540` and a separate
locked environment, plus a production Next build. They are historical fixture
regressions, **not** current-client v2 journey acceptance or a v1 fallback.
See [the regular-suite prerequisites](ops.md#reproducing-the-joint-synthetic-proof).
The new current-client gate above instead pins the current integration checkout.

The fresh pre-publication repeat passed **4,936 tests in 190 files, no skips,
1067.59s** on unchanged source/test head `a157543` plus acceptance documentation.
Full ESLint, typecheck and repository-wide Prettier checks passed again. The
current-client journey was not rerun or relabelled as passing.

The Next build used the existing local-only font response fixture and disabled
telemetry. An isolated `npm ci` installation from the unchanged lock was needed
because Turbopack rejects the original shared node_modules symlink. Full ESLint
and typecheck also passed. No production backend or migration changes were made
for this integration harness; one historical test now selects only its shared
state column instead of asking the pre-combat schema for newer consent columns.

## Clock evidence and remaining acceptance

A Windows-client run on Wingman `3363da55` and authGD `e1ac22c` observed relay T
advance 8026 ms while the original elapsed request-start clock advanced 6765 ms.
The two actual diagnostic intervals were disjoint by about 1030 ms, already
including the fixed 100 ms margins and measured request duration. The second
client independently had a 1035 ms gap. Sharing correctly remained fenced.

Development runs reached initial real-UI telemetry and full process restart;
these partial observations do **not** establish the complete future-fleet/Off
journey. The final gate must be rerun with stable real clocks. Do not replace its
clock with a mock, expand its tolerance, silently restart after a contradiction,
or mark the scenario skipped to manufacture acceptance.

This does not authorize deployment, cutover, production consent, migrations
against an operational database, or changes to host clocks/power settings.

# Current Wingman v2 joint gate

**Status: not accepted on the current development host.** The gate is implemented
and fails rather than skipping or weakening the clock checks. Real relay UTC
steps have produced `clock_inconsistent` with both Linux and Windows clients.
A green desktop unit suite is not a substitute for this gate.

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

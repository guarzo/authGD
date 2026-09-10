import { defineConfig } from "@playwright/test";
import {
  APP_PORT,
  BASE_URL,
  CONTAINER_NAME,
  FLEET_INTEGRATIONS,
  IS_CI,
  MANAGED_ENV_KEY,
  SHOULD_PROVISION,
  SYNTHETIC_APP_ENV,
  TEST_DATABASE_URL,
  WORKTREE_ROOT,
} from "./e2e/env";
import { ensureTestDatabase } from "./e2e/provision";
import { resolveServerReuse } from "./e2e/server-guard";
import { assertFleetDatabaseUrl } from "./e2e/fleet-server";
import { databaseIsolationEnvironment } from "./e2e/db-isolation-bootstrap";

// Provisioning runs at config load, not in globalSetup: Playwright starts
// `webServer` during plugin setup, which the runner orders *before* global
// setup files. By the time a globalSetup hook ran, `next dev` would already be
// up and the port already bound.
if (FLEET_INTEGRATIONS) assertFleetDatabaseUrl(TEST_DATABASE_URL);
const { recreated } = ensureTestDatabase();

if (SHOULD_PROVISION) {
  console.log(`[e2e] ${CONTAINER_NAME} → ${TEST_DATABASE_URL}`);
}

// Full config env: getConfig() validates lazily per request, so the dev server
// needs every required var even though e2e never talks to EVE/Discord/Wanderer.
const env = {
  // The same constant e2e/helpers.ts seeds through — see e2e/env.ts. These two
  // must never be able to disagree.
  DATABASE_URL: TEST_DATABASE_URL,
  TEST_DATABASE_URL,
  ...SYNTHETIC_APP_ENV,
  ...(FLEET_INTEGRATIONS ? { E2E_DB_ISOLATION: "1" } : databaseIsolationEnvironment()),
  APP_BASE_URL: BASE_URL,
  // Only the owned, intercepted server may exercise live integration code.
  SYNC_MODE: FLEET_INTEGRATIONS ? "live" : "dry-run",
  ...(FLEET_INTEGRATIONS ? { E2E_FLEET_INTEGRATIONS: "1" } : {}),
  // Lets the guard prove, on a later run, that a server on this port is one we
  // started and may therefore restart. See e2e/server-guard.ts.
  [MANAGED_ENV_KEY]: WORKTREE_ROOT,
};

export default defineConfig({
  testDir: "e2e",
  ...(FLEET_INTEGRATIONS
    ? { testMatch: ["**/fleet-access.spec.ts", "**/fleet-joint.spec.ts"] }
    : { testIgnore: ["**/fleet-access.spec.ts", "**/fleet-joint.spec.ts"] }),
  workers: 1, // shared test database — never parallelize
  // Zero, deliberately, and it is the setting most likely to be "fixed" by
  // someone staring at a red CI run. Do not raise it.
  //
  // A red run here is more often an intermittent *product* defect than a slow
  // paint: these specs drive real server actions against a real database.
  // Retrying that does not stabilize anything — it resamples a live defect
  // until it comes up green and then files it under "flaky".
  //
  // The concrete case: a test presses a control before the previous action has
  // reached the client. `useSubmitGuard`
  // (src/app/_components/submit-guard.ts) then refuses the press —
  // preventDefault, no POST, no visible trace — because it holds a re-entry
  // latch until an effect observes `pending` true and then false. That is the
  // guard working; the press was genuinely a second submit over a live one.
  // `e2e/payouts.spec.ts` "notes save from an always-open textarea, twice
  // running" caught it as a lost write, because it is one of the few specs that
  // polls the database rather than the DOM — measured at 4 failures in 10 runs
  // on one machine, 5-10% on a second, and 0 in 60 on a third. The rate is a
  // margin between two latency distributions, so it moves by machine; a
  // non-zero count anywhere is the signal.
  //
  // Treating attempts as independent, at 40% `retries: 2` would report green on
  // 1 - 0.4^3 ≈ 94% of CI runs, and even `retries: 1` on 84% — the defect would
  // be marked "flaky", filtered out of the report, and shipped.
  //
  // An earlier version of this comment said the latch "sticks" permanently once
  // a `pending` transition is swallowed. That was inferred from the symptom and
  // is wrong: the swallowed transition has never been observed, and a press
  // after a dropped one has always gone through.
  // `e2e/submit-guard.spec.ts` "a press refused mid-flight does not latch the
  // guard" is the committed regression test for that, and it forces the drop on
  // every run rather than sampling it.
  //
  // The cost of zero is real and accepted: an infrastructure blip fails the
  // whole run. That is the cheaper mistake. A red run gets investigated; a
  // green run with a flaky annotation gets ignored.
  //
  // To tell a flake from a regression, resample explicitly instead:
  //   npm run test:e2e:repeat -- e2e/payouts.spec.ts -g "twice running"
  // See docs/e2e-flake-triage.md.
  retries: 0,
  use: { baseURL: BASE_URL },
  webServer: {
    // CI serves a production build; locally it stays `next dev`.
    //
    // `next dev` compiles each route on its first request. With `workers: 1`
    // that compilation is serialized in front of the tests rather than
    // amortized across them, and it dominated the CI e2e step. A build pays it
    // once, up front — locally the suite went from 6.3m to 1.7m.
    //
    // The build is a separate CI step, not `next build && next start` here, so
    // it does not have to finish inside the `timeout` below — that budget is
    // for booting a server, and a build racing it would fail as a timeout with
    // no build output in the report.
    //
    // Locally the trade runs the other way: a build before every run would
    // wreck the edit-run loop, and the reuse guard below only pays off against
    // a long-lived server. See e2e/server-guard.ts.
    //
    // `next start` prints a warning under `output: "standalone"` suggesting
    // `node .next/standalone/server.js`. It is advice about what to *ship*, not
    // an error: `next start` reads the same .next/ and serves it correctly.
    // The standalone server would need .next/static and public/ copied in by
    // hand first, which buys nothing for a throwaway CI server.
    command: FLEET_INTEGRATIONS
      ? "node --import tsx e2e/fleet-server.ts"
      : IS_CI
        ? `npx next start -p ${APP_PORT}`
        : `npx next dev -p ${APP_PORT}`,
    ...(FLEET_INTEGRATIONS
      ? { wait: { stdout: /\[fleet-e2e\] intercepted Next ready/ } }
      : { url: `${BASE_URL}/login` }),
    env,
    // Not a flat boolean: reuse is granted only when the process already on
    // this port proves it belongs to this worktree and reads this run's
    // database. See e2e/server-guard.ts for why a flat `!CI` was unsafe.
    reuseExistingServer: FLEET_INTEGRATIONS ? false : resolveServerReuse(recreated),
    ...(FLEET_INTEGRATIONS
      ? { gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 } }
      : {}),
    timeout: 60_000,
  },
});

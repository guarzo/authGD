import { defineConfig } from "@playwright/test";
import {
  APP_PORT,
  BASE_URL,
  CONTAINER_NAME,
  IS_CI,
  MANAGED_ENV_KEY,
  SHOULD_PROVISION,
  TEST_DATABASE_URL,
  WORKTREE_ROOT,
} from "./e2e/env";
import { ensureTestDatabase } from "./e2e/provision";
import { resolveServerReuse } from "./e2e/server-guard";

// Provisioning runs at config load, not in globalSetup: Playwright starts
// `webServer` during plugin setup, which the runner orders *before* global
// setup files. By the time a globalSetup hook ran, `next dev` would already be
// up and the port already bound.
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
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_BASE_URL: BASE_URL,
  ALLIANCE_ID: "99000001",
  BOOTSTRAP_ADMIN_CHARACTER_IDS: "",
  EVE_SSO_CLIENT_ID: "cid",
  EVE_SSO_CLIENT_SECRET: "sec",
  EVE_SSO_SCOPES: "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
  DISCORD_CLIENT_ID: "d-cid",
  DISCORD_CLIENT_SECRET: "d-sec",
  DISCORD_BOT_TOKEN: "bot",
  DISCORD_GUILD_ID: "9000",
  DISCORD_ROLE_ID_MEMBER: "10",
  DISCORD_ROLE_ID_ASSOCIATE: "11",
  DISCORD_ROLE_ID_ALUMNI: "12",
  WANDERER_BASE_URL: "https://wanderer.example",
  WANDERER_API_KEY: "wkey",
  WANDERER_ACL_ID: "acl-1",
  STANDINGS_LABEL: "authgd",
  STANDINGS_VALUE: "5",
  ESI_CONTACT: "ops@example.com",
  // e2e never exercises an external integration, so nothing here depends on
  // live behavior — and dry-run is the correct default for a browsable app.
  SYNC_MODE: "dry-run",
  // Deliberately not the defaults. A spec asserting the fallback strings
  // cannot tell "config was read" from "the string was hardcoded"; these
  // values appear nowhere in src/, so seeing them in the DOM proves the whole
  // path. The defaults are covered by the unit tests instead, which set none
  // of these. BRAND_MARK_URL points at a real file that is not the mark's
  // default, for the same reason.
  BRAND_NAME: "Test Corp",
  BRAND_TAGLINE: "Test Ops",
  BRAND_MARK_URL: "/brand/emblem.webp",
  BRAND_MOTTO: "Test motto line",
  BRAND_FOOTER: "Test footer line",
  TIER_LABEL_MEMBER: "Testers",
  TIER_LABEL_ASSOCIATE: "Friends",
  TIER_LABEL_ALUMNI: "Veterans",
  TIER_LABEL_PENDING: "Queued",
  // Lets the guard prove, on a later run, that a server on this port is one we
  // started and may therefore restart. See e2e/server-guard.ts.
  [MANAGED_ENV_KEY]: WORKTREE_ROOT,
};

export default defineConfig({
  testDir: "e2e",
  workers: 1, // shared test database — never parallelize
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
    command: IS_CI ? `npx next start -p ${APP_PORT}` : `npx next dev -p ${APP_PORT}`,
    url: `${BASE_URL}/login`,
    env,
    // Not a flat boolean: reuse is granted only when the process already on
    // this port proves it belongs to this worktree and reads this run's
    // database. See e2e/server-guard.ts for why a flat `!CI` was unsafe.
    reuseExistingServer: resolveServerReuse(recreated),
    timeout: 60_000,
  },
});

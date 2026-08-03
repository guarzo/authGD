import { defineConfig } from "@playwright/test";

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://authgd:authgd@localhost:5433/authgd_test";

// Full config env: getConfig() validates lazily per request, so the dev server
// needs every required var even though e2e never talks to EVE/Discord/Wanderer.
const env = {
  DATABASE_URL: TEST_URL,
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_BASE_URL: "http://localhost:3111",
  ALLIANCE_ID: "99000001",
  BOOTSTRAP_ADMIN_CHARACTER_IDS: "",
  EVE_SSO_CLIENT_ID: "cid",
  EVE_SSO_CLIENT_SECRET: "sec",
  EVE_SSO_SCOPES: "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
  DISCORD_CLIENT_ID: "d-cid",
  DISCORD_CLIENT_SECRET: "d-sec",
  DISCORD_BOT_TOKEN: "bot",
  DISCORD_GUILD_ID: "9000",
  DISCORD_ROLE_ID_FLYGD: "10",
  DISCORD_ROLE_ID_BLUE: "11",
  DISCORD_ROLE_ID_GREEN: "12",
  WANDERER_BASE_URL: "https://wanderer.example",
  WANDERER_API_KEY: "wkey",
  WANDERER_ACL_ID: "acl-1",
  STANDINGS_LABEL: "flygd",
  STANDINGS_VALUE: "5",
  ESI_CONTACT: "ops@example.com",
  // e2e never exercises an external integration, so nothing here depends on
  // live behavior — and dry-run is the correct default for a browsable app.
  SYNC_MODE: "dry-run",
};

export default defineConfig({
  testDir: "e2e",
  workers: 1, // shared test database — never parallelize
  use: { baseURL: "http://localhost:3111" },
  webServer: {
    command: "npx next dev -p 3111",
    url: "http://localhost:3111/login",
    env,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

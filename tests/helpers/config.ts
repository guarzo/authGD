import { loadConfig, type Config } from "@/config";

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    DATABASE_URL: "postgres://x/y",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_BASE_URL: "https://auth.example",
    ALLIANCE_ID: "99000001",
    BOOTSTRAP_ADMIN_CHARACTER_IDS: "",
    EVE_SSO_CLIENT_ID: "client-id",
    EVE_SSO_CLIENT_SECRET: "client-secret",
    EVE_SSO_SCOPES: "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
    DISCORD_CLIENT_ID: "d-cid",
    DISCORD_CLIENT_SECRET: "d-sec",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: "9000",
    DISCORD_ROLE_ID_MEMBER: "10",
    DISCORD_ROLE_ID_ASSOCIATE: "11",
    DISCORD_ROLE_ID_ALUMNI: "12",
    DISCORD_OPS_WEBHOOK_URL: "https://discord.example/webhook",
    WANDERER_BASE_URL: "https://wanderer.example",
    WANDERER_API_KEY: "wkey",
    WANDERER_ACL_ID: "acl-1",
    STANDINGS_LABEL: "flygd",
    STANDINGS_VALUE: "5",
    ESI_CONTACT: "ops@example.com",
    // "live", deliberately (spec D10): 13 test files build config through this
    // helper and assert LIVE behavior — real refreshes, real request counts.
    // Defaulting to dry-run would suppress the very requests those tests exist
    // to verify and leave them passing, which is worse than breaking them.
    // Safety tests opt in with testConfig({ SYNC_MODE: "dry-run" }).
    SYNC_MODE: "live",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

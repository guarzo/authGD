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
    EVE_SCOPE_SET_VERSION: "1",
    DISCORD_CLIENT_ID: "d-cid",
    DISCORD_CLIENT_SECRET: "d-sec",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: "9000",
    DISCORD_ROLE_ID_FLYGD: "10",
    DISCORD_ROLE_ID_BLUE: "11",
    DISCORD_ROLE_ID_GREEN: "12",
    DISCORD_OPS_WEBHOOK_URL: "https://discord.example/webhook",
    WANDERER_BASE_URL: "https://wanderer.example",
    WANDERER_API_KEY: "wkey",
    WANDERER_ACL_ID: "acl-1",
    STANDINGS_LABEL: "flygd",
    STANDINGS_VALUE: "5",
    ESI_CONTACT: "ops@example.com",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

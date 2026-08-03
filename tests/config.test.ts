import { describe, expect, it } from "vitest";
import { loadConfig } from "@/config";

const validEnv = {
  DATABASE_URL: "postgres://x/y",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_BASE_URL: "http://localhost:3000",
  ALLIANCE_ID: "99000001",
  BOOTSTRAP_ADMIN_CHARACTER_IDS: "90000001,90000002",
  EVE_SSO_CLIENT_ID: "cid",
  EVE_SSO_CLIENT_SECRET: "sec",
  EVE_SSO_SCOPES: "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
  DISCORD_CLIENT_ID: "d",
  DISCORD_CLIENT_SECRET: "d",
  DISCORD_BOT_TOKEN: "d",
  DISCORD_GUILD_ID: "1",
  DISCORD_ROLE_ID_FLYGD: "10",
  DISCORD_ROLE_ID_BLUE: "11",
  DISCORD_ROLE_ID_GREEN: "12",
  WANDERER_BASE_URL: "https://wanderer.example",
  WANDERER_API_KEY: "k",
  WANDERER_ACL_ID: "acl-1",
  STANDINGS_LABEL: "flygd",
  STANDINGS_VALUE: "5",
  ESI_CONTACT: "ops@example.com",
} as unknown as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    const c = loadConfig(validEnv);
    expect(c.allianceId).toBe(99000001);
    expect(c.bootstrapAdminCharacterIds).toEqual([90000001, 90000002]);
    expect(c.eveSso.scopes).toEqual([
      "esi-characters.read_contacts.v1",
      "esi-characters.write_contacts.v1",
    ]);
    expect(c.tokenEncryptionKey.length).toBe(32);
    expect(c.standings.value).toBe(5);
  });

  it("rejects a short encryption key", () => {
    expect(() =>
      loadConfig({ ...validEnv, TOKEN_ENCRYPTION_KEY: "c2hvcnQ=" }),
    ).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("rejects missing required vars", () => {
    const { DATABASE_URL: _omitted, ...rest } = validEnv;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow();
  });

  it("rejects malformed or duplicate bootstrap admin ids", () => {
    expect(() =>
      loadConfig({ ...validEnv, BOOTSTRAP_ADMIN_CHARACTER_IDS: "123,abc" }),
    ).toThrow(/BOOTSTRAP_ADMIN_CHARACTER_IDS/);
    expect(() =>
      loadConfig({ ...validEnv, BOOTSTRAP_ADMIN_CHARACTER_IDS: "123,123" }),
    ).toThrow(/duplicates/);
  });
});

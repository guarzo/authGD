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
  DISCORD_ROLE_ID_MEMBER: "10",
  DISCORD_ROLE_ID_ASSOCIATE: "11",
  DISCORD_ROLE_ID_ALUMNI: "12",
  WANDERER_BASE_URL: "https://wanderer.example",
  WANDERER_API_KEY: "k",
  WANDERER_ACL_ID: "acl-1",
  STANDINGS_LABEL: "authgd",
  STANDINGS_VALUE: "5",
  ESI_CONTACT: "ops@example.com",
  SYNC_MODE: "live",
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
    expect(() => loadConfig({ ...validEnv, TOKEN_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(
      /TOKEN_ENCRYPTION_KEY/,
    );
  });

  it("rejects missing required vars", () => {
    const { DATABASE_URL: _omitted, ...rest } = validEnv;
    expect(() => loadConfig(rest)).toThrow();
  });

  it("rejects malformed or duplicate bootstrap admin ids", () => {
    expect(() =>
      loadConfig({ ...validEnv, BOOTSTRAP_ADMIN_CHARACTER_IDS: "123,abc" }),
    ).toThrow(/BOOTSTRAP_ADMIN_CHARACTER_IDS/);
    expect(() =>
      loadConfig({ ...validEnv, BOOTSTRAP_ADMIN_CHARACTER_IDS: "123,123" }),
    ).toThrow(/duplicates/);
  });

  it("exposes discord role ids under the generic tier keys", () => {
    const cfg = loadConfig({
      ...validEnv,
      DISCORD_ROLE_ID_MEMBER: "10",
      DISCORD_ROLE_ID_ASSOCIATE: "11",
      DISCORD_ROLE_ID_ALUMNI: "12",
    });
    expect(cfg.discord.roleIds).toEqual({
      member: "10",
      associate: "11",
      alumni: "12",
    });
  });

  // The OAuth redirect_uri strings CONCATENATE appBaseUrl, so a trailing slash
  // silently produced `https://host//auth/eve/callback` — accepted by
  // z.string().url(), rejected by the provider as a redirect mismatch.
  describe("APP_BASE_URL trailing slash", () => {
    it("strips one or more trailing slashes", () => {
      for (const raw of [
        "https://auth.example/",
        "https://auth.example//",
        "http://localhost:3000/",
      ]) {
        expect(loadConfig({ ...validEnv, APP_BASE_URL: raw }).appBaseUrl).toBe(
          raw.replace(/\/+$/, ""),
        );
      }
    });

    it("leaves a correct value untouched", () => {
      expect(
        loadConfig({ ...validEnv, APP_BASE_URL: "https://auth.example" }).appBaseUrl,
      ).toBe("https://auth.example");
    });

    // A query or fragment defeats a naive trailing-slash strip: rstrip("/")
    // leaves `https://host/app/?tenant=1` untouched, and concatenation then
    // produces `.../app/?tenant=1/auth/eve/callback`.
    it("drops a query string or fragment", () => {
      expect(
        loadConfig({ ...validEnv, APP_BASE_URL: "https://auth.example/app/?tenant=1" })
          .appBaseUrl,
      ).toBe("https://auth.example/app");
      expect(
        loadConfig({ ...validEnv, APP_BASE_URL: "https://auth.example/#frag" })
          .appBaseUrl,
      ).toBe("https://auth.example");
    });

    it("keeps a path prefix, stripping only the trailing slash", () => {
      expect(
        loadConfig({ ...validEnv, APP_BASE_URL: "https://auth.example/app/" }).appBaseUrl,
      ).toBe("https://auth.example/app");
    });
  });

  describe("branding and tier labels", () => {
    it("defaults to generic vocabulary when nothing is set", () => {
      const cfg = loadConfig(validEnv);
      expect(cfg.tierLabels).toEqual({
        member: "Member",
        associate: "Associate",
        alumni: "Alumni",
        pending: "Pending",
      });
      expect(cfg.brand.name).toBe("authGD");
      expect(cfg.brand.tagline).toBe("Auth");
      expect(cfg.brand.motto).toBe("");
      expect(cfg.brand.footer).toBe("");
      expect(cfg.brand.markUrl).toBe("/brand/mark.webp");
      expect(cfg.brand.sealUrl).toBe("/brand/emblem.webp");
    });

    it("takes the configured values when set", () => {
      const cfg = loadConfig({
        ...validEnv,
        TIER_LABEL_MEMBER: "FlyGD",
        BRAND_NAME: "Zoo Landers",
        BRAND_MOTTO: "Center for kids\nwho can't fly good",
      });
      expect(cfg.tierLabels.member).toBe("FlyGD");
      // Unset siblings keep their generic defaults — labels are independent.
      expect(cfg.tierLabels.associate).toBe("Associate");
      expect(cfg.brand.name).toBe("Zoo Landers");
      expect(cfg.brand.motto).toBe("Center for kids\nwho can't fly good");
    });
  });
});

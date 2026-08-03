import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/config";
import {
  buildEveAuthorizeUrl,
  exchangeEveCode,
  verifyEveAccessToken,
} from "@/lib/esi/sso";

const cfg = loadConfig({
  ...process.env,
  DATABASE_URL: "postgres://x/y",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  APP_BASE_URL: "https://auth.example",
  ALLIANCE_ID: "99000001",
  EVE_SSO_CLIENT_ID: "client-id",
  EVE_SSO_CLIENT_SECRET: "client-secret",
  EVE_SSO_SCOPES: "esi-characters.read_contacts.v1",
  DISCORD_CLIENT_ID: "d",
  DISCORD_CLIENT_SECRET: "d",
  DISCORD_BOT_TOKEN: "d",
  DISCORD_GUILD_ID: "1",
  DISCORD_ROLE_ID_FLYGD: "10",
  DISCORD_ROLE_ID_BLUE: "11",
  DISCORD_ROLE_ID_GREEN: "12",
  WANDERER_BASE_URL: "https://w.example",
  WANDERER_API_KEY: "k",
  WANDERER_ACL_ID: "a",
  ESI_CONTACT: "ops@example.com",
});

describe("buildEveAuthorizeUrl", () => {
  it("contains all required params", () => {
    const url = new URL(buildEveAuthorizeUrl(cfg, "st4te", "ch4llenge"));
    expect(url.origin + url.pathname).toBe(
      "https://login.eveonline.com/v2/oauth/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://auth.example/auth/eve/callback",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("code_challenge")).toBe("ch4llenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("esi-characters.read_contacts.v1");
  });
});

describe("exchangeEveCode", () => {
  it("posts code and returns tokens", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = new URLSearchParams(init?.body as string);
      expect(String(input)).toBe("https://login.eveonline.com/v2/oauth/token");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("the-code");
      expect(body.get("code_verifier")).toBe("the-verifier");
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const r = await exchangeEveCode(cfg, "the-code", "the-verifier", fetchImpl);
    expect(r).toEqual({ accessToken: "at", refreshToken: "rt" });
  });

  it("throws EveSsoError with oauthError on failure", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as typeof fetch;
    await expect(exchangeEveCode(cfg, "c", "v", fetchImpl)).rejects.toMatchObject({
      oauthError: "invalid_grant",
    });
  });
});

describe("verifyEveAccessToken", () => {
  it("verifies a signed token and extracts identity", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwks = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), alg: "RS256" }],
    });
    const token = await new SignJWT({
      name: "Pilot One",
      owner: "owner-hash-1",
      scp: ["esi-characters.read_contacts.v1"],
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://login.eveonline.com")
      .setAudience("EVE Online")
      .setSubject("CHARACTER:EVE:90000001")
      .setExpirationTime("5m")
      .sign(privateKey);

    const id = await verifyEveAccessToken(token, jwks);
    expect(id).toEqual({
      characterId: 90000001,
      characterName: "Pilot One",
      ownerHash: "owner-hash-1",
      scopes: ["esi-characters.read_contacts.v1"],
    });
  });

  it("fails closed on missing owner claim", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwks = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), alg: "RS256" }],
    });
    const token = await new SignJWT({ name: "Pilot One" }) // no owner
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://login.eveonline.com")
      .setAudience("EVE Online")
      .setSubject("CHARACTER:EVE:90000001")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyEveAccessToken(token, jwks)).rejects.toThrow(/owner/);
  });
});

describe("token response validation", () => {
  it("fails closed when the token response omits tokens", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: "at" }), {
        status: 200,
      })) as typeof fetch; // refresh_token missing
    await expect(exchangeEveCode(cfg, "c", "v", fetchImpl)).rejects.toThrow(
      /missing tokens/,
    );
  });
});

import { describe, expect, it } from "vitest";
import { exchangeDiscordCode, fetchDiscordUser } from "@/lib/discord/oauth";
import { testConfig } from "./helpers/config";

const cfg = testConfig();

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("exchangeDiscordCode", () => {
  it("returns the access token", async () => {
    const fetchImpl = (async () => jsonResponse({ access_token: "tok" })) as typeof fetch;
    expect(await exchangeDiscordCode(cfg, "c", "v", fetchImpl)).toEqual({
      accessToken: "tok",
    });
  });

  it("fails closed on a malformed token response", async () => {
    const fetchImpl = (async () => jsonResponse({ nope: true })) as typeof fetch;
    await expect(exchangeDiscordCode(cfg, "c", "v", fetchImpl)).rejects.toThrow(/malformed/);
  });

  it("fails closed on an empty access_token", async () => {
    const fetchImpl = (async () => jsonResponse({ access_token: "" })) as typeof fetch;
    await expect(exchangeDiscordCode(cfg, "c", "v", fetchImpl)).rejects.toThrow(/malformed/);
  });
});

describe("fetchDiscordUser", () => {
  it("returns id and username", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ id: "123456789", username: "pilot" })) as typeof fetch;
    expect(await fetchDiscordUser("at", fetchImpl)).toEqual({
      id: "123456789",
      username: "pilot",
    });
  });

  it("rejects a non-snowflake id (feeds a unique identity column)", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ id: "abc", username: "pilot" })) as typeof fetch;
    await expect(fetchDiscordUser("at", fetchImpl)).rejects.toThrow(/malformed/);
  });

  it("rejects a non-JSON body", async () => {
    const fetchImpl = (async () =>
      new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
    await expect(fetchDiscordUser("at", fetchImpl)).rejects.toThrow(/malformed/);
  });
});

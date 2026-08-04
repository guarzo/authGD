import { NextRequest } from "next/server";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, character } from "@/db/schema";
import { setupTestDb, TEST_URL } from "./helpers/db";

// Route modules read config + db lazily via getConfig()/getDb(); set env first.
process.env.DATABASE_URL = TEST_URL;
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.ALLIANCE_ID = "99000001";
process.env.EVE_SSO_CLIENT_ID = "cid";
process.env.EVE_SSO_CLIENT_SECRET = "sec";
process.env.EVE_SSO_SCOPES = "esi-characters.read_contacts.v1";
process.env.DISCORD_CLIENT_ID = "d";
process.env.DISCORD_CLIENT_SECRET = "d";
process.env.DISCORD_BOT_TOKEN = "d";
process.env.DISCORD_GUILD_ID = "1";
process.env.DISCORD_ROLE_ID_FLYGD = "10";
process.env.DISCORD_ROLE_ID_BLUE = "11";
process.env.DISCORD_ROLE_ID_GREEN = "12";
process.env.WANDERER_BASE_URL = "https://w.example";
process.env.WANDERER_API_KEY = "k";
process.env.WANDERER_ACL_ID = "a";
process.env.ESI_CONTACT = "ops@example.com";
process.env.SYNC_MODE = "live";

const { GET: loginRoute } = await import("@/app/auth/eve/login/route");
const { GET: callbackRoute } = await import("@/app/auth/eve/callback/route");

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let signToken: (characterId: number, owner: string) => Promise<string>;
let jwk: Record<string, unknown>;

/** Every callback failure now ends at a page that can explain itself, so the
 *  assertion is the destination, not a status code. */
function expectRedirect(res: Response, dest: string) {
  expect(res.status).toBe(307);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.pathname + loc.search).toBe(dest);
}

const msw = setupServer(
  http.post("https://login.eveonline.com/v2/oauth/token", () =>
    HttpResponse.json({ access_token: "SET_PER_TEST", refresh_token: "rt" }),
  ),
  http.get("https://login.eveonline.com/oauth/jwks", () =>
    HttpResponse.json({ keys: [jwk] }),
  ),
);

beforeAll(async () => {
  ctx = await setupTestDb();
  msw.listen({ onUnhandledRequest: "error" });
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  jwk = { ...(await exportJWK(publicKey)), alg: "RS256" };
  signToken = (characterId, owner) =>
    new SignJWT({
      name: `Char ${characterId}`,
      owner,
      scp: ["esi-characters.read_contacts.v1"],
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://login.eveonline.com")
      .setAudience("EVE Online")
      .setSubject(`CHARACTER:EVE:${characterId}`)
      .setExpirationTime("5m")
      .sign(privateKey);
});
afterAll(async () => {
  msw.close();
  await ctx.cleanup();
});

describe("EVE auth flow", () => {
  it("login → redirect → callback creates account and sets session cookie", async () => {
    const loginRes = await loginRoute(
      new NextRequest("http://localhost:3000/auth/eve/login"),
    );
    expect(loginRes.status).toBe(307);
    const authorize = new URL(loginRes.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;

    const jwt = await signToken(90000001, "oh-1");
    msw.use(
      http.post("https://login.eveonline.com/v2/oauth/token", () =>
        HttpResponse.json({ access_token: jwt, refresh_token: "rt" }),
      ),
    );

    const cbRes = await callbackRoute(
      new NextRequest(
        `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(cbRes.status).toBe(307);
    expect(new URL(cbRes.headers.get("location")!).pathname).toBe("/account");
    expect(cbRes.headers.get("set-cookie")).toContain("authgd_session=");

    const accounts = await ctx.db.select().from(account);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].tier).toBe("green");
    const chars = await ctx.db.select().from(character);
    expect(chars[0].id).toBe(90000001);
  });

  it("rejects an unknown or replayed state", async () => {
    const res = await callbackRoute(
      new NextRequest("http://localhost:3000/auth/eve/callback?code=abc&state=bogus"),
    );
    expectRedirect(res, "/login?error=oauth_expired");

    // full replay: consume once successfully, then reuse the same state
    const loginRes = await loginRoute(
      new NextRequest("http://localhost:3000/auth/eve/login"),
    );
    const state = new URL(loginRes.headers.get("location")!).searchParams.get("state")!;
    const jwt = await signToken(90000011, "oh-11");
    msw.use(
      http.post("https://login.eveonline.com/v2/oauth/token", () =>
        HttpResponse.json({ access_token: jwt, refresh_token: "rt" }),
      ),
    );
    const url = `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`;
    expect((await callbackRoute(new NextRequest(url))).status).toBe(307);
    // the replay is refused: same destination as any unusable state, and no
    // session cookie is issued a second time
    const replay = await callbackRoute(new NextRequest(url));
    expectRedirect(replay, "/login?error=oauth_expired");
    expect(replay.headers.get("set-cookie") ?? "").not.toContain("authgd_session=");
  });

  it("rejects an expired state", async () => {
    const loginRes = await loginRoute(
      new NextRequest("http://localhost:3000/auth/eve/login"),
    );
    const state = new URL(loginRes.headers.get("location")!).searchParams.get("state")!;
    const { oauthTransaction } = await import("@/db/schema");
    const { createHash } = await import("node:crypto");
    const { eq } = await import("drizzle-orm");
    // expire only the transaction under test
    const stateHash = createHash("sha256").update(state).digest("base64url");
    await ctx.db
      .update(oauthTransaction)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthTransaction.stateHash, stateHash));
    const res = await callbackRoute(
      new NextRequest(
        `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
      ),
    );
    expectRedirect(res, "/login?error=oauth_expired");
  });

  it("rejects a link-character transaction without its initiating session", async () => {
    // craft a link transaction directly, then hit the callback with no cookie
    const { createOauthTransaction } = await import("@/services/oauth-tx");
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const tx = await createOauthTransaction(ctx.db, {
      intent: "link-character",
      sessionId: "some-session",
      accountId: acc.id,
    });
    const jwt = await signToken(90000012, "oh-12");
    msw.use(
      http.post("https://login.eveonline.com/v2/oauth/token", () =>
        HttpResponse.json({ access_token: jwt, refresh_token: "rt" }),
      ),
    );
    const res = await callbackRoute(
      new NextRequest(
        `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(tx.state)}`,
      ),
    );
    // no cookie at all, so the missing session is what gets named
    expectRedirect(res, "/login?error=session_expired");
  });

  it("sends a member back to /login when the EVE token exchange fails", async () => {
    const loginRes = await loginRoute(
      new NextRequest("http://localhost:3000/auth/eve/login"),
    );
    const state = new URL(loginRes.headers.get("location")!).searchParams.get("state")!;
    // EVE is up enough to answer, but not with a token: the throw from
    // exchangeEveCode used to escape the route handler as a bare 500.
    msw.use(
      http.post("https://login.eveonline.com/v2/oauth/token", () =>
        HttpResponse.json({ error: "server_error" }, { status: 502 }),
      ),
    );
    const res = await callbackRoute(
      new NextRequest(
        `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(state)}`,
      ),
    );
    expectRedirect(res, "/login?error=oauth_failed");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("authgd_session=");
  });

  it("rejects a link-discord transaction presented to the EVE callback without consuming it", async () => {
    const { createOauthTransaction, consumeOauthTransaction } =
      await import("@/services/oauth-tx");
    const tx = await createOauthTransaction(ctx.db, { intent: "link-discord" });
    // no token-endpoint mock needed: rejection happens before any EVE call
    const res = await callbackRoute(
      new NextRequest(
        `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(tx.state)}`,
      ),
    );
    expectRedirect(res, "/login?error=oauth_expired");
    // the transaction survives for its rightful callback
    expect(
      await consumeOauthTransaction(ctx.db, tx.state, ["link-discord"]),
    ).not.toBeNull();
  });
});

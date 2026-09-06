import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  account,
  auditLog,
  character,
  oauthTransaction,
  outbox,
  session,
} from "@/db/schema";
import { getConfig } from "@/config";
import { decryptToken } from "@/lib/crypto";
import { consumeOauthTransaction, createOauthTransaction } from "@/services/oauth-tx";
import { createSession, endSession } from "@/services/session";
import { setupTestDb, TEST_URL, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";

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
process.env.DISCORD_ROLE_ID_MEMBER = "10";
process.env.DISCORD_ROLE_ID_ASSOCIATE = "11";
process.env.DISCORD_ROLE_ID_ALUMNI = "12";
process.env.WANDERER_BASE_URL = "https://w.example";
process.env.WANDERER_API_KEY = "k";
process.env.WANDERER_ACL_ID = "a";
process.env.ESI_CONTACT = "ops@example.com";
process.env.SYNC_MODE = "live";

const { GET: loginRoute } = await import("@/app/auth/eve/login/route");
const { GET: callbackRoute } = await import("@/app/auth/eve/callback/route");
const { GET: linkRoute } = await import("@/app/auth/eve/link/route");
const { ACCESS_LISTS_SCOPE } = await import("@/lib/esi/client");

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let signToken: (characterId: number, owner: string, scopes?: string[]) => Promise<string>;
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
  signToken = (characterId, owner, scopes = ["esi-characters.read_contacts.v1"]) =>
    new SignJWT({
      name: `Char ${characterId}`,
      owner,
      scp: scopes,
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
    expect(accounts[0].tier).toBe("pending");
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

  it("sends a refused merge to the code naming the blocker", async () => {
    // The service unit tests prove which blocker each guard reports, and the
    // route's Record<MergeBlocker, AccountErrorCode> proves every blocker has
    // copy. Neither proves the route READS result.blocker: a leftover
    // accountErrorUrl("already_linked") passes both. This closes that.
    const { createOauthTransaction } = await import("@/services/oauth-tx");
    const { createSession } = await import("@/services/session");
    const { eq } = await import("drizzle-orm");

    // A stray account holding the character, non-absorbable for exactly one
    // reason an admin can clear.
    const [stray] = await ctx.db
      .insert(account)
      .values({ statusNote: "keep an eye on this one" })
      .returning();
    await ctx.db.insert(character).values({
      id: 90000021,
      accountId: stray.id,
      name: "Stray",
      ownerHash: "oh-21",
    });

    const [main] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, main.id);
    const tx = await createOauthTransaction(ctx.db, {
      intent: "link-character",
      sessionId: sid,
      accountId: main.id,
    });

    // Same owner hash as the stray's character: the merge path, not a reclaim.
    const jwt = await signToken(90000021, "oh-21");
    msw.use(
      http.post("https://login.eveonline.com/v2/oauth/token", () =>
        HttpResponse.json({ access_token: jwt, refresh_token: "rt" }),
      ),
    );
    const req = new NextRequest(
      `http://localhost:3000/auth/eve/callback?code=abc&state=${encodeURIComponent(tx.state)}`,
    );
    req.cookies.set("authgd_session", sid);

    expectRedirect(await callbackRoute(req), "/account?error=merge_note");
    // and the refusal is a refusal: the character never moved
    const [still] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, 90000021));
    expect(still.accountId).toBe(stray.id);
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

describe("identity-bound Fleet Read routes", () => {
  const baseScope = "esi-characters.read_contacts.v1";
  const fleetScope = "esi-fleets.read_fleet.v1";
  const optionalScope = "esi-location.read_location.v1";
  beforeEach(async () => {
    await truncateAll(ctx.db);
    msw.resetHandlers();
  });

  async function fixture() {
    const cfg = getConfig();
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 90000101, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, {
      id: 90000102,
      accountId: acc.id,
      scopes: [baseScope, optionalScope],
    });
    const sid = await createSession(ctx.db, acc.id);
    return { acc, sid };
  }
  async function begin(sid: string | undefined, query = "character=90000102") {
    const { GET } = await import("@/app/auth/eve/fleet-read/route");
    const req = new NextRequest(`http://localhost:3000/auth/eve/fleet-read?${query}`);
    if (sid) req.cookies.set("authgd_session", sid);
    return GET(req);
  }
  function callback(state: string, sid?: string, query = "code=fleet-code") {
    const req = new NextRequest(
      `http://localhost:3000/auth/eve/callback?state=${state}&${query}`,
    );
    if (sid) req.cookies.set("authgd_session", sid);
    return callbackRoute(req);
  }
  function stateFrom(res: Response) {
    return new URL(res.headers.get("location")!).searchParams.get("state")!;
  }
  async function snapshot() {
    return {
      characters: await ctx.db.select().from(character).orderBy(character.id),
      accounts: await ctx.db.select().from(account).orderBy(account.id),
      audits: await ctx.db.select().from(auditLog),
      outbox: await ctx.db.select().from(outbox),
      sessions: await ctx.db.select().from(session).orderBy(session.id),
    };
  }
  async function tokenResponse(
    id = 90000102,
    owner = "oh-90000102",
    scopes = [baseScope, optionalScope, fleetScope],
    beforeReturn?: () => Promise<void>,
  ) {
    const jwt = await signToken(id, owner, scopes);
    let calls = 0;
    msw.use(
      http.post("https://login.eveonline.com/v2/oauth/token", async () => {
        calls++;
        await beforeReturn?.();
        return HttpResponse.json({ access_token: jwt, refresh_token: "fleet-refresh" });
      }),
    );
    return () => calls;
  }
  function noExchange() {
    let calls = 0;
    msw.use(
      http.post("https://login.eveonline.com/v2/oauth/token", () => {
        calls++;
        return HttpResponse.json({ error: "unexpected_exchange" }, { status: 500 });
      }),
    );
    return () => calls;
  }

  it("initiates for an owned non-main, preserving stored scopes and ignoring injected identity/scopes/return", async () => {
    const { acc, sid } = await fixture();
    const res = await begin(
      sid,
      "character=90000102&scope=evil&account=other&return=https://evil.example",
    );
    const authorize = new URL(res.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://login.eveonline.com/v2/oauth/authorize",
    );
    expect(authorize.searchParams.get("scope")!.split(" ")).toEqual([
      baseScope,
      optionalScope,
      fleetScope,
    ]);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const tx = await consumeOauthTransaction(ctx.db, stateFrom(res), [
      "grant-fleet-read",
    ]);
    expect(tx).toMatchObject({
      intent: "grant-fleet-read",
      fleetReadCharacterId: 90000102,
      accountId: acc.id,
      sessionId: sid,
    });
    expect(tx?.pkceVerifier).not.toBe(authorize.searchParams.get("code_challenge"));
  });

  it.each([
    "",
    "character=",
    "character=0",
    "character=-1",
    "character=1.5",
    "character=9007199254740992",
    "character=NaN",
    "character=90000102&character=90000101",
  ])("rejects invalid target query %s without creating state", async (query) => {
    const { sid } = await fixture();
    expectRedirect(
      await begin(sid, query),
      "/account/fleet-sharing?error=identity_changed",
    );
    expect(await ctx.db.select().from(oauthTransaction)).toHaveLength(0);
  });

  it("requires a live initiating session", async () => {
    const { sid } = await fixture();
    await endSession(ctx.db, sid);
    for (const cookie of [undefined, sid])
      expectRedirect(await begin(cookie), "/login?error=session_expired");
    expect(await ctx.db.select().from(oauthTransaction)).toHaveLength(0);
  });

  it.each(["pending", "associate", "alumni"] as const)(
    "refuses %s initiation, even for an admin",
    async (tier) => {
      const { acc, sid } = await fixture();
      await ctx.db
        .update(account)
        .set({ tier, isAdmin: true })
        .where(eq(account.id, acc.id));
      expectRedirect(await begin(sid), "/account/fleet-sharing?error=not_eligible");
      expect(await ctx.db.select().from(oauthTransaction)).toHaveLength(0);
    },
  );

  it("refuses an unowned target without creating state", async () => {
    const { sid } = await fixture();
    const other = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, getConfig(), { id: 90000103, accountId: other.id });
    expectRedirect(
      await begin(sid, "character=90000103"),
      "/account/fleet-sharing?error=identity_changed",
    );
    expect(await ctx.db.select().from(oauthTransaction)).toHaveLength(0);
  });

  it("old callback refuses without consuming or exchanging; new callback completes exactly once", async () => {
    const { sid } = await fixture();
    const state = stateFrom(await begin(sid));
    const before = await snapshot();
    const calls = await tokenResponse();
    // This is the previous callback's exact consume/reject branch. Its early
    // return cannot reach SSO, session creation or generic link/merge/reclaim.
    const legacy = async () => {
      const tx = await consumeOauthTransaction(ctx.db, state, [
        "login",
        "link-character",
      ]);
      if (!tx) return "/login?error=oauth_expired";
      throw new Error("targeted grant reached legacy identity mutation branch");
    };
    expect(await legacy()).toBe("/login?error=oauth_expired");
    expect(calls()).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect((await ctx.db.select().from(oauthTransaction))[0].consumedAt).toBeNull();
    const res = await callback(state, sid);
    expectRedirect(res, "/account/fleet-sharing?notice=authorized");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(calls()).toBe(1);
    const after = await snapshot();
    expect(after.accounts).toEqual(before.accounts);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.characters[0]).toEqual(before.characters[0]);
    expect(after.characters[1].scopes).toEqual([baseScope, optionalScope, fleetScope]);
    expect(
      decryptToken(after.characters[1].refreshTokenEnc!, getConfig().tokenEncryptionKey),
    ).toBe("fleet-refresh");
    expectRedirect(await callback(state, sid), "/login?error=oauth_expired");
    expect(calls()).toBe(1);
    expect(await snapshot()).toEqual(after);
  });

  it.each(["own-alt", "other-account", "unlinked"] as const)(
    "wrong picker selection (%s) never links, merges, reclaims or replaces tokens",
    async (choice) => {
      const { sid } = await fixture();
      const state = stateFrom(await begin(sid));
      let id = 90000101;
      if (choice !== "own-alt") id = 90000103;
      if (choice === "other-account") {
        const stray = await seedAccount(ctx.db);
        await seedCharacter(ctx.db, getConfig(), { id, accountId: stray.id, main: true });
      }
      const before = await snapshot();
      await tokenResponse(id, `oh-${id}`);
      expectRedirect(
        await callback(state, sid),
        "/account/fleet-sharing?error=wrong_character",
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(["absent", "same-account-new-session", "other-account", "expired"] as const)(
    "rejects %s callback session before SSO",
    async (change) => {
      const { acc, sid } = await fixture();
      const state = stateFrom(await begin(sid));
      let cookie: string | undefined;
      if (change === "same-account-new-session")
        cookie = await createSession(ctx.db, acc.id);
      if (change === "other-account")
        cookie = await createSession(ctx.db, (await seedAccount(ctx.db)).id);
      if (change === "expired") {
        await ctx.db
          .update(session)
          .set({ expiresAt: new Date(0) })
          .where(eq(session.accountId, acc.id));
        cookie = sid;
      }
      const before = await snapshot();
      const calls = noExchange();
      expectRedirect(
        await callback(state, cookie),
        "/account/fleet-sharing?error=authorization_expired",
      );
      expect(calls()).toBe(0);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    { fleetReadCharacterId: null },
    { fleetReadCharacterId: 0 },
    { fleetReadCharacterId: -1 },
    { fleetReadCharacterId: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: null },
    { sessionId: "" },
    { accountId: null },
  ])("malformed stored grant context %j fails closed before SSO", async (missing) => {
    const { sid } = await fixture();
    const state = stateFrom(await begin(sid));
    await ctx.db.update(oauthTransaction).set(missing);
    const before = await snapshot();
    const calls = noExchange();
    expectRedirect(
      await callback(state, sid),
      "/account/fleet-sharing?error=authorization_expired",
    );
    expect(calls()).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect((await ctx.db.select().from(oauthTransaction))[0].consumedAt).not.toBeNull();
  });

  it.each(["tier", "owner", "ownership", "session", "scopes"] as const)(
    "rechecks %s changed during SSO before storing credentials",
    async (change) => {
      const { acc, sid } = await fixture();
      const state = stateFrom(await begin(sid));
      let atReturn: Awaited<ReturnType<typeof snapshot>>;
      await tokenResponse(90000102, "oh-90000102", undefined, async () => {
        if (change === "tier")
          await ctx.db
            .update(account)
            .set({ tier: "alumni" })
            .where(eq(account.id, acc.id));
        if (change === "owner")
          await ctx.db
            .update(character)
            .set({ ownerHash: "new-owner" })
            .where(eq(character.id, 90000102));
        if (change === "ownership")
          await ctx.db
            .update(character)
            .set({ accountId: (await seedAccount(ctx.db)).id })
            .where(eq(character.id, 90000102));
        if (change === "session") await endSession(ctx.db, sid);
        if (change === "scopes")
          await ctx.db
            .update(character)
            .set({
              scopes: [baseScope, optionalScope, "esi-universe.read_structures.v1"],
            })
            .where(eq(character.id, 90000102));
        atReturn = await snapshot();
      });
      const code =
        change === "tier"
          ? "not_eligible"
          : change === "scopes"
            ? "scope_missing"
            : "identity_changed";
      expectRedirect(await callback(state, sid), `/account/fleet-sharing?error=${code}`);
      expect(await snapshot()).toEqual(atReturn!);
    },
  );

  it.each([baseScope, optionalScope, fleetScope])(
    "refuses missing actual scope %s without relabelling stale grants",
    async (missing) => {
      const { sid } = await fixture();
      const state = stateFrom(await begin(sid));
      const before = await snapshot();
      await tokenResponse(
        90000102,
        "oh-90000102",
        [baseScope, optionalScope, fleetScope].filter((s) => s !== missing),
      );
      expectRedirect(
        await callback(state, sid),
        "/account/fleet-sharing?error=scope_missing",
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it("cancellation consumes a valid bound grant once, without any SSO or identity changes", async () => {
    const { sid } = await fixture();
    const state = stateFrom(await begin(sid));
    const before = await snapshot();
    const calls = noExchange();
    expectRedirect(
      await callback(
        state,
        sid,
        "error=access_denied&code=ignored&return=https://evil.example",
      ),
      "/account/fleet-sharing?notice=authorization_cancelled",
    );
    expect(calls()).toBe(0);
    expect(await snapshot()).toEqual(before);
    expectRedirect(await callback(state, sid), "/login?error=oauth_expired");
  });

  it("cancellation without usable state retains generic login error behavior", async () => {
    const calls = noExchange();
    for (const query of ["error=access_denied", "error=access_denied&state=invalid"]) {
      expectRedirect(
        await callbackRoute(
          new NextRequest(`http://localhost:3000/auth/eve/callback?${query}`),
        ),
        "/login?error=oauth_denied",
      );
    }
    expect(calls()).toBe(0);
  });

  it("legacy cancellation leaves a login state available for its callback", async () => {
    const tx = await createOauthTransaction(ctx.db, { intent: "login" });
    expectRedirect(
      await callback(tx.state, undefined, "error=access_denied"),
      "/login?error=oauth_denied",
    );
    expect(await consumeOauthTransaction(ctx.db, tx.state, ["login"])).not.toBeNull();
  });

  it("SSO failure uses a fixed safe grant error and does not mutate credentials", async () => {
    const { sid } = await fixture();
    const state = stateFrom(await begin(sid));
    const before = await snapshot();
    noExchange();
    expectRedirect(
      await callback(state, sid),
      "/account/fleet-sharing?error=authorization_failed",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("rollback draining grants leaves ordinary login and link callbacks working", async () => {
    const { acc, sid } = await fixture();
    const state = stateFrom(await begin(sid));
    const login = await createOauthTransaction(ctx.db, { intent: "login" });
    const link = await createOauthTransaction(ctx.db, {
      intent: "link-character",
      sessionId: sid,
      accountId: acc.id,
    });
    await ctx.db
      .update(oauthTransaction)
      .set({ expiresAt: new Date(0) })
      .where(eq(oauthTransaction.intent, "grant-fleet-read"));
    const calls = await tokenResponse(90000103, "oh-90000103", [baseScope]);
    expectRedirect(await callback(state, sid), "/login?error=oauth_expired");
    expect(calls()).toBe(0);
    const loginRes = await callback(login.state);
    expectRedirect(loginRes, "/account");
    expect(loginRes.headers.get("set-cookie")).toContain("authgd_session=");
    // Same owner on the accidental login: generic linking may still merge it.
    expectRedirect(await callback(link.state, sid), "/account");
    const [linked] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, 90000103));
    expect(linked.accountId).toBe(acc.id);
    expect(calls()).toBe(2);
    const [grant] = await ctx.db
      .select()
      .from(oauthTransaction)
      .where(
        eq(
          oauthTransaction.stateHash,
          createHash("sha256").update(state).digest("base64url"),
        ),
      );
    expect(grant.consumedAt).toBeNull();
  });
});

describe("EVE link route — ?grant= is the only attacker-controllable input", () => {
  it("grant=access-lists asks EVE for the extra scope, alongside the base set", async () => {
    const { createSession } = await import("@/services/session");
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, acc.id);
    const req = new NextRequest("http://localhost:3000/auth/eve/link?grant=access-lists");
    req.cookies.set("authgd_session", sid);

    const res = await linkRoute(req);
    expect(res.status).toBe(307);
    const authorize = new URL(res.headers.get("location")!);
    const scopes = authorize.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain(ACCESS_LISTS_SCOPE);
    expect(scopes).toContain("esi-characters.read_contacts.v1");
  });

  it("grant=structures asks EVE for both structure scopes, and not the access-list one", async () => {
    const { createSession } = await import("@/services/session");
    const { STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE } = await import("@/lib/esi/client");
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, acc.id);
    const req = new NextRequest("http://localhost:3000/auth/eve/link?grant=structures");
    req.cookies.set("authgd_session", sid);

    const res = await linkRoute(req);
    expect(res.status).toBe(307);
    const authorize = new URL(res.headers.get("location")!);
    const scopes = authorize.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain(STRUCTURES_SCOPE);
    expect(scopes).toContain(NOTIFICATIONS_SCOPE);
    expect(scopes).not.toContain(ACCESS_LISTS_SCOPE);
  });

  it("an unknown grant value (not a known name, not a raw scope) asks for no extra scope", async () => {
    const { createSession } = await import("@/services/session");
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, acc.id);
    const req = new NextRequest(
      "http://localhost:3000/auth/eve/link?grant=esi-corporations.read_blueprints.v1",
    );
    req.cookies.set("authgd_session", sid);

    const res = await linkRoute(req);
    expect(res.status).toBe(307);
    const authorize = new URL(res.headers.get("location")!);
    const scopes = authorize.searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual(["esi-characters.read_contacts.v1"]);
  });

  it("does not throw or grant anything for a prototype-chain grant value", async () => {
    // GRANTS is a plain object literal, so `GRANTS[grant]` alone would throw
    // or return a function for these three -- they are inherited from
    // Object.prototype, not own keys. Object.hasOwn is the required guard,
    // not optional hardening.
    const { createSession } = await import("@/services/session");
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, acc.id);

    for (const grant of ["toString", "constructor", "__proto__"]) {
      const req = new NextRequest(
        `http://localhost:3000/auth/eve/link?grant=${encodeURIComponent(grant)}`,
      );
      req.cookies.set("authgd_session", sid);
      const res = await linkRoute(req);
      expect(res.status).toBe(307);
      const authorize = new URL(res.headers.get("location")!);
      const scopes = authorize.searchParams.get("scope")!.split(" ");
      expect(scopes).not.toContain(ACCESS_LISTS_SCOPE);
      expect(scopes).toEqual(["esi-characters.read_contacts.v1"]);
    }
  });

  it("any other grant value asks for no extra scope", async () => {
    const { createSession } = await import("@/services/session");
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, acc.id);

    for (const url of [
      "http://localhost:3000/auth/eve/link",
      "http://localhost:3000/auth/eve/link?grant=",
      "http://localhost:3000/auth/eve/link?grant=anything-else",
    ]) {
      const req = new NextRequest(url);
      req.cookies.set("authgd_session", sid);
      const res = await linkRoute(req);
      expect(res.status).toBe(307);
      const authorize = new URL(res.headers.get("location")!);
      const scopes = authorize.searchParams.get("scope")!.split(" ");
      expect(scopes).not.toContain(ACCESS_LISTS_SCOPE);
      expect(scopes).toContain("esi-characters.read_contacts.v1");
    }
  });

  it("grant=fleet-read asks EVE for the fleet scope, alongside the base set", async () => {
    const { createSession } = await import("@/services/session");
    const { FLEET_READ_SCOPE } = await import("@/lib/esi/client");
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, acc.id);
    const req = new NextRequest("http://localhost:3000/auth/eve/link?grant=fleet-read");
    req.cookies.set("authgd_session", sid);

    const res = await linkRoute(req);
    expect(res.status).toBe(307);
    const authorize = new URL(res.headers.get("location")!);
    const scopes = authorize.searchParams.get("scope")!.split(" ");
    expect(scopes).toContain(FLEET_READ_SCOPE);
    expect(scopes).toContain("esi-characters.read_contacts.v1");
  });

  it("a plain link (no grant) does not gain the fleet scope", async () => {
    const { createSession } = await import("@/services/session");
    const { FLEET_READ_SCOPE } = await import("@/lib/esi/client");
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const sid = await createSession(ctx.db, acc.id);
    const req = new NextRequest("http://localhost:3000/auth/eve/link");
    req.cookies.set("authgd_session", sid);

    const res = await linkRoute(req);
    expect(res.status).toBe(307);
    const authorize = new URL(res.headers.get("location")!);
    const scopes = authorize.searchParams.get("scope")!.split(" ");
    expect(scopes).not.toContain(FLEET_READ_SCOPE);
  });
});

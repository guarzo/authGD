import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { account, discordLink, outbox } from "@/db/schema";
import { linkDiscord } from "@/services/discord-link";
import { setupTestDb } from "./helpers/db";

// Route modules read config + db lazily via getConfig()/getDb(); set env first.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://authgd:authgd@localhost:5433/authgd_test";
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
process.env.WANDERER_MAP_SLUG = "m";
process.env.WANDERER_ACL_ID = "a";

// linkDiscord requires a DbTx; wrap every call in a transaction.

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() =>
  ctx.db.execute(sql`TRUNCATE account, discord_link, outbox RESTART IDENTITY CASCADE`),
);
afterAll(() => ctx.cleanup());

// helper: run linkDiscord in a transaction (DbTx required)
const ld = (accountId: string, discordUserId: string) =>
  ctx.db.transaction((tx) => linkDiscord(tx, accountId, discordUserId));

describe("linkDiscord", () => {
  it("links and writes outbox", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    expect(await ld(a.id, "duid-1")).toEqual({ ok: true });
    expect(await ctx.db.select().from(outbox)).toHaveLength(1);
  });

  it("rejects a discord user linked to another account", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    const [b] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-1");
    expect(await ld(b.id, "duid-1")).toEqual({
      ok: false,
      error: "already_linked",
    });
  });

  it("replacing its own link deprovisions the old discord user", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-1");
    await ctx.db.delete(outbox);
    expect(await ld(a.id, "duid-2")).toEqual({ ok: true });
    const rows = await ctx.db.select().from(discordLink);
    expect(rows).toHaveLength(1);
    expect(rows[0].discordUserId).toBe("duid-2");
    const payloads = (await ctx.db.select().from(outbox)).map((b) => b.payload);
    expect(payloads).toContainEqual({ kind: "discord-user", discordUserId: "duid-1" });
    expect(payloads).toContainEqual({ kind: "account", accountId: a.id });
  });

  it("concurrent replacements deprovision every intermediate discord user", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-0");
    await ctx.db.delete(outbox);
    await Promise.all([ld(a.id, "duid-A"), ld(a.id, "duid-B")]);
    const deprovisioned = (await ctx.db.select().from(outbox))
      .map((b) => b.payload)
      .filter((p) => p.kind === "discord-user")
      .map((p) => (p as { discordUserId: string }).discordUserId);
    const [final] = await ctx.db.select().from(discordLink);
    // duid-0 and whichever of A/B lost the race must both be deprovisioned
    const loser = final.discordUserId === "duid-A" ? "duid-B" : "duid-A";
    expect(deprovisioned).toContain("duid-0");
    expect(deprovisioned).toContain(loser);
  });

  it("concurrent cross-account claims of one discord user: one wins, one conflicts", async () => {
    const { DiscordLinkConflictError } = await import("@/services/discord-link");
    const [a] = await ctx.db.insert(account).values({}).returning();
    const [b] = await ctx.db.insert(account).values({}).returning();
    const results = await Promise.allSettled([ld(a.id, "duid-X"), ld(b.id, "duid-X")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // either the slow one saw the committed row (already_linked) or hit 23505
    if (rejected.length === 1) {
      expect(
        (rejected[0] as PromiseRejectedResult).reason,
      ).toBeInstanceOf(DiscordLinkConflictError);
      expect(fulfilled).toHaveLength(1);
    } else {
      const values = fulfilled.map((r) => (r as PromiseFulfilledResult<unknown>).value);
      expect(values).toContainEqual({ ok: false, error: "already_linked" });
    }
    expect(await ctx.db.select().from(discordLink)).toHaveLength(1);
  });
});

describe("discord callback route", () => {
  // Route-level coverage: state binding, session binding, and success path.
  it("links via the callback when session matches the transaction", async () => {
    const { GET: discordCallback } = await import("@/app/auth/discord/callback/route");
    const { createOauthTransaction } = await import("@/services/oauth-tx");
    const { createSession } = await import("@/services/session");
    const { NextRequest } = await import("next/server");
    const { http, HttpResponse } = await import("msw");
    const { setupServer } = await import("msw/node");

    const msw = setupServer(
      http.post("https://discord.com/api/oauth2/token", async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("code_verifier")).toBeTruthy();
        return HttpResponse.json({ access_token: "dt" });
      }),
      http.get("https://discord.com/api/users/@me", () =>
        HttpResponse.json({ id: "duid-route", username: "user" }),
      ),
    );
    msw.listen({ onUnhandledRequest: "error" });
    try {
      const [acc] = await ctx.db.insert(account).values({}).returning();
      const sid = await createSession(ctx.db, acc.id);
      const tx = await createOauthTransaction(ctx.db, {
        intent: "link-discord",
        sessionId: sid,
        accountId: acc.id,
      });
      const req = new NextRequest(
        `http://localhost:3000/auth/discord/callback?code=c&state=${encodeURIComponent(tx.state)}`,
        { headers: { cookie: `authgd_session=${sid}` } },
      );
      const res = await discordCallback(req);
      expect(res.status).toBe(307);
      const rows = await ctx.db.select().from(discordLink);
      expect(rows[0]?.discordUserId).toBe("duid-route");
    } finally {
      msw.close();
    }
  });

  it("rejects the callback without the initiating session", async () => {
    const { GET: discordCallback } = await import("@/app/auth/discord/callback/route");
    const { createOauthTransaction } = await import("@/services/oauth-tx");
    const { NextRequest } = await import("next/server");
    const [acc] = await ctx.db.insert(account).values({}).returning();
    const tx = await createOauthTransaction(ctx.db, {
      intent: "link-discord",
      sessionId: "sid-x",
      accountId: acc.id,
    });
    const res = await discordCallback(
      new NextRequest(
        `http://localhost:3000/auth/discord/callback?code=c&state=${encodeURIComponent(tx.state)}`,
      ),
    );
    expect(res.status).toBe(403);
  });
});

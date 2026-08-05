import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { account, auditLog, discordLink, outbox } from "@/db/schema";
import { linkDiscord, unlinkDiscord } from "@/services/discord-link";
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

// linkDiscord requires a DbTx; wrap every call in a transaction.

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() =>
  ctx.db.execute(
    sql`TRUNCATE account, discord_link, outbox, audit_log RESTART IDENTITY CASCADE`,
  ),
);
afterAll(() => ctx.cleanup());

// helper: run linkDiscord in a transaction (DbTx required)
const ld = (accountId: string, discordUserId: string) =>
  ctx.db.transaction((tx) => linkDiscord(tx, accountId, discordUserId));

// helper: run unlinkDiscord in a transaction (DbTx required)
const ud = (actor: string, accountId: string, reason: "self" | "admin" = "self") =>
  ctx.db.transaction((tx) => unlinkDiscord(tx, actor, accountId, reason));

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
      expect(rejected[0].reason).toBeInstanceOf(DiscordLinkConflictError);
      expect(fulfilled).toHaveLength(1);
    } else {
      const values = fulfilled.map((r) => (r as PromiseFulfilledResult<unknown>).value);
      expect(values).toContainEqual({ ok: false, error: "already_linked" });
    }
    expect(await ctx.db.select().from(discordLink)).toHaveLength(1);
  });
});

describe("unlinkDiscord", () => {
  it("deletes the link and enqueues the deprovision", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-1");
    await ctx.db.delete(outbox);

    expect(await ud(a.id, a.id)).toEqual({ ok: true });
    expect(await ctx.db.select().from(discordLink)).toHaveLength(0);

    const payloads = (await ctx.db.select().from(outbox)).map((b) => b.payload);
    expect(payloads).toContainEqual({ kind: "discord-user", discordUserId: "duid-1" });
    // No new Discord user to provision, and contacts/wanderer do not depend on
    // Discord state, so an {kind:"account"} row here would be work for nothing.
    expect(payloads).toHaveLength(1);
  });

  it("writes an audit row naming who unlinked and why", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    const [admin] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-1");

    expect(await ud(admin.id, a.id, "admin")).toEqual({ ok: true });

    const rows = (await ctx.db.select().from(auditLog)).filter(
      (r) => r.action === "discord.unlinked",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(admin.id);
    // The freed discord user, not the account: matches the replacement path.
    expect(rows[0].target).toBe("duid-1");
    expect(rows[0].details).toEqual({ reason: "admin" });
  });

  it("reports an account that has no link", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    expect(await ud(a.id, a.id)).toEqual({ ok: false, error: "not_linked" });
    expect(await ctx.db.select().from(outbox)).toHaveLength(0);
  });

  it("reports an account that no longer exists", async () => {
    const gone = "00000000-0000-4000-8000-000000000000";
    expect(await ud(gone, gone)).toEqual({ ok: false, error: "not_found" });
  });

  // The account-row FOR UPDATE lock is the basis of the whole design, and the
  // sequential cases above never exercise it. Both operations lock the SAME
  // account row, so unlike the cross-account link race above they serialize
  // rather than conflict: neither is allowed to throw, and neither is allowed
  // to return an error. Promise.all, not allSettled — a rejection here is a
  // failure of the design, not an outcome to tolerate.
  it("concurrent link and unlink leave a consistent link and deprovision set", async () => {
    const [a] = await ctx.db.insert(account).values({}).returning();
    await ld(a.id, "duid-1");
    await ctx.db.delete(outbox);

    const [linked, unlinked] = await Promise.all([ld(a.id, "duid-2"), ud(a.id, a.id)]);
    // Whichever order the lock granted, both operations had work to do:
    // unlink-then-link finds duid-1 to free and then links duid-2;
    // link-then-unlink replaces duid-1 with duid-2 and then frees duid-2.
    expect(linked).toEqual({ ok: true });
    expect(unlinked).toEqual({ ok: true });

    const links = await ctx.db.select().from(discordLink);
    const deprovisioned = (await ctx.db.select().from(outbox))
      .map((b) => b.payload)
      .filter((p) => p.kind === "discord-user")
      .map((p) => (p as { discordUserId: string }).discordUserId);

    if (links.length === 0) {
      // unlink ran last: whatever it freed must be deprovisioned.
      expect(deprovisioned).toContain("duid-2");
    } else {
      // link ran last: it survives, and it must NOT be deprovisioned.
      expect(links[0].discordUserId).toBe("duid-2");
      expect(deprovisioned).not.toContain("duid-2");
    }
    // duid-1 is freed in either ordering.
    expect(deprovisioned).toContain("duid-1");
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
        HttpResponse.json({ id: "123456789012345678", username: "user" }),
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
      expect(rows[0]?.discordUserId).toBe("123456789012345678");
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
    // no cookie on the request, so the missing session is what gets named
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/login?error=session_expired",
    );
  });
});

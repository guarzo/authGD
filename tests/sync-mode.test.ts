import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadConfig } from "@/config";
import { auditLog, character } from "@/db/schema";
import { runDiscordRolesJob } from "@/jobs/discord-roles";
import { runTokenHealthJob } from "@/jobs/token-health";
import { runWandererJob } from "@/jobs/wanderer";
import { createDiscordClient, type DiscordClient } from "@/lib/discord/rest";
import { createEsiClient } from "@/lib/esi/client";
import { postOpsWebhook, postOpsWebhookOrThrow } from "@/lib/ops-webhook";
import {
  createWandererClient,
  type WandererAclMember,
  type WandererClient,
} from "@/lib/wanderer/client";
import { getFreshAccessToken } from "@/services/tokens";
import { testConfig } from "./helpers/config";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";

/**
 * The dry-run safety guard (spec 2026-08-03-local-dev-setup.md).
 *
 * These tests exist because the failure they prevent is silent and
 * irreversible: a local worker holding real credentials deleting a developer's
 * in-game contacts, reconciling a live ACL, or rotating a production refresh
 * token. Every assertion is "no request was issued" or "no audit row was
 * written" — absence, not behavior.
 */

const liveCfg = testConfig(); // helper defaults to live (spec D10)
const dryCfg = testConfig({ SYNC_MODE: "dry-run" });

// onUnhandledRequest: "error" is the real assertion in the client sections: a
// suppressed write that leaks through fails the test even without a spy.
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("SYNC_MODE config", () => {
  it("is required — a missing value fails startup", () => {
    const { SYNC_MODE: _omitted, ...rest } = {
      ...process.env,
      DATABASE_URL: "postgres://x/y",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      APP_BASE_URL: "https://auth.example",
      ALLIANCE_ID: "99000001",
      EVE_SSO_CLIENT_ID: "c",
      EVE_SSO_CLIENT_SECRET: "s",
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
      SYNC_MODE: "live",
    };
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/SYNC_MODE/);
  });

  it("rejects a value that is neither live nor dry-run", () => {
    expect(() => testConfig({ SYNC_MODE: "readonly" })).toThrow(/SYNC_MODE/);
  });

  it("accepts both valid modes", () => {
    expect(testConfig({ SYNC_MODE: "live" }).syncMode).toBe("live");
    expect(testConfig({ SYNC_MODE: "dry-run" }).syncMode).toBe("dry-run");
  });
});

describe("wanderer client guard", () => {
  const ACL = "https://wanderer.example/api/acls/acl-1";
  const MEMBERS = `${ACL}/members`;

  it("issues no request for add/remove/role-change in dry-run", async () => {
    let writes = 0;
    server.use(
      http.post(MEMBERS, () => {
        writes++;
        return HttpResponse.json({});
      }),
      http.put(`${MEMBERS}/:id`, () => {
        writes++;
        return HttpResponse.json({});
      }),
      http.delete(`${MEMBERS}/:id`, () => {
        writes++;
        return HttpResponse.json({ ok: true });
      }),
    );
    const w = createWandererClient(dryCfg);
    await w.addAclMember(90000001);
    await w.removeAclMember(90000002);
    await w.updateAclMemberRole(90000003, "member");
    expect(writes).toBe(0);
  });

  it("still issues those requests in live mode", async () => {
    let writes = 0;
    server.use(
      http.post(MEMBERS, () => {
        writes++;
        return HttpResponse.json({});
      }),
      http.delete(`${MEMBERS}/:id`, () => {
        writes++;
        return HttpResponse.json({ ok: true });
      }),
    );
    const w = createWandererClient(liveCfg);
    await w.addAclMember(90000001);
    await w.removeAclMember(90000002);
    expect(writes).toBe(2);
  });

  it("does NOT suppress reads — the diff must stay real", async () => {
    let reads = 0;
    server.use(
      http.get(ACL, () => {
        reads++;
        return HttpResponse.json({ data: { members: [] } });
      }),
    );
    await createWandererClient(dryCfg).getAclMembers();
    expect(reads).toBe(1);
  });
});

describe("discord client guard", () => {
  const ROLE = "https://discord.com/api/v10/guilds/9000/members/:user/roles/:role";

  it("issues no role add/remove in dry-run", async () => {
    let writes = 0;
    server.use(
      http.put(ROLE, () => {
        writes++;
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(ROLE, () => {
        writes++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const d = createDiscordClient(dryCfg);
    await d.addMemberRole("u1", "10");
    await d.removeMemberRole("u1", "11");
    expect(writes).toBe(0);
  });

  it("still issues them in live mode", async () => {
    let writes = 0;
    server.use(
      http.put(ROLE, () => {
        writes++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await createDiscordClient(liveCfg).addMemberRole("u1", "10");
    expect(writes).toBe(1);
  });
});

describe("esi client guard", () => {
  const CONTACTS = "https://esi.evetech.net/latest/characters/90000001/contacts/";

  it("issues no contact add/edit/delete in dry-run", async () => {
    let writes = 0;
    const count = () => {
      writes++;
      return HttpResponse.json([]);
    };
    server.use(
      http.post(CONTACTS, count),
      http.put(CONTACTS, count),
      http.delete(CONTACTS, count),
    );
    const esi = createEsiClient({ syncMode: "dry-run" });
    await esi.addContacts(90000001, "tok", [1, 2], 5, [7]);
    await esi.editContacts(90000001, "tok", [3], 5, [7]);
    await esi.deleteContacts(90000001, "tok", [4]);
    expect(writes).toBe(0);
  });

  it("still issues them when syncMode is omitted (defaults to live)", async () => {
    let writes = 0;
    server.use(
      http.post(CONTACTS, () => {
        writes++;
        return HttpResponse.json([]);
      }),
    );
    await createEsiClient().addContacts(90000001, "tok", [1], 5, [7]);
    expect(writes).toBe(1);
  });
});

describe("ops webhook guard (D9)", () => {
  it("posts nothing in dry-run", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await postOpsWebhook(dryCfg, "alert", fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("postOpsWebhookOrThrow RESOLVES when suppressed — throwing would make the dead-letter handler retry forever", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      postOpsWebhookOrThrow(dryCfg, "alert", fetchImpl as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("token refresh guard (D4)", () => {
  let ctx: Awaited<ReturnType<typeof setupTestDb>>;
  beforeAll(async () => {
    ctx = await setupTestDb();
  });
  afterAll(() => ctx.cleanup());
  beforeEach(() => truncateAll(ctx.db));

  it("refuses the refresh and leaves the stored token untouched", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, dryCfg, {
      id: 90000001,
      accountId: acc.id,
      refreshToken: "the-real-refresh-token",
    });
    const [before] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, 90000001));

    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await getFreshAccessToken(
      ctx.db,
      dryCfg,
      { id: 90000001, refreshTokenEnc: before.refreshTokenEnc, tokenStatus: "valid" },
      fetchImpl,
    );

    expect(result).toEqual({ ok: false, reason: "dry_run" });
    // EVE rotates on use — the whole point is that this call never happened.
    expect(fetchImpl).not.toHaveBeenCalled();
    const [after] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, 90000001));
    expect(after.refreshTokenEnc).toBe(before.refreshTokenEnc);
    expect(after.tokenStatus).toBe("valid");
  });
});

describe("job reporting honesty in dry-run", () => {
  let ctx: Awaited<ReturnType<typeof setupTestDb>>;
  beforeAll(async () => {
    ctx = await setupTestDb();
  });
  afterAll(() => ctx.cleanup());
  beforeEach(() => truncateAll(ctx.db));

  it("token-health counts a suppressed refresh as skipped, never invalid", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, dryCfg, { id: 90000001, accountId: acc.id });
    const result = await runTokenHealthJob({ db: ctx.db, cfg: dryCfg });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ skipped: 1, invalid: 0 });
    const [after] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, 90000001));
    expect(after.tokenStatus).toBe("valid");
  });

  it("wanderer writes NO audit rows in dry-run and reports would* counters", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, dryCfg, {
      id: 90000001,
      accountId: acc.id,
      main: true,
      allianceId: dryCfg.allianceId,
    });
    const members: WandererAclMember[] = [{ characterId: 90000009, role: "member" }];
    const client: WandererClient = {
      getAclMembers: async () => [...members],
      addAclMember: async () => {},
      updateAclMemberRole: async () => {},
      removeAclMember: async () => {},
    };
    const result = await runWandererJob({ db: ctx.db, cfg: dryCfg, wanderer: client });

    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ wouldAdd: 1, wouldRemove: 1 });
    // The applied-change names must be absent, not merely zero.
    expect(result.counts).not.toHaveProperty("added");
    expect(result.counts).not.toHaveProperty("removed");
    const audits = await ctx.db.select().from(auditLog);
    expect(audits).toEqual([]);
  });

  it("discord-roles writes NO audit rows in dry-run and reports wouldChangeRoles", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd", discordUserId: "u1" });
    await seedCharacter(ctx.db, dryCfg, { id: 90000001, accountId: acc.id, main: true });
    const client: DiscordClient = {
      getGuildRoles: async () => [
        { id: "10", name: "FlyGD", position: 5, permissions: "0" },
        { id: "11", name: "Blue", position: 4, permissions: "0" },
        { id: "12", name: "Green", position: 3, permissions: "0" },
        { id: "bot-role", name: "Bot", position: 9, permissions: "268435456" },
      ],
      getBotUserId: async () => "bot-user",
      getGuildMember: async (userId) =>
        userId === "bot-user" ? { roles: ["bot-role"] } : { roles: ["11"] },
      addMemberRole: async () => {},
      removeMemberRole: async () => {},
    };
    const result = await runDiscordRolesJob({ db: ctx.db, cfg: dryCfg, discord: client });

    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ wouldChangeRoles: 1 });
    expect(result.counts).not.toHaveProperty("changed");
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "discord.role_changed")).toBe(false);
  });

  // The deprovision branch (opts.discordUserId, an UNLINKED user) is a second
  // audit-writing path with its own counter, reached only when the discord user
  // has no link row. It needs its own dry-run assertion — the main-path test
  // above never enters it.
  it("discord-roles deprovision path writes NO audit rows in dry-run and reports wouldRemove", async () => {
    const client: DiscordClient = {
      getGuildRoles: async () => [
        { id: "10", name: "FlyGD", position: 5, permissions: "0" },
        { id: "11", name: "Blue", position: 4, permissions: "0" },
        { id: "12", name: "Green", position: 3, permissions: "0" },
        { id: "bot-role", name: "Bot", position: 9, permissions: "268435456" },
      ],
      getBotUserId: async () => "bot-user",
      getGuildMember: async (userId) =>
        userId === "bot-user" ? { roles: ["bot-role"] } : { roles: ["10", "11", "999"] },
      addMemberRole: async () => {},
      removeMemberRole: async () => {},
    };
    const result = await runDiscordRolesJob(
      { db: ctx.db, cfg: dryCfg, discord: client },
      { discordUserId: "u-unlinked" },
    );

    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ wouldRemove: 2 }); // 999 is unmanaged
    expect(result.counts).not.toHaveProperty("removed");
    const audits = await ctx.db.select().from(auditLog);
    expect(audits).toEqual([]);
  });
});

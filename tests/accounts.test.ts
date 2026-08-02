import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@/config";
import { account, auditLog, bootstrapAdminGrant, character, outbox, session } from "@/db/schema";
import {
  demoteAdmin,
  handleEveLogin,
  linkCharacter,
  maybeGrantBootstrapAdmin,
  setMainCharacter,
  unlinkCharacter,
  type EveCallbackCharacter,
} from "@/services/accounts";
import { createSession, getSessionAccount } from "@/services/session";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let cfg: Config;

const ch = (over: Partial<EveCallbackCharacter> = {}): EveCallbackCharacter => ({
  characterId: 90000001,
  characterName: "Pilot One",
  ownerHash: "oh-1",
  scopes: ["esi-characters.read_contacts.v1", "esi-characters.write_contacts.v1"],
  refreshToken: "rt-1",
  ...over,
});

beforeAll(async () => {
  ctx = await setupTestDb();
  cfg = loadConfig({
    ...process.env,
    DATABASE_URL: "postgres://x/y",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    APP_BASE_URL: "http://localhost:3000",
    ALLIANCE_ID: "99000001",
    BOOTSTRAP_ADMIN_CHARACTER_IDS: "90000009",
    EVE_SSO_CLIENT_ID: "c",
    EVE_SSO_CLIENT_SECRET: "s",
    EVE_SSO_SCOPES: "esi-characters.read_contacts.v1 esi-characters.write_contacts.v1",
    DISCORD_CLIENT_ID: "d",
    DISCORD_CLIENT_SECRET: "d",
    DISCORD_BOT_TOKEN: "d",
    DISCORD_GUILD_ID: "1",
    DISCORD_ROLE_ID_FLYGD: "10",
    DISCORD_ROLE_ID_BLUE: "11",
    DISCORD_ROLE_ID_GREEN: "12",
    WANDERER_BASE_URL: "https://w.example",
    WANDERER_API_KEY: "k",
    WANDERER_MAP_SLUG: "m",
    WANDERER_ACL_ID: "a",
  } as NodeJS.ProcessEnv);
});
beforeEach(async () => {
  const { sql } = await import("drizzle-orm");
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});
afterAll(() => ctx.cleanup());

// Identity mutations require a transaction (DbTx); these helpers wrap each call.
const login = (c: EveCallbackCharacter) =>
  ctx.db.transaction((tx) => handleEveLogin(tx, cfg, c));
const link = (accountId: string, c: EveCallbackCharacter) =>
  ctx.db.transaction((tx) => linkCharacter(tx, cfg, accountId, c));
const unlink = (actor: string, characterId: number) =>
  ctx.db.transaction((tx) => unlinkCharacter(tx, cfg, actor, characterId));
const setMain = (accountId: string, characterId: number) =>
  ctx.db.transaction((tx) => setMainCharacter(tx, accountId, characterId));
const demote = (actor: string, accountId: string) =>
  ctx.db.transaction((tx) => demoteAdmin(tx, actor, accountId));

describe("handleEveLogin", () => {
  it("creates a pessimistic green account with outbox + audit", async () => {
    const { accountId } = await login(ch());
    const [acc] = await ctx.db.select().from(account).where(eq(account.id, accountId));
    expect(acc.tier).toBe("green");
    expect(acc.tierLocked).toBe(false);
    expect(acc.mainCharacterId).toBe(90000001);

    const [chr] = await ctx.db.select().from(character);
    expect(chr.tokenStatus).toBe("valid");
    expect(chr.refreshTokenEnc).not.toBe("rt-1"); // encrypted

    const boxes = await ctx.db.select().from(outbox);
    expect(boxes.map((b) => b.payload)).toContainEqual({
      kind: "account",
      accountId,
    });
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "account.created")).toBe(true);
  });

  it("logs into the existing account on re-auth with same owner", async () => {
    const first = await login(ch());
    const again = await login(ch({ refreshToken: "rt-2" }));
    expect(again.accountId).toBe(first.accountId);
    expect((await ctx.db.select().from(account))).toHaveLength(1);
  });

  it("reclaims a sold character: unlinks, demotes old account, revokes its sessions", async () => {
    const old = await login(ch());
    // make old account flygd so we can observe demotion
    await ctx.db
      .update(account)
      .set({ tier: "flygd" })
      .where(eq(account.id, old.accountId));
    const sid = await createSession(ctx.db, old.accountId);

    const bought = await login(ch({ ownerHash: "oh-NEW" }));
    expect(bought.accountId).not.toBe(old.accountId);

    const [oldAcc] = await ctx.db.select().from(account).where(eq(account.id, old.accountId));
    expect(oldAcc.mainCharacterId).toBeNull();
    expect(oldAcc.tier).toBe("green");
    expect(await getSessionAccount(ctx.db, sid)).toBeNull();

    const [chr] = await ctx.db.select().from(character);
    expect(chr.accountId).toBe(bought.accountId);
    expect(chr.ownerHash).toBe("oh-NEW");
  });
});

describe("linkCharacter", () => {
  it("links an alt and rejects double-link with same owner", async () => {
    const a = await login(ch());
    const b = await login(ch({ characterId: 90000002, ownerHash: "oh-2", characterName: "Other" }));

    const alt = ch({ characterId: 90000003, characterName: "Alt", ownerHash: "oh-1" });
    expect(await link(a.accountId, alt)).toEqual({ ok: true });

    // same character, same owner, other account → rejected
    const res = await link(b.accountId, alt);
    expect(res).toEqual({ ok: false, error: "already_linked" });
  });

  it("does not demote a tier_locked account on main unlink", async () => {
    const a = await login(ch());
    await ctx.db
      .update(account)
      .set({ tier: "blue", tierLocked: true })
      .where(eq(account.id, a.accountId));
    await unlink("system", 90000001);
    const [acc] = await ctx.db.select().from(account);
    expect(acc.tier).toBe("blue");
    expect(acc.mainCharacterId).toBeNull();
  });
});

describe("transaction rollback", () => {
  it("leaves no partial state when the transaction throws after linking", async () => {
    const a = await login(ch());
    const auditCountBefore = (await ctx.db.select().from(auditLog)).length;
    const outboxCountBefore = (await ctx.db.select().from(outbox)).length;
    await expect(
      ctx.db.transaction(async (tx) => {
        await linkCharacter(tx, cfg, a.accountId, ch({ characterId: 90000050, characterName: "Doomed" }));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const chars = await ctx.db.select().from(character);
    expect(chars.map((c) => c.id)).toEqual([90000001]); // no orphan character
    expect(await ctx.db.select().from(auditLog)).toHaveLength(auditCountBefore);
    expect(await ctx.db.select().from(outbox)).toHaveLength(outboxCountBefore);
  });
});

describe("concurrent first login", () => {
  it("two simultaneous logins for one new character yield one account", async () => {
    const results = await Promise.all([login(ch()), login(ch())]);
    expect(results[0].accountId).toBe(results[1].accountId);
    expect(await ctx.db.select().from(account)).toHaveLength(1);
    expect(await ctx.db.select().from(character)).toHaveLength(1);
  });

  it("two concurrent links of different new characters onto the same account both succeed", async () => {
    const a = await login(ch());
    const [r1, r2] = await Promise.all([
      link(a.accountId, ch({ characterId: 90000010, characterName: "Alt1", ownerHash: "oh-1" })),
      link(a.accountId, ch({ characterId: 90000011, characterName: "Alt2", ownerHash: "oh-1" })),
    ]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    const chars = await ctx.db
      .select()
      .from(character)
      .where(eq(character.accountId, a.accountId));
    expect(chars.map((c) => c.id).sort()).toEqual([90000001, 90000010, 90000011]);
  });
});

describe("setMainCharacter", () => {
  it("sets main and writes an outbox row", async () => {
    const a = await login(ch());
    await link(a.accountId, ch({ characterId: 90000003, characterName: "Alt" }));
    await ctx.db.delete(outbox);
    await setMain(a.accountId, 90000003);
    const [acc] = await ctx.db.select().from(account);
    expect(acc.mainCharacterId).toBe(90000003);
    expect(await ctx.db.select().from(outbox)).toHaveLength(1);
  });

  it("rejects characters not on the account", async () => {
    const a = await login(ch());
    await expect(setMain(a.accountId, 99999999)).rejects.toThrow();
  });
});

describe("re-auth side effects", () => {
  it("audits, enqueues, and downgrades status when scopes shrink", async () => {
    const a = await login(ch());
    await ctx.db.delete(outbox);
    await login(
      ch({ refreshToken: "rt-2", scopes: ["esi-characters.read_contacts.v1"] }), // missing write scope
    );
    const [chr] = await ctx.db.select().from(character);
    expect(chr.tokenStatus).toBe("needs_reauth");
    expect(await ctx.db.select().from(outbox)).toHaveLength(1);
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((x) => x.action === "character.reauthed")).toBe(true);
  });
});

describe("bootstrap admin", () => {
  it("grants on first login of a bootstrap character, never after transfer", async () => {
    const a = await login(ch({ characterId: 90000009, ownerHash: "oh-boss" }));
    const [acc] = await ctx.db.select().from(account).where(eq(account.id, a.accountId));
    expect(acc.isAdmin).toBe(true); // granted inside the service, no extra call

    // sold: new owner logs in → reclaim makes a new account; grant must NOT fire again
    const b = await login(ch({ characterId: 90000009, ownerHash: "oh-thief" }));
    const [bAcc] = await ctx.db.select().from(account).where(eq(account.id, b.accountId));
    expect(bAcc.isAdmin).toBe(false);
  });

  it("grants when a bootstrap character is linked as an alt", async () => {
    const a = await login(ch()); // non-bootstrap main
    let [acc] = await ctx.db.select().from(account).where(eq(account.id, a.accountId));
    expect(acc.isAdmin).toBe(false);
    await link(
      a.accountId,
      ch({ characterId: 90000009, ownerHash: "oh-1", characterName: "Boss Alt" }),
    );
    [acc] = await ctx.db.select().from(account).where(eq(account.id, a.accountId));
    expect(acc.isAdmin).toBe(true);
  });

  it("ignores non-bootstrap characters", async () => {
    const a = await login(ch());
    expect(
      await ctx.db.transaction((tx) =>
        maybeGrantBootstrapAdmin(tx, cfg, a.accountId, {
          characterId: 90000001,
          ownerHash: "oh-1",
        }),
      ),
    ).toBe(false);
  });
});

describe("demoteAdmin", () => {
  it("refuses to demote the last admin", async () => {
    const a = await login(ch());
    await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, a.accountId));
    expect(await demote("system", a.accountId)).toEqual({
      ok: false,
      error: "last_admin",
    });
  });

  it("demotes when another admin exists", async () => {
    const a = await login(ch());
    const b = await login(ch({ characterId: 90000002, ownerHash: "oh-2", characterName: "B" }));
    await ctx.db.update(account).set({ isAdmin: true });
    expect(await demote("system", b.accountId)).toEqual({ ok: true });
  });

  it("never lets two concurrent demotions remove both admins", async () => {
    const a = await login(ch());
    const b = await login(ch({ characterId: 90000002, ownerHash: "oh-2", characterName: "B" }));
    await ctx.db.update(account).set({ isAdmin: true });

    const [r1, r2] = await Promise.all([
      ctx.db.transaction((tx) => demoteAdmin(tx, a.accountId, b.accountId)),
      ctx.db.transaction((tx) => demoteAdmin(tx, b.accountId, a.accountId)),
    ]);
    // exactly one demotion succeeds; at least one admin always remains
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const admins = await ctx.db.select().from(account).where(eq(account.isAdmin, true));
    expect(admins.length).toBeGreaterThanOrEqual(1);
  });
});

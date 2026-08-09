import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@/config";
import {
  account,
  auditLog,
  character,
  contactSyncState,
  discordLink,
  outbox,
  payoutOperation,
  payoutParticipant,
  payoutPayment,
  session,
} from "@/db/schema";
import {
  demoteAdmin,
  handleEveLogin,
  linkCharacter,
  maybeGrantBootstrapAdmin,
  promoteAdmin,
  setMainCharacter,
  unlinkCharacter,
  wakeSelf,
  type EveCallbackCharacter,
  type MergeBlocker,
} from "@/services/accounts";
import { createSession, getSessionAccount } from "@/services/session";
import { decryptToken } from "@/lib/crypto";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";

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
    DISCORD_ROLE_ID_MEMBER: "10",
    DISCORD_ROLE_ID_ASSOCIATE: "11",
    DISCORD_ROLE_ID_ALUMNI: "12",
    WANDERER_BASE_URL: "https://w.example",
    WANDERER_API_KEY: "k",
    WANDERER_ACL_ID: "a",
    ESI_CONTACT: "ops@example.com",
    SYNC_MODE: "live",
  });
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());

// Identity mutations require a transaction (DbTx); these helpers wrap each call.
const login = (c: EveCallbackCharacter) =>
  ctx.db.transaction((tx) => handleEveLogin(tx, cfg, c));
const link = (accountId: string, c: EveCallbackCharacter) =>
  ctx.db.transaction((tx) => linkCharacter(tx, cfg, accountId, c));
const unlink = (actor: string, characterId: number) =>
  ctx.db.transaction((tx) => unlinkCharacter(tx, cfg, actor, characterId));
const setMain = (accountId: string, characterId: number, actor = accountId) =>
  ctx.db.transaction((tx) => setMainCharacter(tx, actor, accountId, characterId));
const demote = (actor: string, accountId: string) =>
  ctx.db.transaction((tx) => demoteAdmin(tx, actor, accountId));
const wake = (accountId: string) => ctx.db.transaction((tx) => wakeSelf(tx, accountId));

describe("handleEveLogin", () => {
  it("creates a pending account with outbox + audit, not an alumni one", async () => {
    const { accountId } = await login(ch());
    const [acc] = await ctx.db.select().from(account).where(eq(account.id, accountId));
    // Pending, not alumni: a first login grants no tier and no Discord role.
    // The membership sync promotes it to member once it confirms the main is in
    // the alliance; anyone else waits for an admin.
    expect(acc.tier).toBe("pending");
    expect(acc.tierLocked).toBe(false);
    expect(acc.mainCharacterId).toBe(90000001);

    const [chr] = await ctx.db.select().from(character);
    expect(chr.tokenStatus).toBe("valid");
    // stored encrypted, and decrypts back to the original token
    expect(decryptToken(chr.refreshTokenEnc!, cfg.tokenEncryptionKey)).toBe("rt-1");

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
    expect(await ctx.db.select().from(account)).toHaveLength(1);
  });

  it("reclaims a sold character: unlinks, demotes old account, revokes its sessions", async () => {
    const old = await login(ch());
    // make old account member so we can observe demotion
    await ctx.db
      .update(account)
      .set({ tier: "member" })
      .where(eq(account.id, old.accountId));
    const sid = await createSession(ctx.db, old.accountId);

    const bought = await login(ch({ ownerHash: "oh-NEW" }));
    expect(bought.accountId).not.toBe(old.accountId);

    const [oldAcc] = await ctx.db
      .select()
      .from(account)
      .where(eq(account.id, old.accountId));
    expect(oldAcc.mainCharacterId).toBeNull();
    expect(oldAcc.tier).toBe("alumni");
    expect(await getSessionAccount(ctx.db, sid)).toBeNull();

    const [chr] = await ctx.db.select().from(character);
    expect(chr.accountId).toBe(bought.accountId);
    expect(chr.ownerHash).toBe("oh-NEW");
  });
});

describe("linkCharacter", () => {
  it("links an alt and rejects double-link with same owner", async () => {
    const a = await login(ch());
    const b = await login(
      ch({ characterId: 90000002, ownerHash: "oh-2", characterName: "Other" }),
    );

    const alt = ch({ characterId: 90000003, characterName: "Alt", ownerHash: "oh-1" });
    expect(await link(a.accountId, alt)).toEqual({ ok: true });

    // same character, same owner, other account → rejected. Account a holds
    // its own main as well as the alt, so the count guard is what refuses.
    const res = await link(b.accountId, alt);
    expect(res).toEqual({ ok: false, error: "already_linked", blocker: "characters" });
  });

  it("does not demote a tier_locked account on main unlink", async () => {
    const a = await login(ch());
    // second character so the main unlink isn't blocked as last_character
    await link(a.accountId, ch({ characterId: 90000004, characterName: "Spare" }));
    await ctx.db
      .update(account)
      .set({ tier: "associate", tierLocked: true })
      .where(eq(account.id, a.accountId));
    expect(await unlink("system", 90000001)).toEqual({ ok: true });
    const [acc] = await ctx.db.select().from(account);
    expect(acc.tier).toBe("associate");
    expect(acc.mainCharacterId).toBeNull();
  });

  it("unlinking the main of a pending account leaves it pending", async () => {
    const acc = await seedAccount(ctx.db, { tier: "pending" });
    await seedCharacter(ctx.db, cfg, { id: 90000101, accountId: acc.id, main: true });
    await seedCharacter(ctx.db, cfg, { id: 90000102, accountId: acc.id });

    const res = await ctx.db.transaction((tx) =>
      unlinkCharacter(tx, cfg, acc.id, 90000101),
    );

    expect(res).toEqual({ ok: true });
    const [after] = await ctx.db.select().from(account).where(eq(account.id, acc.id));
    expect(after.tier).toBe("pending");
    expect(after.mainCharacterId).toBeNull();
  });

  it("refuses to unlink an account's last character", async () => {
    const a = await login(ch());
    expect(await unlink(a.accountId, 90000001)).toEqual({
      ok: false,
      error: "last_character",
    });
    const chars = await ctx.db.select().from(character);
    expect(chars).toHaveLength(1);
  });

  it("reclaims through linkCharacter when the owner hash differs", async () => {
    const b = await login(
      ch({ characterId: 90000005, ownerHash: "oh-b", characterName: "Sold" }),
    );
    const a = await login(ch()); // buyer's account (main 90000001)
    const bSid = await createSession(ctx.db, b.accountId);

    // buyer links the character they purchased: same id, new owner hash
    const res = await link(
      a.accountId,
      ch({ characterId: 90000005, characterName: "Sold", ownerHash: "oh-1" }),
    );
    expect(res).toEqual({ ok: true });

    const [chr] = await ctx.db.select().from(character).where(eq(character.id, 90000005));
    expect(chr.accountId).toBe(a.accountId);
    const [bAcc] = await ctx.db.select().from(account).where(eq(account.id, b.accountId));
    expect(bAcc.mainCharacterId).toBeNull();
    expect(await getSessionAccount(ctx.db, bSid)).toBeNull();
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((au) => au.action === "character.reclaimed")).toBe(true);
  });

  it("refuses to unlink when expectedAccountId no longer matches the locked row (TOCTOU guard)", async () => {
    const a = await login(ch());
    const b = await login(
      ch({ characterId: 90000002, ownerHash: "oh-2", characterName: "Other" }),
    );

    // Simulate a stale pre-lock check: caller believed the character still
    // belonged to account b, but under the lock it now belongs to a.
    await ctx.db.transaction((tx) =>
      unlinkCharacter(tx, cfg, b.accountId, 90000001, { expectedAccountId: b.accountId }),
    );

    const [chr] = await ctx.db.select().from(character).where(eq(character.id, 90000001));
    expect(chr.accountId).toBe(a.accountId);
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((au) => au.action === "character.unlinked")).toBe(false);
  });

  it("records the unlinked character's name, which the row deletion destroys", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90000001,
      accountId: acc.id,
      main: true,
      name: "Zed Main",
    });
    await seedCharacter(ctx.db, cfg, {
      id: 90000002,
      accountId: acc.id,
      name: "Zed Alt",
    });
    await unlink(acc.id, 90000002);
    const audits = await ctx.db.select().from(auditLog);
    const row = audits.find((a) => a.action === "character.unlinked");
    expect(row?.details).toMatchObject({ name: "Zed Alt", wasMain: false });
  });

  it("flags an unlink of the main character, which is what triggers the derole", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, {
      id: 90000001,
      accountId: acc.id,
      main: true,
      name: "Zed Main",
    });
    await seedCharacter(ctx.db, cfg, {
      id: 90000002,
      accountId: acc.id,
      name: "Zed Alt",
    });
    await unlink(acc.id, 90000001);
    const audits = await ctx.db.select().from(auditLog);
    const unlinked = audits.find((a) => a.action === "character.unlinked");
    expect(unlinked?.details).toMatchObject({ name: "Zed Main", wasMain: true });
    // The unlink row still precedes the derole row it explains.
    const tier = audits.find((a) => a.action === "tier.changed");
    expect(tier?.details).toMatchObject({
      from: "member",
      to: "alumni",
      cause: "main unlinked",
    });
    expect(unlinked!.id).toBeLessThan(tier!.id);
  });
});

describe("linkCharacter absorbing an accidental account", () => {
  it("folds a bare single-character account into the caller's account", async () => {
    const main = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 90000301, accountId: main.id, main: true });
    // The accident: a fresh SSO login created its own account for this char.
    const stray = await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, ch({ characterId: 90000302, ownerHash: "oh-302" })),
    );
    const strayId = stray.accountId;

    const res = await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, main.id, ch({ characterId: 90000302, ownerHash: "oh-302" })),
    );

    expect(res).toEqual({ ok: true });
    const [moved] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, 90000302));
    expect(moved.accountId).toBe(main.id);
    const gone = await ctx.db.select().from(account).where(eq(account.id, strayId));
    expect(gone).toHaveLength(0);
  });

  it("deletes the absorbed account's sessions", async () => {
    const main = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 90000311, accountId: main.id, main: true });
    const stray = await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, ch({ characterId: 90000312, ownerHash: "oh-312" })),
    );
    await createSession(ctx.db, stray.accountId);

    await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, main.id, ch({ characterId: 90000312, ownerHash: "oh-312" })),
    );

    const sessions = await ctx.db
      .select()
      .from(session)
      .where(eq(session.accountId, stray.accountId));
    expect(sessions).toHaveLength(0);
  });

  it("adopts the character as main when the target has none", async () => {
    const main = await seedAccount(ctx.db, { tier: "alumni" });
    await seedCharacter(ctx.db, cfg, { id: 90000321, accountId: main.id });
    await ctx.db
      .update(account)
      .set({ mainCharacterId: null })
      .where(eq(account.id, main.id));
    await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, ch({ characterId: 90000322, ownerHash: "oh-322" })),
    );

    await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, main.id, ch({ characterId: 90000322, ownerHash: "oh-322" })),
    );

    const [after] = await ctx.db.select().from(account).where(eq(account.id, main.id));
    expect(after.mainCharacterId).toBe(90000322);
  });

  it("audits the merge and leaves the source's own audit rows unresolved", async () => {
    const main = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 90000331, accountId: main.id, main: true });
    const stray = await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, ch({ characterId: 90000332, ownerHash: "oh-332" })),
    );

    await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, main.id, ch({ characterId: 90000332, ownerHash: "oh-332" })),
    );

    const merged = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "account.merged"));
    expect(merged).toHaveLength(1);
    expect(merged[0].details).toEqual({
      sourceAccountId: stray.accountId,
      characterId: 90000332,
    });
    // audit_log.actor is plain text with no FK: rows the deleted account wrote
    // survive with a uuid that resolves to nothing (actorKind "unresolved").
    const orphaned = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, stray.accountId));
    expect(orphaned.length).toBeGreaterThan(0);
  });
});

describe("linkCharacter refusing a real account", () => {
  // One case per absorbability check. Each seeds an otherwise-absorbable
  // account and flips exactly one attribute, so a loosened predicate fails
  // exactly one test and names itself.
  // `mutate` returns Promise<unknown>, not Promise<void>: the one-liner cases
  // hand back a drizzle query builder, which resolves to a QueryResult.
  // `blocker` is asserted, not just the refusal: the reason reaches the member
  // as the page copy telling them WHICH thing an admin has to clear, so a
  // guard reporting its neighbour's reason is a user-visible defect that a
  // bare `ok: false` assertion would pass straight over.
  const refuses = async (
    blocker: MergeBlocker,
    mutate: (accountId: string) => Promise<unknown>,
  ) => {
    const main = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 90000401, accountId: main.id, main: true });
    const stray = await ctx.db.transaction((tx) =>
      handleEveLogin(tx, cfg, ch({ characterId: 90000402, ownerHash: "oh-402" })),
    );
    await mutate(stray.accountId);

    const res = await ctx.db.transaction((tx) =>
      linkCharacter(tx, cfg, main.id, ch({ characterId: 90000402, ownerHash: "oh-402" })),
    );

    expect(res).toEqual({ ok: false, error: "already_linked", blocker });
    const [still] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, 90000402));
    expect(still.accountId).toBe(stray.accountId);
  };

  it("refuses an admin account", () =>
    refuses("admin", (id) =>
      ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, id)),
    ));

  it("refuses a tier-locked account", () =>
    refuses("tier_locked", (id) =>
      ctx.db.update(account).set({ tierLocked: true }).where(eq(account.id, id)),
    ));

  it("refuses a cryo account", () =>
    refuses("status", (id) =>
      ctx.db.update(account).set({ status: "cryo" }).where(eq(account.id, id)),
    ));

  it("refuses an account carrying an admin's status note", () =>
    refuses("note", (id) =>
      ctx.db
        .update(account)
        .set({ statusNote: "inactive since March, keep the tier" })
        .where(eq(account.id, id)),
    ));

  it("refuses an account with a Discord link", () =>
    refuses("discord", async (id) => {
      await ctx.db.insert(discordLink).values({ accountId: id, discordUserId: "d-1" });
    }));

  // One case per payout table. All three are set-null FKs, so the database
  // would happily delete the account and silently detach the history.
  const seedOperation = async (createdBy: string | null) => {
    const [op] = await ctx.db
      .insert(payoutOperation)
      .values({ name: "Op", occurredAt: new Date(), createdBy })
      .returning();
    return op;
  };

  it("refuses an account that created a payout operation", () =>
    refuses("payouts", async (id) => {
      await seedOperation(id);
    }));

  it("refuses an account that is a payout participant", () =>
    refuses("payouts", async (id) => {
      const op = await seedOperation(null);
      await ctx.db
        .insert(payoutParticipant)
        .values({ operationId: op.id, accountId: id, displayName: "Someone" });
    }));

  it("refuses an account that recorded a payment", () =>
    refuses("payouts", async (id) => {
      const op = await seedOperation(null);
      const [p] = await ctx.db
        .insert(payoutParticipant)
        .values({ operationId: op.id, displayName: "Someone" })
        .returning();
      // The account is neither the operation's creator nor its participant —
      // only its actor. This is the case the first two checks miss.
      await ctx.db
        .insert(payoutPayment)
        .values({ participantId: p.id, kind: "paid", amount: "1000", actor: id });
    }));

  it("refuses an account holding a second character", () =>
    refuses("characters", async (id) => {
      await seedCharacter(ctx.db, cfg, { id: 90000403, accountId: id });
    }));

  // The cases above each trip one guard, so none of them can see the order the
  // guards run in — and that order is load-bearing copy, not an implementation
  // detail. An account tripping both a clearable field and an unclearable one
  // must report the clearable one: "clear the note and retry" is a fix the
  // member can get, "it has payout history, ask an admin" is a dead end. Move
  // the payout checks above the note check and every other test still passes.
  it("reports the clearable blocker when an account trips two", () =>
    refuses("note", async (id) => {
      await ctx.db
        .update(account)
        .set({ statusNote: "left the corp, keeping the tier" })
        .where(eq(account.id, id));
      const [op] = await ctx.db
        .insert(payoutOperation)
        .values({ name: "Op", occurredAt: new Date(), createdBy: id })
        .returning();
      expect(op.createdBy).toBe(id);
    }));
});

describe("transaction rollback", () => {
  it("leaves no partial state when the transaction throws after linking", async () => {
    const a = await login(ch());
    const auditCountBefore = (await ctx.db.select().from(auditLog)).length;
    const outboxCountBefore = (await ctx.db.select().from(outbox)).length;
    await expect(
      ctx.db.transaction(async (tx) => {
        await linkCharacter(
          tx,
          cfg,
          a.accountId,
          ch({ characterId: 90000050, characterName: "Doomed" }),
        );
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
      link(
        a.accountId,
        ch({ characterId: 90000010, characterName: "Alt1", ownerHash: "oh-1" }),
      ),
      link(
        a.accountId,
        ch({ characterId: 90000011, characterName: "Alt2", ownerHash: "oh-1" }),
      ),
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

  // account/actions.ts's setMainAction redirects with this name in the query
  // string to confirm "Main character set to <name>" — it must come back on
  // success rather than forcing a second query for a row already locked and
  // read inside this same call.
  it("returns the character's name on success", async () => {
    const a = await login(ch());
    await link(a.accountId, ch({ characterId: 90000003, characterName: "Alt" }));
    expect(await setMain(a.accountId, 90000003)).toEqual({ ok: true, name: "Alt" });
  });

  it("rejects characters not on the account", async () => {
    const a = await login(ch());
    expect(await setMain(a.accountId, 99999999)).toEqual({
      ok: false,
      error: "not_on_account",
    });
  });

  it("logs the admin action, with the admin as actor, when told to", async () => {
    const a = await login(ch());
    await link(a.accountId, ch({ characterId: 90000003, characterName: "Alt" }));
    const admin = await seedAccount(ctx.db, { isAdmin: true });
    await ctx.db.transaction((tx) =>
      setMainCharacter(tx, admin.id, a.accountId, 90000003, "admin.main_changed"),
    );
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.target, a.accountId));
    const entry = rows.find((r) => r.action === "admin.main_changed")!;
    expect(entry).toBeDefined();
    expect(entry.actor).toBe(admin.id);
    expect(entry.details).toMatchObject({ mainCharacterId: 90000003 });
    expect(rows.some((r) => r.action === "account.main_changed")).toBe(false);
  });
});

describe("re-auth side effects", () => {
  it("audits, enqueues, and downgrades status when scopes shrink", async () => {
    await login(ch());
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

  it("clears a stale token-fault verdict when the new token has full scopes", async () => {
    await login(ch());
    await ctx.db
      .insert(contactSyncState)
      .values({ characterId: 90000001, lastResult: "token_invalid" });

    await login(ch({ refreshToken: "rt-2" })); // full scopes → tokenStatus "valid"

    const [state] = await ctx.db
      .select()
      .from(contactSyncState)
      .where(eq(contactSyncState.characterId, 90000001));
    expect(state.lastResult).toBeNull();
    expect(state.lastDetail).toBeNull();
  });

  it("does not clear a label_mismatch verdict, which is unrelated to the token", async () => {
    await login(ch());
    await ctx.db.insert(contactSyncState).values({
      characterId: 90000001,
      lastResult: "label_mismatch",
      lastDetail: "standings (typo)",
    });

    await login(ch({ refreshToken: "rt-2" })); // full scopes → tokenStatus "valid"

    const [state] = await ctx.db
      .select()
      .from(contactSyncState)
      .where(eq(contactSyncState.characterId, 90000001));
    expect(state.lastResult).toBe("label_mismatch");
    expect(state.lastDetail).toBe("standings (typo)");
  });

  it("leaves the verdict alone when the re-auth itself is still missing a scope", async () => {
    await login(ch());
    await ctx.db
      .insert(contactSyncState)
      .values({ characterId: 90000001, lastResult: "token_invalid" });

    // missing write scope → tokenFields() computes tokenStatus "needs_reauth"
    await login(
      ch({ refreshToken: "rt-2", scopes: ["esi-characters.read_contacts.v1"] }),
    );

    const [chr] = await ctx.db.select().from(character);
    expect(chr.tokenStatus).toBe("needs_reauth");
    const [state] = await ctx.db
      .select()
      .from(contactSyncState)
      .where(eq(contactSyncState.characterId, 90000001));
    expect(state.lastResult).toBe("token_invalid");
  });
});

describe("wakeSelf", () => {
  it("wakes a cryo account: status active, audited (self-actor), enqueued", async () => {
    const target = await seedAccount(ctx.db);
    await ctx.db.update(account).set({ status: "cryo" }).where(eq(account.id, target.id));
    await ctx.db.delete(outbox);
    const r = await wake(target.id);
    expect(r).toEqual({ ok: true });
    const [acc] = await ctx.db.select().from(account).where(eq(account.id, target.id));
    expect(acc.status).toBe("active");
    expect(acc.statusChangedAt).not.toBeNull();
    const [audit] = await ctx.db.select().from(auditLog).orderBy(auditLog.id);
    expect(audit.actor).toBe(target.id);
    expect(audit.action).toBe("status.changed");
    expect(audit.target).toBe(target.id);
    expect(audit.details).toMatchObject({ to: "active", self: true });
    expect(await ctx.db.select().from(outbox)).toHaveLength(1);
  });

  it("is a no-op when already active: no audit row, nothing enqueued", async () => {
    const target = await seedAccount(ctx.db);
    await ctx.db.delete(outbox);
    const r = await wake(target.id);
    expect(r).toEqual({ ok: true });
    expect(await ctx.db.select().from(auditLog)).toHaveLength(0);
    expect(await ctx.db.select().from(outbox)).toHaveLength(0);
  });

  it("returns not_found for a missing account", async () => {
    const r = await wake("00000000-0000-0000-0000-000000000000");
    expect(r).toEqual({ ok: false, error: "not_found" });
  });

  it("records the status wakeSelf moved from", async () => {
    const acc = await seedAccount(ctx.db, { status: "cryo" });
    await wake(acc.id);
    const audits = await ctx.db.select().from(auditLog);
    const row = audits.find((a) => a.action === "status.changed");
    expect(row?.details).toMatchObject({ from: "cryo", to: "active", self: true });
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
    await ctx.db
      .update(account)
      .set({ isAdmin: true })
      .where(eq(account.id, a.accountId));
    expect(await demote("system", a.accountId)).toEqual({
      ok: false,
      error: "last_admin",
    });
  });

  it("rejects a non-admin actor", async () => {
    const a = await login(ch());
    const b = await login(
      ch({ characterId: 90000002, ownerHash: "oh-2", characterName: "B" }),
    );
    await ctx.db
      .update(account)
      .set({ isAdmin: true })
      .where(eq(account.id, b.accountId));
    // a is not an admin and not "system": refused, b keeps admin
    expect(await demote(a.accountId, b.accountId)).toEqual({
      ok: false,
      error: "not_authorized",
    });
    const [bAcc] = await ctx.db.select().from(account).where(eq(account.id, b.accountId));
    expect(bAcc.isAdmin).toBe(true);
  });

  it("demotes when another admin exists", async () => {
    await login(ch());
    const b = await login(
      ch({ characterId: 90000002, ownerHash: "oh-2", characterName: "B" }),
    );
    await ctx.db.update(account).set({ isAdmin: true });
    expect(await demote("system", b.accountId)).toEqual({ ok: true });
  });

  it("never lets two concurrent demotions remove both admins", async () => {
    const a = await login(ch());
    const b = await login(
      ch({ characterId: 90000002, ownerHash: "oh-2", characterName: "B" }),
    );
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

describe("promoteAdmin", () => {
  it("lets an admin grant is_admin, audit-logged", async () => {
    const admin = await seedAccount(ctx.db);
    await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, admin.id));
    const target = await seedAccount(ctx.db);
    const result = await ctx.db.transaction((tx) =>
      promoteAdmin(tx, admin.id, target.id),
    );
    expect(result).toEqual({ ok: true });
    const [after] = await ctx.db.select().from(account).where(eq(account.id, target.id));
    expect(after.isAdmin).toBe(true);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin.promoted"));
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(admin.id);
    expect(rows[0].target).toBe(target.id);
  });

  it("rejects a non-admin actor", async () => {
    const nobody = await seedAccount(ctx.db);
    const target = await seedAccount(ctx.db);
    const result = await ctx.db.transaction((tx) =>
      promoteAdmin(tx, nobody.id, target.id),
    );
    expect(result).toEqual({ ok: false, error: "not_authorized" });
  });

  it("is idempotent for an already-admin target (no duplicate audit)", async () => {
    const admin = await seedAccount(ctx.db);
    await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, admin.id));
    await ctx.db.transaction((tx) => promoteAdmin(tx, admin.id, admin.id));
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "admin.promoted"));
    expect(rows).toHaveLength(0);
  });

  it("returns not_found for a missing target", async () => {
    const admin = await seedAccount(ctx.db);
    await ctx.db.update(account).set({ isAdmin: true }).where(eq(account.id, admin.id));
    const result = await ctx.db.transaction((tx) =>
      promoteAdmin(tx, admin.id, "00000000-0000-0000-0000-000000000000"),
    );
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("lets the system actor promote when no admin exists yet", async () => {
    const target = await seedAccount(ctx.db);
    const result = await ctx.db.transaction((tx) =>
      promoteAdmin(tx, "system", target.id),
    );
    expect(result).toEqual({ ok: true });
    const [after] = await ctx.db.select().from(account).where(eq(account.id, target.id));
    expect(after.isAdmin).toBe(true);
  });
});

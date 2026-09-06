import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { oauthTransaction } from "@/db/schema";
import { consumeOauthTransaction, createOauthTransaction } from "@/services/oauth-tx";
import { setupTestDb } from "./helpers/db";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

describe("oauth transactions", () => {
  it("binds Fleet Read to the intended character without changing other transactions", async () => {
    const tx = await createOauthTransaction(ctx.db, {
      intent: "grant-fleet-read",
      sessionId: "synthetic-session",
      accountId: "00000000-0000-4000-8000-000000000001",
      fleetReadCharacterId: 90000001,
    });
    // Exact pre-upgrade EVE callback allowlist: it cannot consume this grant.
    expect(
      await consumeOauthTransaction(ctx.db, tx.state, ["login", "link-character"]),
    ).toBeNull();
    const [stored] = await ctx.db
      .select()
      .from(oauthTransaction)
      .where(
        eq(
          oauthTransaction.stateHash,
          createHash("sha256").update(tx.state).digest("base64url"),
        ),
      );
    expect(stored.consumedAt).toBeNull();
    const consumed = await consumeOauthTransaction(ctx.db, tx.state, [
      "grant-fleet-read",
    ]);
    expect(consumed).toMatchObject({
      intent: "grant-fleet-read",
      fleetReadCharacterId: 90000001,
      sessionId: "synthetic-session",
      accountId: "00000000-0000-4000-8000-000000000001",
    });
    expect(
      await consumeOauthTransaction(ctx.db, tx.state, ["grant-fleet-read"]),
    ).toBeNull();
    const legacy = await createOauthTransaction(ctx.db, { intent: "login" });
    expect(
      (await consumeOauthTransaction(ctx.db, legacy.state, ["login"]))
        ?.fleetReadCharacterId,
    ).toBeNull();
  });

  it.each([
    { fleetReadCharacterId: undefined },
    { fleetReadCharacterId: null },
    { fleetReadCharacterId: 0 },
    { fleetReadCharacterId: -1 },
    { fleetReadCharacterId: 1.5 },
    { fleetReadCharacterId: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: undefined },
    { sessionId: "" },
    { accountId: undefined },
    { accountId: "" },
  ])("refuses malformed grant creation before writing: %j", async (missing) => {
    const before = await ctx.db.select().from(oauthTransaction);
    const input = {
      intent: "grant-fleet-read",
      sessionId: "synthetic-session",
      accountId: "00000000-0000-4000-8000-000000000001",
      fleetReadCharacterId: 90000001,
      ...missing,
    } as Parameters<typeof createOauthTransaction>[1];
    await expect(createOauthTransaction(ctx.db, input)).rejects.toThrow(
      "Invalid Fleet Read context",
    );
    expect(await ctx.db.select().from(oauthTransaction)).toEqual(before);
  });

  it("rollback expiry affects only new intents, leaving legacy callbacks usable", async () => {
    const grant = await createOauthTransaction(ctx.db, {
      intent: "grant-fleet-read",
      sessionId: "synthetic-session",
      accountId: "00000000-0000-4000-8000-000000000001",
      fleetReadCharacterId: 90000001,
    });
    const login = await createOauthTransaction(ctx.db, { intent: "login" });
    const link = await createOauthTransaction(ctx.db, { intent: "link-character" });
    await ctx.db
      .update(oauthTransaction)
      .set({ expiresAt: new Date(0) })
      .where(eq(oauthTransaction.intent, "grant-fleet-read"));
    expect(
      await consumeOauthTransaction(ctx.db, grant.state, ["grant-fleet-read"]),
    ).toBeNull();
    expect(
      await consumeOauthTransaction(ctx.db, grant.state, ["login", "link-character"]),
    ).toBeNull();
    expect(
      (await consumeOauthTransaction(ctx.db, login.state, ["login", "link-character"]))
        ?.intent,
    ).toBe("login");
    expect(
      (await consumeOauthTransaction(ctx.db, link.state, ["login", "link-character"]))
        ?.intent,
    ).toBe("link-character");
  });
  it("round-trips and is single-use", async () => {
    const tx = await createOauthTransaction(ctx.db, { intent: "login" });
    expect(tx.codeChallenge).not.toBe(tx.codeVerifier);

    const consumed = await consumeOauthTransaction(ctx.db, tx.state, ["login"]);
    expect(consumed?.intent).toBe("login");
    expect(consumed?.pkceVerifier).toBe(tx.codeVerifier);

    // replay rejected
    expect(await consumeOauthTransaction(ctx.db, tx.state, ["login"])).toBeNull();
  });

  it("does not store raw state", async () => {
    const tx = await createOauthTransaction(ctx.db, { intent: "login" });
    const rows = await ctx.db.select().from(oauthTransaction);
    expect(rows.some((r) => r.stateHash === tx.state)).toBe(false);
    await consumeOauthTransaction(ctx.db, tx.state, ["login"]);
  });

  it("rejects expired transactions", async () => {
    const tx = await createOauthTransaction(ctx.db, { intent: "login" });
    // scope the expiry to the transaction under test only
    const stateHash = createHash("sha256").update(tx.state).digest("base64url");
    await ctx.db
      .update(oauthTransaction)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oauthTransaction.stateHash, stateHash));
    expect(await consumeOauthTransaction(ctx.db, tx.state, ["login"])).toBeNull();
  });

  it("rejects unknown state", async () => {
    expect(await consumeOauthTransaction(ctx.db, "nope", ["login"])).toBeNull();
  });

  it("leaves the transaction unconsumed when the intent does not match", async () => {
    const tx = await createOauthTransaction(ctx.db, { intent: "link-discord" });
    expect(await consumeOauthTransaction(ctx.db, tx.state, ["login"])).toBeNull();
    // still consumable by the right callback
    expect(
      await consumeOauthTransaction(ctx.db, tx.state, ["link-discord"]),
    ).not.toBeNull();
  });
});

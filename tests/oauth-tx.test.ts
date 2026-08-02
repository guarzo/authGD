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
    await ctx.db
      .update(oauthTransaction)
      .set({ expiresAt: new Date(Date.now() - 1000) });
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

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, character } from "@/db/schema";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { getFreshAccessToken } from "@/services/tokens";
import { setupTestDb } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await ctx.db.execute(sql`
    TRUNCATE account, "character", discord_link, session, bootstrap_admin_grant,
      outbox, oauth_transaction, contact_sync_state, sync_run,
      wanderer_acl_observation, audit_log RESTART IDENTITY CASCADE
  `);
});

const tokenJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function seed(opts: Partial<Parameters<typeof seedCharacter>[2]> = {}) {
  const acc = await seedAccount(ctx.db);
  return seedCharacter(ctx.db, cfg, { id: 90000001, accountId: acc.id, ...opts });
}

async function getChar(id: number) {
  const rows = await ctx.db.select().from(character).where(eq(character.id, id));
  return rows[0];
}

describe("getFreshAccessToken", () => {
  it("returns the access token + stored blob and persists the rotated refresh token", async () => {
    const ch = await seed({ refreshToken: "old-rt" });
    const fetchImpl = (async () =>
      tokenJson({ access_token: "new-at", refresh_token: "new-rt" })) as typeof fetch;
    const r = await getFreshAccessToken(ctx.db, cfg, ch, fetchImpl);
    expect(r).toMatchObject({ ok: true, accessToken: "new-at" });
    const updated = await getChar(90000001);
    expect(decryptToken(updated.refreshTokenEnc as string, cfg.tokenEncryptionKey)).toBe("new-rt");
    // tokenEnc is exactly what is now stored — callers guard follow-up writes on it
    expect(r).toMatchObject({ tokenEnc: updated.refreshTokenEnc });
  });

  it("marks token invalid + audits on permanent OAuth errors", async () => {
    const ch = await seed({});
    const fetchImpl = (async () =>
      tokenJson({ error: "invalid_grant" }, 400)) as typeof fetch;
    const r = await getFreshAccessToken(ctx.db, cfg, ch, fetchImpl);
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
    expect((await getChar(90000001)).tokenStatus).toBe("invalid");
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "token.invalidated")).toBe(true);
  });

  it("changes NO state on transient errors", async () => {
    const ch = await seed({});
    const fetchImpl = (async () =>
      tokenJson({ error: "temporarily_unavailable" }, 503)) as typeof fetch;
    const r = await getFreshAccessToken(ctx.db, cfg, ch, fetchImpl);
    expect(r).toMatchObject({ ok: false, reason: "transient" });
    expect((await getChar(90000001)).tokenStatus).toBe("valid");
  });

  it("maps a malformed stored blob to a clean invalid (carry-over)", async () => {
    const ch = await seed({});
    await ctx.db
      .update(character)
      .set({ refreshTokenEnc: "not.a.blob" })
      .where(eq(character.id, 90000001));
    const r = await getFreshAccessToken(
      ctx.db,
      cfg,
      { ...ch, refreshTokenEnc: "not.a.blob" },
      (async () => tokenJson({})) as typeof fetch,
    );
    expect(r).toMatchObject({ ok: false, reason: "invalid", detail: "malformed_token_blob" });
    expect((await getChar(90000001)).tokenStatus).toBe("invalid");
  });

  it("returns no_token for missing or already-invalid tokens", async () => {
    const ch = await seed({ refreshToken: null, tokenStatus: "missing" });
    const r = await getFreshAccessToken(ctx.db, cfg, ch, (async () =>
      tokenJson({})) as typeof fetch);
    expect(r).toEqual({ ok: false, reason: "no_token" });
  });

  it("treats a CAS miss on success as TRANSIENT — a stale token is never usable", async () => {
    const stale = await seed({ refreshToken: "old-rt" }); // row as WE read it
    // another job rotates underneath us before our refresh completes
    const currentBlob = encryptToken("current-rt", cfg.tokenEncryptionKey);
    await ctx.db
      .update(character)
      .set({ refreshTokenEnc: currentBlob })
      .where(eq(character.id, 90000001));
    const fetchImpl = (async () =>
      tokenJson({ access_token: "our-at", refresh_token: "our-rt" })) as typeof fetch;
    const r = await getFreshAccessToken(ctx.db, cfg, stale, fetchImpl);
    // the row changed hands under us — our whole read is stale, so downstream
    // callers must NOT act on this character this run
    expect(r).toMatchObject({ ok: false, reason: "transient" });
    const after = await getChar(90000001);
    // the first writer's stored refresh token wins
    expect(decryptToken(after.refreshTokenEnc as string, cfg.tokenEncryptionKey)).toBe("current-rt");
  });

  it("skips invalidation when the blob rotated during a failed refresh", async () => {
    const stale = await seed({ refreshToken: "old-rt" });
    await ctx.db
      .update(character)
      .set({ refreshTokenEnc: encryptToken("current-rt", cfg.tokenEncryptionKey) })
      .where(eq(character.id, 90000001));
    // invalid_grant for the OLD token proves nothing about the NEW one
    const fetchImpl = (async () =>
      tokenJson({ error: "invalid_grant" }, 400)) as typeof fetch;
    const r = await getFreshAccessToken(ctx.db, cfg, stale, fetchImpl);
    expect(r).toMatchObject({ ok: false, reason: "transient" });
    expect((await getChar(90000001)).tokenStatus).toBe("valid"); // NOT invalidated
  });
});

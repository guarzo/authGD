import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, character } from "@/db/schema";
import { decryptToken, encryptToken } from "@/lib/crypto";
import { getFreshAccessToken, getMainCharacterWithScope } from "@/services/tokens";
import { OPEN_WINDOW_SCOPE } from "@/lib/esi/client";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

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
    expect(decryptToken(updated.refreshTokenEnc as string, cfg.tokenEncryptionKey)).toBe(
      "new-rt",
    );
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
      async () => tokenJson({}),
    );
    expect(r).toMatchObject({
      ok: false,
      reason: "invalid",
      detail: "malformed_token_blob",
    });
    expect((await getChar(90000001)).tokenStatus).toBe("invalid");
  });

  it("returns no_token for missing or already-invalid tokens", async () => {
    const ch = await seed({ refreshToken: null, tokenStatus: "missing" });
    const r = await getFreshAccessToken(ctx.db, cfg, ch, async () => tokenJson({}));
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
    expect(decryptToken(after.refreshTokenEnc as string, cfg.tokenEncryptionKey)).toBe(
      "current-rt",
    );
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

describe("getMainCharacterWithScope", () => {
  it("returns the main character's token row when it granted the scope", async () => {
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90000001,
      accountId: acc.id,
      main: true,
      scopes: [...cfg.eveSso.scopes, OPEN_WINDOW_SCOPE],
    });
    const row = await getMainCharacterWithScope(ctx.db, acc.id, OPEN_WINDOW_SCOPE);
    expect(row?.id).toBe(90000001);
    expect(row?.tokenStatus).toBe("valid");
    expect(row?.refreshTokenEnc).toBeTruthy();
  });

  it("returns null when the main character authorized before the scope existed", async () => {
    // The whole reason this gate reads the persisted column and not config:
    // config says what we ASK for, and this operator has a valid session
    // whose token predates the ask.
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90000002,
      accountId: acc.id,
      main: true,
      scopes: [...cfg.eveSso.scopes],
    });
    expect(await getMainCharacterWithScope(ctx.db, acc.id, OPEN_WINDOW_SCOPE)).toBeNull();
  });

  it("ignores a non-main character that has the scope", async () => {
    // The call goes out on the operator's MAIN token; an alt holding the
    // scope does not make the control work.
    const acc = await seedAccount(ctx.db);
    await seedCharacter(ctx.db, cfg, {
      id: 90000003,
      accountId: acc.id,
      main: true,
      scopes: [...cfg.eveSso.scopes],
    });
    await seedCharacter(ctx.db, cfg, {
      id: 90000004,
      accountId: acc.id,
      scopes: [...cfg.eveSso.scopes, OPEN_WINDOW_SCOPE],
    });
    expect(await getMainCharacterWithScope(ctx.db, acc.id, OPEN_WINDOW_SCOPE)).toBeNull();
  });

  it("returns null for an account with no main character", async () => {
    const acc = await seedAccount(ctx.db);
    expect(await getMainCharacterWithScope(ctx.db, acc.id, OPEN_WINDOW_SCOPE)).toBeNull();
  });
});

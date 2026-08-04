import { eq } from "drizzle-orm";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { account, auditLog, character, outbox, session } from "@/db/schema";
import { runTokenHealthJob } from "@/jobs/token-health";
import { reclaimTransferredCharacter } from "@/services/accounts";
import { JobRetryError } from "@/services/sync-run";
import { createSession } from "@/services/session";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  ctx = await setupTestDb();
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256" }],
  });
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));

async function signAccessToken(opts: {
  characterId: number;
  ownerHash: string;
  scopes: string[];
}): Promise<string> {
  return new SignJWT({ name: "Pilot", owner: opts.ownerHash, scp: opts.scopes })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://login.eveonline.com")
    .setAudience("EVE Online")
    .setSubject(`CHARACTER:EVE:${opts.characterId}`)
    .setExpirationTime("5m")
    .sign(privateKey);
}

/** SSO token endpoint fake returning a signed access token per refresh. */
function refreshFetchFor(accessTokens: Record<string, string>): typeof fetch {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(init?.body as string);
    const rt = body.get("refresh_token") ?? "";
    const at = accessTokens[rt];
    if (!at) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    return new Response(
      JSON.stringify({ access_token: at, refresh_token: `${rt}-rotated` }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

/** Signs a structurally valid EVE JWT missing the `owner` claim — verifyEveAccessToken
 * throws EveSsoError("EVE JWT missing owner claim") for this, unlike signAccessToken. */
async function signTokenMissingOwnerClaim(opts: {
  characterId: number;
  scopes: string[];
}): Promise<string> {
  return new SignJWT({ name: "Pilot", scp: opts.scopes })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://login.eveonline.com")
    .setAudience("EVE Online")
    .setSubject(`CHARACTER:EVE:${opts.characterId}`)
    .setExpirationTime("5m")
    .sign(privateKey);
}

async function getChar(id: number) {
  const rows = await ctx.db.select().from(character).where(eq(character.id, id));
  return rows[0];
}

describe("runTokenHealthJob", () => {
  it("keeps healthy tokens valid and rotates them", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      refreshToken: "rt1",
      ownerHash: "oh-1",
    });
    const at = await signAccessToken({
      characterId: 1,
      ownerHash: "oh-1",
      scopes: [...cfg.eveSso.scopes],
    });
    const result = await runTokenHealthJob({
      db: ctx.db,
      cfg,
      jwks,
      fetchImpl: refreshFetchFor({ rt1: at }),
    });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ refreshed: 1 });
    expect((await getChar(1)).tokenStatus).toBe("valid");
  });

  it("marks scope shortfalls needs_reauth (in-place re-auth, never unlink)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      refreshToken: "rt1",
      ownerHash: "oh-1",
    });
    const at = await signAccessToken({
      characterId: 1,
      ownerHash: "oh-1",
      scopes: ["esi-characters.read_contacts.v1"], // write scope missing
    });
    await runTokenHealthJob({
      db: ctx.db,
      cfg,
      jwks,
      fetchImpl: refreshFetchFor({ rt1: at }),
    });
    const ch = await getChar(1);
    expect(ch.tokenStatus).toBe("needs_reauth");
    expect(ch.scopes).toEqual(["esi-characters.read_contacts.v1"]);
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "token.needs_reauth")).toBe(true);
  });

  it("records which scopes are missing, not the whole required set", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      refreshToken: "rt1",
      ownerHash: "oh-1",
    });
    const at = await signAccessToken({
      characterId: 1,
      ownerHash: "oh-1",
      scopes: ["esi-characters.read_contacts.v1"], // write scope missing
    });
    await runTokenHealthJob({
      db: ctx.db,
      cfg,
      jwks,
      fetchImpl: refreshFetchFor({ rt1: at }),
    });
    const audits = await ctx.db.select().from(auditLog);
    const row = audits.find((a) => a.action === "token.needs_reauth");
    expect(row?.details).toMatchObject({
      missingScopes: ["esi-characters.write_contacts.v1"],
    });
  });

  it("marks token invalid ONLY on permanent OAuth errors", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      refreshToken: "revoked",
      ownerHash: "oh-1",
    });
    const result = await runTokenHealthJob({
      db: ctx.db,
      cfg,
      jwks,
      fetchImpl: refreshFetchFor({}), // every refresh → invalid_grant
    });
    expect(result.counts).toMatchObject({ invalid: 1 });
    expect((await getChar(1)).tokenStatus).toBe("invalid");
  });

  it("transient refresh failures change nothing and retry", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      refreshToken: "rt1",
      ownerHash: "oh-1",
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
        status: 503,
      })) as typeof fetch;
    await expect(
      runTokenHealthJob({ db: ctx.db, cfg, jwks, fetchImpl }),
    ).rejects.toBeInstanceOf(JobRetryError);
    expect((await getChar(1)).tokenStatus).toBe("valid");
  });

  it("owner_hash mismatch reclaims the character and revokes the account's sessions", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      refreshToken: "rt1",
      ownerHash: "oh-old",
    });
    await seedCharacter(ctx.db, cfg, {
      id: 2,
      accountId: acc.id,
      refreshToken: null,
      tokenStatus: "missing",
    });
    await createSession(ctx.db, acc.id);
    const at = await signAccessToken({
      characterId: 1,
      ownerHash: "oh-NEW",
      scopes: [...cfg.eveSso.scopes],
    });
    const result = await runTokenHealthJob({
      db: ctx.db,
      cfg,
      jwks,
      fetchImpl: refreshFetchFor({ rt1: at }),
    });
    expect(result.counts).toMatchObject({ unlinked: 1 });
    expect(await getChar(1)).toBeUndefined(); // reclaimed
    expect(await ctx.db.select().from(session)).toEqual([]); // sessions revoked
    // no-main rule applied: main cleared, demoted, deprovision enqueued
    const [after] = await ctx.db.select().from(account);
    expect(after.mainCharacterId).toBeNull();
    expect(after.tier).toBe("green");
    const outboxRows = await ctx.db.select().from(outbox);
    expect(outboxRows.map((r) => r.payload)).toContainEqual({
      kind: "account",
      accountId: acc.id,
    });
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "character.owner_mismatch")).toBe(true);
    expect(audits.some((a) => a.action === "character.reclaimed")).toBe(true);
  });

  it("reclaims even the LAST character — the account may legitimately end empty", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      refreshToken: "rt1",
      ownerHash: "oh-old",
    });
    await createSession(ctx.db, acc.id);
    const at = await signAccessToken({
      characterId: 1,
      ownerHash: "oh-NEW",
      scopes: [...cfg.eveSso.scopes],
    });
    const result = await runTokenHealthJob({
      db: ctx.db,
      cfg,
      jwks,
      fetchImpl: refreshFetchFor({ rt1: at }),
    });
    expect(result.counts).toMatchObject({ unlinked: 1 });
    expect(await getChar(1)).toBeUndefined(); // gone — no last-character guard here
    const [after] = await ctx.db.select().from(account);
    expect(after.mainCharacterId).toBeNull();
    expect(after.tier).toBe("green"); // deprovisioned, not left flygd
    expect(await ctx.db.select().from(session)).toEqual([]);
  });

  it("fails closed when the token's subject is a DIFFERENT character", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      refreshToken: "rt1",
      ownerHash: "oh-1",
    });
    // valid token, same owner hash, but subject character 2 — must never
    // vouch for character 1's row
    const at = await signAccessToken({
      characterId: 2,
      ownerHash: "oh-1",
      scopes: [...cfg.eveSso.scopes],
    });
    const result = await runTokenHealthJob({
      db: ctx.db,
      cfg,
      jwks,
      fetchImpl: refreshFetchFor({ rt1: at }),
    });
    expect(result.counts).toMatchObject({ invalid: 1, unlinked: 0 });
    const ch = await getChar(1);
    expect(ch).toBeDefined(); // link kept
    expect(ch.tokenStatus).toBe("invalid");
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "token.subject_mismatch")).toBe(true);
  });

  it("a verify failure on one character never blocks the rest of the run", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      refreshToken: "rt1",
      ownerHash: "oh-1",
    });
    await seedCharacter(ctx.db, cfg, {
      id: 2,
      accountId: acc.id,
      refreshToken: "rt2",
      ownerHash: "oh-2",
    });
    const badAt = await signTokenMissingOwnerClaim({
      characterId: 1,
      scopes: [...cfg.eveSso.scopes],
    });
    const goodAt = await signAccessToken({
      characterId: 2,
      ownerHash: "oh-2",
      scopes: [...cfg.eveSso.scopes],
    });
    const result = await runTokenHealthJob({
      db: ctx.db,
      cfg,
      jwks,
      fetchImpl: refreshFetchFor({ rt1: badAt, rt2: goodAt }),
    });
    expect(result.status).toBe("ok");
    expect(result.counts).toMatchObject({ invalid: 1, refreshed: 1 });
    expect((await getChar(1)).tokenStatus).toBe("invalid");
    expect((await getChar(2)).tokenStatus).toBe("valid"); // character 2 still processed
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.some((a) => a.action === "token.verify_failed")).toBe(true);
  });

  it("a transient verify failure (JWKS/network trouble) changes nothing and retries", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      refreshToken: "rt1",
      ownerHash: "oh-1",
    });
    // Signed with a DIFFERENT key than the one verifyEveAccessToken checks
    // against — jose throws a signature-verification error, not EveSsoError.
    const otherPair = await generateKeyPair("RS256");
    const at = await new SignJWT({
      name: "Pilot",
      owner: "oh-1",
      scp: [...cfg.eveSso.scopes],
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://login.eveonline.com")
      .setAudience("EVE Online")
      .setSubject("CHARACTER:EVE:1")
      .setExpirationTime("5m")
      .sign(otherPair.privateKey);
    await expect(
      runTokenHealthJob({
        db: ctx.db,
        cfg,
        jwks,
        fetchImpl: refreshFetchFor({ rt1: at }),
      }),
    ).rejects.toBeInstanceOf(JobRetryError);
    expect((await getChar(1)).tokenStatus).toBe("valid"); // unchanged
  });

  it("reclaimTransferredCharacter refuses a stale decision (row changed hands)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "flygd" });
    // the row's CURRENT owner hash is already the new owner's
    await seedCharacter(ctx.db, cfg, {
      id: 1,
      accountId: acc.id,
      main: true,
      ownerHash: "oh-new-owner",
    });
    const r = await ctx.db.transaction((tx) =>
      reclaimTransferredCharacter(tx, 1, { accountId: acc.id, ownerHash: "oh-stale" }),
    );
    expect(r).toEqual({ ok: false, error: "changed" });
    expect(await getChar(1)).toBeDefined(); // nothing deleted
  });
});

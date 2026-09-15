import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RECRUITMENT_SCOPES } from "@/core/recruitment-evidence";
import { account, auditLog, character, session } from "@/db/schema";
import { decryptToken } from "@/lib/crypto";
import { verifyEveAccessToken } from "@/lib/esi/sso";
import {
  collectRecruitmentEvidence,
  RecruitmentCollectionError,
} from "@/services/recruitment";
import { createSession, endSession } from "@/services/session";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  ctx = await setupTestDb();
  keys = await generateKeyPair("RS256");
});
afterAll(() => ctx.cleanup());
beforeEach(() => truncateAll(ctx.db));
async function seed() {
  const actor = await seedAccount(ctx.db, { isAdmin: true });
  const target = await seedAccount(ctx.db, { tier: "pending" });
  const ch = await seedCharacter(ctx.db, cfg, {
    id: 90000001,
    accountId: target.id,
    ownerHash: "private-owner-hash",
    name: "Stored Name",
    scopes: [...RECRUITMENT_SCOPES],
  });
  const sessionId = await createSession(ctx.db, actor.id);
  return {
    actor,
    target,
    ch,
    input: { actorAccountId: actor.id, sessionId, targetAccountId: target.id },
  };
}
async function token(
  opts: { characterId?: number; owner?: string; scopes?: readonly string[] } = {},
) {
  return new SignJWT({
    name: "Current JWT Name",
    owner: opts.owner ?? "private-owner-hash",
    scp: opts.scopes ?? RECRUITMENT_SCOPES,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(`CHARACTER:EVE:${opts.characterId ?? 90000001}`)
    .setIssuer("https://login.eveonline.com")
    .setAudience("EVE Online")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}
function transport(
  accessToken: string,
  duringEvidence?: (path: string) => Promise<void>,
) {
  const calls: string[] = [];
  const privateCalls: string[] = [];
  let verified = false;
  const deps = {
    verifyAccessToken: async (value: string) => {
      const identity = await verifyEveAccessToken(value, async () => keys.publicKey);
      verified = true;
      return identity;
    },
    fetchImpl: (async (url, init) => {
      const parsed = new URL(String(url));
      calls.push(parsed.pathname);
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      if (parsed.origin === "https://login.eveonline.com") {
        expect(parsed.pathname).toBe("/v2/oauth/token");
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({ access_token: accessToken, refresh_token: "rotated-secret" }),
        );
      }
      expect(parsed.origin).toBe("https://esi.evetech.net");
      if (new Headers(init?.headers).has("authorization")) {
        expect(verified, "private evidence requested before JWT verification").toBe(true);
        privateCalls.push(parsed.pathname);
      }
      await duringEvidence?.(parsed.pathname);
      return new Response(
        parsed.pathname.endsWith("/skills") ? '{"skills":[],"total_sp":0}' : "[]",
        { headers: { "x-pages": "1" } },
      );
    }) as typeof fetch,
  };
  return { deps, calls, privateCalls };
}
async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code, message: code });
}

describe("ownership-checked account recruitment service", () => {
  it("exports all server-linked characters of pending accounts after verified token refresh, auditing metadata only", async () => {
    const { target, ch, input } = await seed();
    await seedCharacter(ctx.db, cfg, {
      id: 90000002,
      accountId: target.id,
      refreshToken: null,
      tokenStatus: "missing",
    });
    const t = transport(await token());
    const out = await collectRecruitmentEvidence(ctx.db, cfg, input, t.deps);
    expect(out).toMatchObject({
      format: "authgd-recruitment-evidence",
      version: 1,
      accountId: target.id,
      manifest: {
        version: 1,
        declaredCharacterIds: ["90000001", "90000002"],
        includedCharacterIds: ["90000001", "90000002"],
      },
    });
    expect(out.manifest.datasets).toHaveLength(12);
    expect(
      out.manifest.datasets.find((d) => d.characterId === "90000001")?.note,
    ).toContain("Current JWT Name");
    expect(
      out.manifest.datasets
        .filter(
          (d) => d.characterId === "90000002" && d.category !== "corporation-history",
        )
        .map((d) => d.status),
    ).toEqual(Array(5).fill("unauthorised"));
    expect(t.privateCalls).toHaveLength(6);
    const [updated] = await ctx.db
      .select()
      .from(character)
      .where(eq(character.id, ch.id));
    expect(decryptToken(updated.refreshTokenEnc!, cfg.tokenEncryptionKey)).toBe(
      "rotated-secret",
    );
    const logs = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "recruitment.collected"));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actor: input.actorAccountId,
      target: target.id,
      details: {
        snapshotId: out.manifest.bundleId,
        outcome: "partial",
        characterCount: 2,
      },
    });
    for (const secret of [
      "private-owner-hash",
      ch.fleetLinkEpoch,
      "rotated-secret",
      "Current JWT Name",
    ])
      expect(JSON.stringify(logs)).not.toContain(secret);
    for (const secret of [
      "private-owner-hash",
      ch.fleetLinkEpoch,
      "rotated-secret",
      ch.refreshTokenEnc!,
    ])
      expect(JSON.stringify(out)).not.toContain(secret);
  });

  it.each(["non_admin", "missing_session", "wrong_actor", "expired_session"])(
    "denies %s before any network call",
    async (mode) => {
      const { actor, target, input } = await seed();
      if (mode === "non_admin")
        await ctx.db
          .update(account)
          .set({ isAdmin: false })
          .where(eq(account.id, actor.id));
      if (mode === "missing_session") await endSession(ctx.db, input.sessionId);
      if (mode === "wrong_actor") input.actorAccountId = target.id;
      if (mode === "expired_session")
        await ctx.db.update(session).set({ expiresAt: new Date(0) });
      const t = transport(await token());
      await expectCode(
        collectRecruitmentEvidence(ctx.db, cfg, input, t.deps),
        "not_authorized",
      );
      expect(t.calls).toEqual([]);
    },
  );

  it("does not export an invalid empty-character manifest", async () => {
    const { ch, input } = await seed();
    await ctx.db.delete(character).where(eq(character.id, ch.id));
    const t = transport(await token());
    await expectCode(
      collectRecruitmentEvidence(ctx.db, cfg, input, t.deps),
      "collection_failed",
    );
    expect(t.calls).toEqual([]);
  });

  it("returns a fixed not_found diagnostic for missing target accounts", async () => {
    const { input } = await seed();
    const t = transport(await token());
    await expectCode(
      collectRecruitmentEvidence(
        ctx.db,
        cfg,
        { ...input, targetAccountId: randomUUID() },
        t.deps,
      ),
      "not_found",
    );
    expect(t.calls).toEqual([]);
  });

  it.each([{ owner: "new-owner-secret" }, { characterId: 90000999 }])(
    "rejects stale JWT identity %j before private reads",
    async (identity) => {
      const { input } = await seed();
      const t = transport(await token(identity));
      await expectCode(
        collectRecruitmentEvidence(ctx.db, cfg, input, t.deps),
        "identity_changed",
      );
      expect(t.privateCalls).toEqual([]);
    },
  );

  it("does not let arbitrary SSO error text reach the token invalidation audit", async () => {
    const { input } = await seed();
    const t = transport(await token());
    const fetchImpl: typeof fetch = async (url, init) =>
      String(url).startsWith("https://login.eveonline.com/")
        ? new Response('{"error":"upstream-secret-credential"}', { status: 400 })
        : t.deps.fetchImpl(url, init);
    const out = await collectRecruitmentEvidence(ctx.db, cfg, input, {
      ...t.deps,
      fetchImpl,
    });
    expect(JSON.stringify(await ctx.db.select().from(auditLog))).not.toContain(
      "upstream-secret-credential",
    );
    expect(out.manifest.datasets.map((d) => d.status)).toEqual([
      "empty",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(t.privateCalls).toEqual([]);
  });

  it("unverifiable tokens do not authorise private calls or masquerade as empty datasets", async () => {
    const { input } = await seed();
    const t = transport("not-a-signed-token-secret");
    const out = await collectRecruitmentEvidence(ctx.db, cfg, input, t.deps);
    expect(out.manifest.datasets.map((d) => d.status)).toEqual([
      "empty",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(t.privateCalls).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("not-a-signed-token");
  });

  it("checks verified JWT scopes, not stale database capability labels", async () => {
    const { input } = await seed();
    const t = transport(await token({ scopes: [] }));
    const out = await collectRecruitmentEvidence(ctx.db, cfg, input, t.deps);
    expect(out.manifest.datasets.map((d) => d.status)).toEqual([
      "empty",
      "unauthorised",
      "unauthorised",
      "unauthorised",
      "unauthorised",
      "unauthorised",
    ]);
    expect(t.privateCalls).toEqual([]);
  });

  it.each(["demote", "logout", "expire"])(
    "rechecks actor authority after collection: %s",
    async (mode) => {
      const { actor, input } = await seed();
      let changed = false;
      const t = transport(await token(), async () => {
        if (changed) return;
        changed = true;
        if (mode === "demote")
          await ctx.db
            .update(account)
            .set({ isAdmin: false })
            .where(eq(account.id, actor.id));
        if (mode === "logout") await endSession(ctx.db, input.sessionId);
        if (mode === "expire")
          await ctx.db.update(session).set({ expiresAt: new Date(0) });
      });
      await expectCode(
        collectRecruitmentEvidence(ctx.db, cfg, input, t.deps),
        "not_authorized",
      );
      expect(changed).toBe(true);
      expect(
        await ctx.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, "recruitment.collected")),
      ).toEqual([]);
    },
  );

  it.each(["add", "remove", "owner", "account", "epoch"])(
    "rejects changed full linked set/binding without holding locks over network: %s",
    async (mode) => {
      const { target, ch, input } = await seed();
      const other = await seedAccount(ctx.db);
      let changed = false;
      const t = transport(await token(), async () => {
        if (changed) return;
        changed = true;
        // These DB writes finish while the network handler is running; a service
        // that holds identity/account locks across fetch would deadlock this test.
        if (mode === "add")
          await seedCharacter(ctx.db, cfg, { id: 90000003, accountId: target.id });
        if (mode === "remove")
          await ctx.db.delete(character).where(eq(character.id, ch.id));
        if (mode === "owner")
          await ctx.db
            .update(character)
            .set({ ownerHash: "different-owner" })
            .where(eq(character.id, ch.id));
        if (mode === "account")
          await ctx.db
            .update(character)
            .set({ accountId: other.id })
            .where(eq(character.id, ch.id));
        if (mode === "epoch") {
          await ctx.db.delete(character).where(eq(character.id, ch.id));
          await seedCharacter(ctx.db, cfg, {
            id: ch.id,
            accountId: target.id,
            ownerHash: ch.ownerHash,
          });
        }
      });
      await expectCode(
        collectRecruitmentEvidence(ctx.db, cfg, input, t.deps),
        "identity_changed",
      );
      expect(changed).toBe(true);
    },
  );

  it.each(["response_bytes", "aggregate_bytes", "request_count", "success"])(
    "bounds the real default signed-JWT JWKS path: %s",
    async (mode) => {
      const { input } = await seed();
      const accessToken = await token();
      const jwks = JSON.stringify({
        keys: [await exportJWK(keys.publicKey)],
        padding: "x".repeat(4096),
      });
      const sso = JSON.stringify({
        access_token: accessToken,
        refresh_token: "rotated-secret",
      });
      const calls: string[] = [];
      const privateCalls: string[] = [];
      const fetchImpl: typeof fetch = async (url, init) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        if (path === "/oauth/jwks") return new Response(jwks);
        if (path === "/v2/oauth/token") return new Response(sso);
        if (new Headers(init?.headers).has("authorization")) privateCalls.push(path);
        return new Response(
          path.endsWith("/skills") ? '{"skills":[],"total_sp":0}' : "[]",
          { headers: { "x-pages": "1" } },
        );
      };
      // Isolate jose's old module-global JWKS cache too: each control must reach
      // the network boundary, never the cache populated by a preceding test.
      vi.resetModules();
      vi.stubGlobal("fetch", fetchImpl);
      try {
        const { collectRecruitmentEvidence: collect } =
          await import("@/services/recruitment");
        const out = await collect(ctx.db, cfg, input, {
          limits:
            mode === "response_bytes"
              ? { maxResponseBytes: 2048 }
              : mode === "aggregate_bytes"
                ? { maxTotalBytes: Buffer.byteLength(sso) + 100 }
                : mode === "request_count"
                  ? { maxRequests: 2 }
                  : {},
        });
        expect(calls).toContain("/oauth/jwks");
        if (mode === "success") {
          expect(privateCalls).toHaveLength(6);
          expect(out.manifest.datasets.map((d) => d.status)).toEqual([
            "empty",
            "empty",
            "empty",
            "empty",
            "complete",
            "empty",
          ]);
        } else {
          expect(privateCalls).toEqual([]);
          expect(out.manifest.datasets.slice(1).map((d) => d.status)).toEqual(
            Array(5).fill("failed"),
          );
          if (mode === "request_count" || mode === "aggregate_bytes") {
            expect(calls).toEqual(["/v2/oauth/token", "/oauth/jwks"]);
            expect(out.manifest.datasets[0].status).toBe("failed");
          }
        }
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    "capture_touch",
    "rotation",
    "invalidation",
    "malformed_blob",
    "failure_audit",
  ])("bounds database statements and cancels blocked work: %s", async (mode) => {
    const { ch, input } = await seed();
    if (mode === "capture_touch")
      await ctx.db.update(session).set({ lastSeenAt: new Date(0) });
    if (mode === "malformed_blob")
      await ctx.db
        .update(character)
        .set({ refreshTokenEnc: "malformed" })
        .where(eq(character.id, ch.id));
    const blocker = await ctx.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      mode === "capture_touch"
        ? "SELECT id FROM session FOR UPDATE"
        : mode === "failure_audit"
          ? "LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE"
          : "SELECT id FROM character WHERE id = 90000001 FOR UPDATE",
    );
    const t = transport(
      await token(mode === "failure_audit" ? { owner: "mismatched" } : {}),
    );
    const fetchImpl: typeof fetch = async (url, init) =>
      mode === "invalidation" && String(url).includes("/v2/oauth/token")
        ? new Response('{"error":"invalid_grant"}', { status: 400 })
        : t.deps.fetchImpl(url, init);
    const pending = collectRecruitmentEvidence(ctx.db, cfg, input, {
      ...t.deps,
      fetchImpl,
      dbTimeoutMs: 100,
    }).then(
      () => "released",
      (error: unknown) => error,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        pending,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still blocked"), 1000);
        }),
      ]);
      expect(
        settled,
        "database work must terminate while the second transaction still holds the lock",
      ).toMatchObject({
        code: mode === "failure_audit" ? "identity_changed" : "collection_failed",
      });
      expect(t.privateCalls).toEqual([]);
    } finally {
      clearTimeout(timer);
      await blocker.query("ROLLBACK");
      blocker.release();
      await pending;
    }
    if (["rotation", "invalidation", "malformed_blob"].includes(mode)) {
      const [stored] = await ctx.db
        .select()
        .from(character)
        .where(eq(character.id, ch.id));
      expect(stored.refreshTokenEnc).toBe(
        mode === "malformed_blob" ? "malformed" : ch.refreshTokenEnc,
      );
      expect(stored.tokenStatus).toBe("valid");
      expect(
        await ctx.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, "token.invalidated")),
      ).toEqual([]);
    }
    // SET LOCAL must not change unrelated pool sessions.
    const fresh = await ctx.pool.connect();
    try {
      expect(
        (await fresh.query("SHOW statement_timeout")).rows[0].statement_timeout,
      ).toBe("0");
      expect((await fresh.query("SHOW lock_timeout")).rows[0].lock_timeout).toBe("0");
    } finally {
      fresh.release();
    }
  });

  it("uses only the documented fixed error codes", () => {
    for (const code of [
      "not_authorized",
      "not_found",
      "identity_changed",
      "collection_failed",
    ] as const) {
      const error = new RecruitmentCollectionError(code);
      expect(error.message).toBe(code);
      expect(error.code).toBe(code);
    }
  });
});

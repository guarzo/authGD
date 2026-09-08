import { createHash, sign } from "node:crypto";
import { eq } from "drizzle-orm";
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
import {
  account,
  fleetDevice,
  fleetDeviceSession,
  fleetPublisherLease,
  fleetTelemetryRow,
  fleetRecoveryChallenge,
} from "@/db/schema";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import {
  acknowledgeFleetCapabilities,
  readFleetDeviceState,
} from "@/services/fleet-device";
import {
  beginFleetRecovery,
  completeFleetRecovery,
  purgeExpiredFleetRecovery,
} from "@/services/fleet-recovery";
import { pairingChallengePreimage, revokeFleetDevice } from "@/services/fleet-pairing";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { setupTestDb, truncateAll } from "./helpers/db";
import {
  fleetKeyPair,
  pairDevice,
  waitUntilBlockedBy,
  reconcileFleetKeys,
} from "./helpers/fleet-sharing";
import { recoveryInitiation, recoveryCompletion } from "./helpers/fleet-recovery";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import { withInjectedPgFault } from "./helpers/pg-fault";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const ORIGIN = "https://auth.example";
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await truncateAll(ctx.db);
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: NOW,
  });
});
afterEach(() => vi.useRealTimers());

// Independent protocol construction: never lets a broken production builder sign
// its own expectations. All challenge/session credentials come from real services.
function preimage(key: Uint8Array, challengeId: string, nonce: string, origin = ORIGIN) {
  return Buffer.from(
    [
      "fleet-recovery-v1",
      origin,
      challengeId,
      nonce,
      createHash("sha256").update(key).digest("hex"),
    ].join("\n"),
  );
}
async function proofFor(
  keys: ReturnType<typeof fleetKeyPair>,
  now = NOW,
  origin = ORIGIN,
) {
  const challenge = await beginFleetRecovery(ctx.db, recoveryInitiation(keys, now));
  return {
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    recoverySignature: sign(
      null,
      preimage(keys.publicKeySpki, challenge.challengeId, challenge.nonce, origin),
      keys.privateKey,
    ).toString("base64url"),
    now,
  };
}
async function pairedMember(capabilities: string[] = [SHARED_CAPABILITY]) {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  return {
    owner,
    ...(await pairDevice(
      ctx.db,
      owner.id,
      new Date(NOW.getTime() - 31 * 60000),
      capabilities,
    )),
  };
}

// Removing recovery, consumption, state locks or the post-lock clock must each
// break real lifecycle assertions here; no handmade session hashes are inserted.
describe("registered-key recovery", () => {
  it("atomically bounds global storage/admission across keys and cleans only one expiry batch", async () => {
    const owner = await seedAccount(ctx.db, { tier: "member" });
    let keys = await pairDevice(ctx.db, owner.id, NOW);
    const lastExpiringKey = keys;
    const firstInitiation = recoveryInitiation(keys, new Date(NOW.getTime() + 1000));
    let firstChallenge: Awaited<ReturnType<typeof beginFleetRecovery>> | undefined;
    for (let i = 0; i < 1023; i++) {
      if (i > 0 && i % 4 === 0) keys = await pairDevice(ctx.db, owner.id, NOW);
      const c = await beginFleetRecovery(
        ctx.db,
        i === 0
          ? firstInitiation
          : recoveryInitiation(keys, i < 4 ? new Date(NOW.getTime() + 1000) : NOW),
      );
      if (i === 0) firstChallenge = c;
    }
    const contenders = [
      await pairDevice(ctx.db, owner.id, NOW),
      await pairDevice(ctx.db, owner.id, NOW),
    ];
    const results = await Promise.allSettled(
      contenders.map((k) => beginFleetRecovery(ctx.db, recoveryInitiation(k, NOW))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toMatchObject([
      { reason: { code: "rate_limited" } },
    ]);
    const full = await ctx.db
      .select()
      .from(fleetRecoveryChallenge)
      .orderBy(fleetRecoveryChallenge.id);
    expect(full).toHaveLength(1024);
    expect(await beginFleetRecovery(ctx.db, firstInitiation)).toEqual(firstChallenge);
    expect(
      await ctx.db
        .select()
        .from(fleetRecoveryChallenge)
        .orderBy(fleetRecoveryChallenge.id),
    ).toEqual(full);
    expect(
      await completeFleetRecovery(
        ctx.db,
        recoveryCompletion(lastExpiringKey, firstChallenge!, NOW),
      ),
    ).toMatchObject({ ok: true, value: { result: "reconnected" } });
    const expiry = new Date(NOW.getTime() + 120000);
    expect(await purgeExpiredFleetRecovery(ctx.db, expiry)).toBe(100);
    expect(await ctx.db.select().from(fleetRecoveryChallenge)).toHaveLength(924);
    await beginFleetRecovery(ctx.db, recoveryInitiation(contenders[0], expiry));
    expect(await ctx.db.select().from(fleetRecoveryChallenge)).toHaveLength(825);
    // Expired rows near the end of the cleanup backlog still count toward the
    // global storage cap, but must not impose a second per-key cooldown.
    await expect(
      beginFleetRecovery(
        ctx.db,
        recoveryInitiation(lastExpiringKey, new Date(NOW.getTime() + 121000)),
      ),
    ).resolves.toMatchObject({ nonce: expect.any(String) });
  }, 30000);

  it("canonicalizes public-key selectors, hashes nonce storage, and never charges invalid attempts", async () => {
    const keys = await pairedMember();
    const c = await beginFleetRecovery(ctx.db, recoveryInitiation(keys, NOW));
    const [row] = await ctx.db.select().from(fleetRecoveryChallenge);
    expect(row).toMatchObject({
      id: c.challengeId,
      publicKeySpkiB64: Buffer.from(keys.publicKeySpki).toString("base64"),
      nonceDigest: createHash("sha256").update(c.nonce).digest("base64url"),
      attempts: 0,
      consumedAt: null,
    });
    expect(JSON.stringify(row)).not.toContain(c.nonce);
    // OpenSSL accepts DER with trailing bytes; it must not provide another quota
    // selector for the same key. Pairing's existing encoding contract is untouched.
    const alternate = Buffer.concat([Buffer.from(keys.publicKeySpki), Buffer.from([0])]);
    for (let i = 0; i < 3; i++)
      await beginFleetRecovery(
        ctx.db,
        recoveryInitiation({ ...keys, publicKeySpki: alternate }, NOW),
      );
    await expect(
      beginFleetRecovery(ctx.db, recoveryInitiation(keys, NOW)),
    ).rejects.toMatchObject({ code: "rate_limited" });
    for (let i = 0; i < 6; i++)
      await completeFleetRecovery(ctx.db, {
        challengeId: c.challengeId,
        nonce: "bad",
        recoverySignature: "bad",
        now: NOW,
      });
    const [attempted] = await ctx.db
      .select()
      .from(fleetRecoveryChallenge)
      .where(eq(fleetRecoveryChallenge.id, c.challengeId));
    expect(attempted.attempts).toBe(0);
    await expect(
      ctx.db
        .update(fleetRecoveryChallenge)
        .set({ attempts: 6 })
        .where(eq(fleetRecoveryChallenge.id, c.challengeId)),
    ).rejects.toThrow();
  });

  it("globally disables bootstrap uniformly, including a previously issued valid proof", async () => {
    const paired = await pairedMember();
    const proof = await proofFor(paired);
    await transitionFleetSharingMode(ctx.db, { enabled: false, expectedRevision: 3 });
    for (const keys of [paired, fleetKeyPair()]) {
      await expect(
        beginFleetRecovery(ctx.db, recoveryInitiation(keys, NOW)),
      ).rejects.toMatchObject({ code: "feature_disabled" });
    }
    expect(await completeFleetRecovery(ctx.db, proof)).toEqual({
      ok: false,
      code: "feature_disabled",
    });
  });

  it("bounds per-key admission through expiry without exhausting valid proof", async () => {
    const paired = await pairedMember();
    const proof = await proofFor(paired);
    for (let i = 0; i < 5; i++)
      expect(
        await completeFleetRecovery(ctx.db, {
          ...proof,
          recoverySignature: "A".repeat(86),
        }),
      ).toEqual({ ok: false, code: "unauthorized" });
    expect(await completeFleetRecovery(ctx.db, proof)).toMatchObject({
      ok: true,
      value: { result: "reconnected" },
    });
    for (let i = 0; i < 3; i++) await proofFor(paired);
    await expect(proofFor(paired)).rejects.toMatchObject({ code: "rate_limited" });
    expect(
      await completeFleetRecovery(
        ctx.db,
        await proofFor(paired, new Date(NOW.getTime() + 120000)),
      ),
    ).toMatchObject({ ok: true, value: { result: "reconnected" } });
  });

  it("recovers an expired session, retires all old relay state, and starts an unacknowledged ceiling without enabling participation", async () => {
    const paired = await pairedMember();
    const [old] = await ctx.db.select().from(fleetDeviceSession);
    await ctx.db
      .update(fleetDeviceSession)
      .set({ acknowledgedCapabilities: [SHARED_CAPABILITY], lastRevision: 99 })
      .where(eq(fleetDeviceSession.id, old.id));
    const character = await seedCharacter(ctx.db, testConfig(), {
      id: 95900001,
      accountId: paired.owner.id,
    });
    await ctx.db.insert(fleetPublisherLease).values({
      characterId: character.id,
      deviceId: paired.device.id,
      sessionId: old.id,
      fleetId: 6100001,
      leaseExpiresAt: NOW,
    });
    await ctx.db.insert(fleetTelemetryRow).values({
      characterId: character.id,
      deviceId: paired.device.id,
      sessionId: old.id,
      fleetId: 6100001,
      dps: 12,
      receivedAt: NOW,
      staleAt: NOW,
      hardExpiresAt: NOW,
    });
    expect(
      await readFleetDeviceState(ctx.db, {
        sessionId: paired.sessionId,
        revision: 100,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "unauthorized" });
    const proof = await proofFor(paired);
    const first = await completeFleetRecovery(ctx.db, proof);
    expect(first).toMatchObject({
      ok: true,
      value: {
        result: "reconnected",
        deviceId: paired.device.id,
        approvedCapabilities: [SHARED_CAPABILITY],
        participation: { enabled: false, generation: 0 },
        sessionExpiresAt: new Date(NOW.getTime() + 30 * 60000),
      },
    });
    if (!first.ok || first.value.result !== "reconnected")
      throw new Error("recovery failed");
    expect(first.value.sessionId).not.toBe(paired.sessionId);
    const sessions = await ctx.db.select().from(fleetDeviceSession);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: createHash("sha256").update(first.value.sessionId).digest("base64url"),
      lastRevision: 0,
      lastReadAt: null,
      lastPublishAt: null,
      approvedCapabilities: [SHARED_CAPABILITY],
      acknowledgedCapabilities: [],
    });
    expect(sessions[0].id).not.toBe(first.value.sessionId);
    expect(await ctx.db.select().from(fleetPublisherLease)).toEqual([]);
    expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([]);
    expect(
      await completeFleetRecovery(ctx.db, {
        ...proof,
        now: new Date(NOW.getTime() + 1000),
      }),
    ).toEqual({ ok: false, code: "unauthorized" });
    expect(
      await readFleetDeviceState(ctx.db, {
        sessionId: first.value.sessionId,
        revision: 1,
        now: NOW,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        acknowledgedCapabilities: [],
        participation: { enabled: false, generation: 0 },
      },
    });
  });

  it("issues uniform signer-proven challenges for indexed active, expired and revoked keys", async () => {
    const expired = await pairedMember();
    const active = await pairDevice(ctx.db, expired.owner.id, NOW);
    const revoked = await pairDevice(ctx.db, expired.owner.id, NOW);
    await revokeFleetDevice(ctx.db, revoked.device.id, expired.owner.id, NOW);
    for (const keys of [active, expired, revoked]) {
      const c = await beginFleetRecovery(ctx.db, recoveryInitiation(keys, NOW));
      expect(c).toEqual({
        challengeId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        requestId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        expiresAt: new Date(NOW.getTime() + 120000),
      });
      expect(
        await completeFleetRecovery(ctx.db, {
          challengeId: c.challengeId,
          nonce: c.nonce,
          recoverySignature: "A".repeat(86),
          now: NOW,
        }),
      ).toEqual({ ok: false, code: "unauthorized" });
    }
  });

  it("allocates nothing for a signer-proven unknown key", async () => {
    await expect(proofFor(fleetKeyPair())).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(await ctx.db.select().from(fleetDevice)).toEqual([]);
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual([]);
    expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual([]);
  });

  it("only proves permanent revocation after signature verification and never resurrects a key", async () => {
    const paired = await pairedMember();
    const proof = await proofFor(paired);
    await revokeFleetDevice(ctx.db, paired.device.id, paired.owner.id, NOW);
    expect(await completeFleetRecovery(ctx.db, proof)).toEqual({
      ok: true,
      value: { result: "device_revoked" },
    });
    expect(await completeFleetRecovery(ctx.db, proof)).toEqual({
      ok: false,
      code: "unauthorized",
    });
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual([]);
  });

  it("temporary Member loss preserves registration, grants and local participation intent; restoration and cryo work", async () => {
    const paired = await pairedMember();
    await ctx.db
      .update(fleetDevice)
      .set({ participationEnabled: true, participationGeneration: 7 })
      .where(eq(fleetDevice.id, paired.device.id));
    await ctx.db
      .update(account)
      .set({ tier: "associate", isAdmin: true })
      .where(eq(account.id, paired.owner.id));
    const proof = await proofFor(paired);
    expect(await completeFleetRecovery(ctx.db, proof)).toEqual({
      ok: true,
      value: { result: "account_ineligible", retryAfterMs: 60000 },
    });
    expect(await completeFleetRecovery(ctx.db, proof)).toEqual({
      ok: false,
      code: "unauthorized",
    });
    const [device] = await ctx.db.select().from(fleetDevice);
    expect(device).toMatchObject({
      revokedAt: null,
      approvedCapabilities: [SHARED_CAPABILITY],
      participationEnabled: true,
      participationGeneration: 7,
    });
    await ctx.db
      .update(account)
      .set({ tier: "member", status: "cryo" })
      .where(eq(account.id, paired.owner.id));
    expect(await completeFleetRecovery(ctx.db, await proofFor(paired))).toMatchObject({
      ok: true,
      value: { result: "reconnected", participation: { enabled: true, generation: 7 } },
    });
  });

  it("recovers response loss through a fresh bounded challenge, not replay, and cannot invent grants", async () => {
    const paired = await pairedMember([]);
    const first = await completeFleetRecovery(ctx.db, await proofFor(paired));
    const second = await completeFleetRecovery(ctx.db, await proofFor(paired));
    expect(first).toMatchObject({
      ok: true,
      value: { result: "reconnected", approvedCapabilities: [] },
    });
    expect(second).toMatchObject({
      ok: true,
      value: { result: "reconnected", approvedCapabilities: [] },
    });
    if (
      !first.ok ||
      first.value.result !== "reconnected" ||
      !second.ok ||
      second.value.result !== "reconnected"
    )
      throw new Error("recovery failed");
    expect(second.value.sessionId).not.toBe(first.value.sessionId);
    expect(
      await readFleetDeviceState(ctx.db, {
        sessionId: first.value.sessionId,
        revision: 1,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "unauthorized" });
    expect(
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: second.value.sessionId,
        revision: 1,
        now: NOW,
        capabilities: [SHARED_CAPABILITY],
      }),
    ).toEqual({ ok: false, code: "capability_required" });
    expect(await ctx.db.select().from(fleetDeviceSession)).toHaveLength(1);
  });

  it("snapshots only existing browser-approved device rights into a new ceiling and retires every previous session", async () => {
    const paired = await pairedMember([]);
    await pairDevice(ctx.db, paired.owner.id, NOW, [SHARED_CAPABILITY], paired);
    const before = await ctx.db.select().from(fleetDeviceSession);
    expect(before).toHaveLength(2);
    expect(before.map((s) => s.approvedCapabilities)).toEqual(
      expect.arrayContaining([[], [SHARED_CAPABILITY]]),
    );
    const recovered = await completeFleetRecovery(ctx.db, await proofFor(paired));
    expect(recovered).toMatchObject({
      ok: true,
      value: { result: "reconnected", approvedCapabilities: [SHARED_CAPABILITY] },
    });
    const after = await ctx.db.select().from(fleetDeviceSession);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      approvedCapabilities: [SHARED_CAPABILITY],
      acknowledgedCapabilities: [],
    });
    expect(before.map((s) => s.id)).not.toContain(after[0].id);
  });

  it("does not free the per-key quota by completing challenges successfully", async () => {
    const paired = await pairedMember();
    for (let i = 0; i < 4; i++)
      expect(await completeFleetRecovery(ctx.db, await proofFor(paired))).toMatchObject({
        ok: true,
        value: { result: "reconnected" },
      });
    await expect(proofFor(paired)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("allows exactly one concurrent completion", async () => {
    const paired = await pairedMember();
    const proof = await proofFor(paired);
    const results = await Promise.all([
      completeFleetRecovery(ctx.db, proof),
      completeFleetRecovery(ctx.db, proof),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: "unauthorized" }]);
    expect(await ctx.db.select().from(fleetDeviceSession)).toHaveLength(1);
  });

  it.each(["nonce", "signature", "purpose", "origin", "expiry"])(
    "rejects wrong %s and never issues a session",
    async (kind) => {
      const paired = await pairedMember();
      const proof = await proofFor(
        paired,
        NOW,
        kind === "origin" ? "https://other.example" : ORIGIN,
      );
      if (kind === "nonce") proof.nonce = "B".repeat(43);
      if (kind === "signature") proof.recoverySignature = "A".repeat(86);
      if (kind === "purpose")
        proof.recoverySignature = sign(
          null,
          pairingChallengePreimage(proof.challengeId),
          paired.privateKey,
        ).toString("base64url");
      if (kind === "expiry") proof.now = new Date(NOW.getTime() + 120000);
      expect(await completeFleetRecovery(ctx.db, proof)).toEqual({
        ok: false,
        code: "unauthorized",
      });
      const [session] = await ctx.db.select().from(fleetDeviceSession);
      expect(session.expiresAt.getTime()).toBeLessThan(NOW.getTime());
    },
  );

  it("commits consumption even when session issuance fails, rolling back retirement via a savepoint", async () => {
    const paired = await pairedMember();
    const proof = await proofFor(paired);
    const before = await ctx.db.select().from(fleetDeviceSession);
    const result = await withInjectedPgFault(
      ctx.pool,
      { matchSql: /insert into "fleet_device_session"/i, code: "40001" },
      () => completeFleetRecovery(ctx.db, proof),
    );
    expect(result).toEqual({
      ok: true,
      value: { result: "retry_later", retryAfterMs: 1000 },
    });
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
    expect(await completeFleetRecovery(ctx.db, proof)).toEqual({
      ok: false,
      code: "unauthorized",
    });
    expect(await completeFleetRecovery(ctx.db, await proofFor(paired))).toMatchObject({
      ok: true,
      value: { result: "reconnected" },
    });
  });

  it.each([
    ["device", 0],
    ["account", 0],
    ["session", 0],
    ["character", 0],
    ["device", 1100],
  ] as const)(
    "rechecks expiry after the %s lock wait using the production clock (observation delayed %i ms)",
    async (level, observationDelayMs) => {
      const paired = await pairedMember();
      const proof = await proofFor(paired, new Date());
      let pending: ReturnType<typeof completeFleetRecovery> | undefined;
      if (level === "character") {
        const ch = await seedCharacter(ctx.db, testConfig(), {
          id: 95900002,
          accountId: paired.owner.id,
        });
        const [session] = await ctx.db.select().from(fleetDeviceSession);
        await ctx.db.insert(fleetPublisherLease).values({
          characterId: ch.id,
          deviceId: paired.device.id,
          sessionId: session.id,
          fleetId: 6100001,
          leaseExpiresAt: NOW,
        });
      }
      const client = await ctx.pool.connect();
      let bodyFailed = false;
      try {
        await client.query("begin");
        const {
          rows: [{ pid }],
        } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
        if (level === "device")
          await client.query("select id from fleet_device where id = $1 for update", [
            paired.device.id,
          ]);
        if (level === "account")
          await client.query("select id from account where id = $1 for update", [
            paired.owner.id,
          ]);
        if (level === "session")
          await client.query(
            "select id from fleet_device_session where device_id = $1 for update",
            [paired.device.id],
          );
        if (level === "character")
          await client.query("select pg_advisory_xact_lock(2, hashint8(95900002))");
        // Start the expiry budget only after fixture and holder setup is complete.
        await ctx.pool.query(
          "update fleet_recovery_challenge set expires_at = clock_timestamp() + interval '1 second' where id = $1",
          [proof.challengeId],
        );
        pending = completeFleetRecovery(ctx.db, { ...proof, now: undefined });
        // Own rejection while holding the lock, but still require exact expiry below.
        const outcome = pending.then(
          (reply) => reply,
          (err: unknown) => err,
        );
        const blocked = await waitUntilBlockedBy(ctx.pool, pid);
        // Exercise a late observation without faking the clock or the PG wait edge.
        if (observationDelayMs)
          await client.query("select pg_sleep($1)", [observationDelayMs / 1000]);
        expect(blocked).toBe(true);
        // Observation has already spent part (or all) of the expiry budget. An
        // unconditional extra sleep can instead hit the production 2s lock timeout.
        await client.query(
          "select pg_sleep_until(expires_at) from fleet_recovery_challenge where id = $1",
          [proof.challengeId],
        );
        await client.query("commit");
        expect(await outcome).toEqual({ ok: false, code: "unauthorized" });
        const [session] = await ctx.db.select().from(fleetDeviceSession);
        expect(session.expiresAt.getTime()).toBeLessThan(NOW.getTime());
        if (level === "character")
          expect(await ctx.db.select().from(fleetPublisherLease)).toHaveLength(1);
      } catch (error) {
        bodyFailed = true;
        throw error;
      } finally {
        try {
          await client.query("rollback").catch((error: unknown) => {
            // A secondary cleanup failure must not replace the original assertion.
            if (!bodyFailed) throw error;
          });
        } finally {
          // Discard the holder even if rollback fails, then drain its waiter.
          client.release(true);
          await pending?.catch(() => {});
        }
      }
    },
  );

  it("rechecks Member status after a concurrent account update", async () => {
    const paired = await pairedMember();
    const proof = await proofFor(paired);
    const client = await ctx.pool.connect();
    let pending: ReturnType<typeof completeFleetRecovery> | undefined;
    try {
      await client.query("begin");
      const {
        rows: [{ pid }],
      } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      await client.query("update account set tier = 'alumni' where id = $1", [
        paired.owner.id,
      ]);
      pending = completeFleetRecovery(ctx.db, proof);
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      await client.query("commit");
      expect(await pending).toEqual({
        ok: true,
        value: { result: "account_ineligible", retryAfterMs: 60000 },
      });
      const [device] = await ctx.db.select().from(fleetDevice);
      expect(device.revokedAt).toBeNull();
    } finally {
      await client.query("rollback");
      client.release();
      await pending;
    }
  });

  it("takes the shared mode lock before authoritative completion, observing a cutover after waiting", async () => {
    const paired = await pairedMember();
    const proof = await proofFor(paired);
    const client = await ctx.pool.connect();
    let pending: ReturnType<typeof completeFleetRecovery> | undefined;
    try {
      await client.query("begin");
      const {
        rows: [{ pid }],
      } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      await client.query("select pg_advisory_xact_lock(3, 0)");
      pending = completeFleetRecovery(ctx.db, proof);
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      await client.query("update fleet_sharing_gate set enabled = false where id = 1");
      await client.query("commit");
      expect(await pending).toEqual({ ok: false, code: "feature_disabled" });
      const [c] = await ctx.db.select().from(fleetRecoveryChallenge);
      expect(c.consumedAt).toBeNull();
    } finally {
      await client.query("rollback");
      client.release();
      await pending;
    }
  });

  it("rechecks a revocation committed while completion waits for the device", async () => {
    const paired = await pairedMember();
    const proof = await proofFor(paired);
    const client = await ctx.pool.connect();
    let pending: ReturnType<typeof completeFleetRecovery> | undefined;
    try {
      await client.query("begin");
      const {
        rows: [{ pid }],
      } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      await client.query("update fleet_device set revoked_at = $1 where id = $2", [
        NOW,
        paired.device.id,
      ]);
      pending = completeFleetRecovery(ctx.db, proof);
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      await client.query("commit");
      expect(await pending).toEqual({ ok: true, value: { result: "device_revoked" } });
    } finally {
      await client.query("rollback");
      client.release();
      await pending;
    }
  });
});

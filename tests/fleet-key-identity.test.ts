import { sign } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  fleetDevice,
  fleetDeviceKeyIdentity,
  fleetDeviceSession,
  fleetPairingRequest,
  fleetSharingGate,
} from "@/db/schema";
import {
  beginPairing,
  approvePairing,
  completePairing,
  pairingChallengePreimage,
  revokeFleetDevice,
  DeviceBoundToAnotherAccountError,
} from "@/services/fleet-pairing";
import { beginFleetRecovery, completeFleetRecovery } from "@/services/fleet-recovery";
import {
  FleetDeviceKeyUnavailableError,
  FleetIdentityMaintenanceError,
  startFleetKeyIdentityReconciliation,
  reconcileFleetKeyIdentityBatch,
  resolveFleetDeviceKey,
} from "@/services/fleet-key-identity";
import {
  readFleetKeyIdentityState,
  transitionFleetSharingMode,
} from "@/services/fleet-sharing-mode";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";
import {
  fleetKeyPair,
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";
import { recoveryCompletion, recoveryInitiation } from "./helpers/fleet-recovery";

const NOW = new Date("2026-09-07T12:00:00.000Z");
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());
beforeEach(async () => {
  await truncateAll(ctx.db);
});
const aliasOf = (keys: ReturnType<typeof fleetKeyPair>) => ({
  ...keys,
  publicKeySpki: Buffer.concat([Buffer.from(keys.publicKeySpki), Buffer.from([0])]),
});
const start = () =>
  startFleetKeyIdentityReconciliation(ctx.db, {
    expectedRevision: 0,
    oldWritersDrained: true,
    deletionWritersQuiescent: true,
  });
function completion(pairingId: string, keys: ReturnType<typeof fleetKeyPair>) {
  return {
    pairingId,
    completionSignature: sign(
      null,
      pairingChallengePreimage(pairingId),
      keys.privateKey,
    ).toString("base64url"),
    now: NOW,
  };
}

it.each(["different-account", "same-owner", "revoked-alias"])(
  "keeps %s duplicates sticky and leaves every original right and session unchanged",
  async (kind) => {
    const keys = fleetKeyPair();
    const owner = await seedAccount(ctx.db, { tier: "member" });
    const other =
      kind === "same-owner" ? owner : await seedAccount(ctx.db, { tier: "member" });
    const first = await pairDevice(ctx.db, owner.id, NOW, [], keys);
    const second = await pairDevice(ctx.db, other.id, NOW, [], aliasOf(keys));
    // Historical device grants are a corpus fixture, not new enrollment. Both
    // bindings/sessions themselves came through real legacy approval + key proof.
    await ctx.db
      .update(fleetDevice)
      .set({
        approvedCapabilities: [SHARED_CAPABILITY],
        participationEnabled: true,
        participationGeneration: 4,
      })
      .where(eq(fleetDevice.id, second.device.id));
    if (kind === "revoked-alias")
      await revokeFleetDevice(ctx.db, second.device.id, other.id, NOW);
    const devices = await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id);
    const sessions = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .orderBy(fleetDeviceSession.id);
    const ready = await reconcileFleetKeys(ctx.db);
    expect(await ctx.db.select().from(fleetDeviceKeyIdentity)).toEqual([
      {
        canonicalSpkiB64: Buffer.from(keys.publicKeySpki).toString("base64"),
        deviceId: null,
        conflicted: true,
      },
    ]);
    for (const k of [keys, aliasOf(keys)])
      await expect(
        beginPairing(ctx.db, { publicKeySpki: k.publicKeySpki, now: NOW }),
      ).rejects.toBeInstanceOf(FleetDeviceKeyUnavailableError);
    expect(await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id)).toEqual(
      devices,
    );
    expect(
      await ctx.db.select().from(fleetDeviceSession).orderBy(fleetDeviceSession.id),
    ).toEqual(sessions);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
    const afterToggle = await ctx.db.select().from(fleetDeviceSession);
    for (const k of [keys, aliasOf(keys)]) {
      const c = await beginFleetRecovery(ctx.db, recoveryInitiation(k, NOW));
      expect(await completeFleetRecovery(ctx.db, recoveryCompletion(k, c, NOW))).toEqual({
        ok: true,
        value: { result: "device_key_conflict" },
      });
    }
    expect(await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id)).toEqual(
      devices,
    );
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(afterToggle);
    await ctx.db.delete(fleetDevice).where(eq(fleetDevice.id, first.device.id));
    expect((await ctx.db.select().from(fleetDeviceKeyIdentity))[0].conflicted).toBe(true);
  },
);

it("resolves alias-only revoked registration as revoked, never as a fresh key", async () => {
  const keys = fleetKeyPair();
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const paired = await pairDevice(ctx.db, owner.id, NOW, [], aliasOf(keys));
  await revokeFleetDevice(ctx.db, paired.device.id, owner.id, NOW);
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
  const c = await beginFleetRecovery(ctx.db, recoveryInitiation(keys, NOW));
  expect(await completeFleetRecovery(ctx.db, recoveryCompletion(keys, c, NOW))).toEqual({
    ok: true,
    value: { result: "device_revoked" },
  });
  await expect(
    beginPairing(ctx.db, { publicKeySpki: keys.publicKeySpki }),
  ).rejects.toThrow();
});

it("retains deleted-binding tombstones and never reallocates them", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const paired = await pairDevice(ctx.db, owner.id, NOW);
  const ready = await reconcileFleetKeys(ctx.db);
  await expect(
    ctx.db.update(fleetDeviceKeyIdentity).set({ conflicted: true }),
  ).rejects.toThrow();
  await ctx.db.delete(fleetDevice).where(eq(fleetDevice.id, paired.device.id));
  expect((await ctx.db.select().from(fleetDeviceKeyIdentity))[0]).toMatchObject({
    deviceId: null,
    conflicted: false,
  });
  await expect(
    beginPairing(ctx.db, { publicKeySpki: aliasOf(paired).publicKeySpki }),
  ).rejects.toBeInstanceOf(FleetDeviceKeyUnavailableError);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
  await expect(
    beginFleetRecovery(ctx.db, recoveryInitiation(paired, NOW)),
  ).rejects.toMatchObject({ code: "unauthorized" });
});

it("serializes canonical/alias completions and prevents a cross-account claim", async () => {
  await reconcileFleetKeys(ctx.db);
  const keys = fleetKeyPair();
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const other = await seedAccount(ctx.db, { tier: "member" });
  const a = await beginPairing(ctx.db, { publicKeySpki: keys.publicKeySpki, now: NOW });
  const b = await beginPairing(ctx.db, {
    publicKeySpki: aliasOf(keys).publicKeySpki,
    now: NOW,
  });
  await approvePairing(ctx.db, a.pairingId, owner.id, NOW);
  await approvePairing(ctx.db, b.pairingId, other.id, NOW);
  const outcomes = await Promise.allSettled([
    completePairing(ctx.db, completion(a.pairingId, keys)),
    completePairing(ctx.db, completion(b.pairingId, keys)),
  ]);
  expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  const failure = outcomes.find((o) => o.status === "rejected");
  expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(
    DeviceBoundToAnotherAccountError,
  );
  expect(await ctx.db.select().from(fleetDevice)).toHaveLength(1);
  expect(await ctx.db.select().from(fleetDeviceKeyIdentity)).toHaveLength(1);
  expect(await ctx.db.select().from(fleetDeviceSession)).toHaveLength(1);
});

it("resolves old pending alias requests after ready and retains indexed identity after off", async () => {
  const keys = fleetKeyPair();
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const original = await pairDevice(ctx.db, owner.id, NOW, [], aliasOf(keys));
  const pending = await beginPairing(ctx.db, {
    publicKeySpki: keys.publicKeySpki,
    now: NOW,
  });
  const ready = await reconcileFleetKeys(ctx.db);
  await approvePairing(ctx.db, pending.pairingId, owner.id, NOW);
  await completePairing(ctx.db, completion(pending.pairingId, keys));
  const enabled = await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
  await pairDevice(ctx.db, owner.id, NOW, [SHARED_CAPABILITY], aliasOf(keys));
  await transitionFleetSharingMode(ctx.db, {
    enabled: false,
    expectedRevision: enabled.revision,
  });
  await pairDevice(ctx.db, owner.id, NOW, [], keys);
  const mode = await readFleetKeyIdentityState(ctx.db);
  expect(mode.keyIdentityPhase).toBe("ready");
  const resolution = await resolveFleetDeviceKey(
    ctx.db,
    Buffer.from(keys.publicKeySpki).toString("base64"),
    mode,
  );
  expect(resolution.device).toMatchObject({
    id: original.device.id,
    accountId: owner.id,
    approvedCapabilities: [SHARED_CAPABILITY],
  });
  expect(await ctx.db.select().from(fleetDevice)).toHaveLength(1);
});

it("does not drain on enable-before-ready; reconciliation blocks even approved legacy requests", async () => {
  const keys = fleetKeyPair();
  const owner = await seedAccount(ctx.db, { tier: "member" });
  await pairDevice(ctx.db, owner.id, NOW);
  const p = await beginPairing(ctx.db, { publicKeySpki: keys.publicKeySpki, now: NOW });
  await approvePairing(ctx.db, p.pairingId, owner.id, NOW);
  const sessions = await ctx.db.select().from(fleetDeviceSession);
  await expect(
    transitionFleetSharingMode(ctx.db, { enabled: true, expectedRevision: 0 }),
  ).rejects.toThrow("feature_disabled");
  expect(await ctx.db.select().from(fleetSharingGate)).toEqual([]);
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(sessions);
  const phase = await start();
  await expect(
    beginPairing(ctx.db, { publicKeySpki: keys.publicKeySpki }),
  ).rejects.toBeInstanceOf(FleetIdentityMaintenanceError);
  await expect(approvePairing(ctx.db, p.pairingId, owner.id, NOW)).rejects.toBeInstanceOf(
    FleetIdentityMaintenanceError,
  );
  await expect(
    completePairing(ctx.db, completion(p.pairingId, keys)),
  ).rejects.toBeInstanceOf(FleetIdentityMaintenanceError);
  await expect(
    beginFleetRecovery(ctx.db, recoveryInitiation(keys, NOW)),
  ).rejects.toMatchObject({ code: "feature_disabled" });
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(sessions);
  await reconcileFleetKeyIdentityBatch(ctx.db, { expectedRevision: phase.revision });
  await completePairing(ctx.db, completion(p.pairingId, keys));
});

it("resumes bounded UUID batches and leaves malformed persisted rows unready without partial writes", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  for (let i = 0; i < 101; i++) await pairDevice(ctx.db, owner.id, NOW);
  const devices = await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id);
  const sessions = await ctx.db
    .select()
    .from(fleetDeviceSession)
    .orderBy(fleetDeviceSession.id);
  const phase = await start();
  const first = await reconcileFleetKeyIdentityBatch(ctx.db, {
    expectedRevision: phase.revision,
  });
  expect(first).toMatchObject({
    keyIdentityPhase: "reconciling",
    keyIdentityCursor: devices[99].id,
  });
  expect(await ctx.db.select().from(fleetDeviceKeyIdentity)).toHaveLength(100);
  // Simulate revisiting a previously committed derived entry: no duplicate
  // original registration is manufactured and same-device mapping stays intact.
  await ctx.db
    .update(fleetSharingGate)
    .set({ keyIdentityCursor: null })
    .where(eq(fleetSharingGate.id, 1));
  expect(
    await reconcileFleetKeyIdentityBatch(ctx.db, { expectedRevision: first.revision }),
  ).toEqual(first);
  expect(
    (await ctx.db.select().from(fleetDeviceKeyIdentity)).every(
      (entry) => !entry.conflicted && entry.deviceId !== null,
    ),
  ).toBe(true);
  // Both bounded oversized projection and small malformed DER stop the batch.
  for (const invalid of ["x".repeat(10000), "AA=="]) {
    await ctx.db
      .update(fleetDevice)
      .set({ publicKeySpkiB64: invalid })
      .where(eq(fleetDevice.id, devices[100].id));
    await expect(
      reconcileFleetKeyIdentityBatch(ctx.db, { expectedRevision: first.revision }),
    ).rejects.toThrow("invalid_persisted_device_key");
    expect(await readFleetKeyIdentityState(ctx.db)).toEqual(first);
    expect(await ctx.db.select().from(fleetDeviceKeyIdentity)).toHaveLength(100);
  }
  await ctx.db
    .update(fleetDevice)
    .set({ publicKeySpkiB64: devices[100].publicKeySpkiB64 })
    .where(eq(fleetDevice.id, devices[100].id));
  const ready = await reconcileFleetKeyIdentityBatch(ctx.db, {
    expectedRevision: first.revision,
  });
  expect(ready.keyIdentityPhase).toBe("ready");
  expect(await ctx.db.select().from(fleetDeviceKeyIdentity)).toHaveLength(101);
  expect(await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id)).toEqual(
    devices,
  );
  expect(
    await ctx.db.select().from(fleetDeviceSession).orderBy(fleetDeviceSession.id),
  ).toEqual(sessions);
  await expect(start()).rejects.toThrow("conflict");
}, 30000);

it("a held legacy completion wins before explicit reconciliation starts, not after it", async () => {
  const keys = fleetKeyPair();
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const p = await beginPairing(ctx.db, {
    publicKeySpki: aliasOf(keys).publicKeySpki,
    now: NOW,
  });
  await approvePairing(ctx.db, p.pairingId, owner.id, NOW);
  const client = await ctx.pool.connect();
  let completionPending: ReturnType<typeof completePairing> | undefined;
  let starting: ReturnType<typeof start> | undefined;
  try {
    await client.query("begin");
    const {
      rows: [{ pid }],
    } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
    await client.query("select id from fleet_pairing_request where id = $1 for update", [
      p.pairingId,
    ]);
    completionPending = completePairing(ctx.db, completion(p.pairingId, keys));
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    starting = start();
    await client.query("commit");
    await completionPending;
    const phase = await starting;
    const ready = await reconcileFleetKeyIdentityBatch(ctx.db, {
      expectedRevision: phase.revision,
    });
    expect(ready.keyIdentityPhase).toBe("ready");
    expect(await ctx.db.select().from(fleetDeviceKeyIdentity)).toHaveLength(1);
    expect(
      (await ctx.db.select().from(fleetPairingRequest))[0].consumedAt,
    ).not.toBeNull();
  } finally {
    await client.query("rollback");
    client.release();
    await completionPending;
    await starting;
  }
});

it("pending/on is inconsistent and every pairing admission fails closed", async () => {
  await ctx.db.insert(fleetSharingGate).values({ enabled: true });
  const keys = fleetKeyPair();
  await expect(
    beginPairing(ctx.db, { publicKeySpki: keys.publicKeySpki }),
  ).rejects.toBeInstanceOf(FleetIdentityMaintenanceError);
  await expect(
    beginFleetRecovery(ctx.db, recoveryInitiation(keys, NOW)),
  ).rejects.toMatchObject({ code: "feature_disabled" });
  expect(await ctx.db.select().from(fleetDevice)).toEqual([]);
  await expect(
    ctx.db.execute(sql`update fleet_sharing_gate set key_identity_phase = 'invalid'`),
  ).rejects.toThrow();
});

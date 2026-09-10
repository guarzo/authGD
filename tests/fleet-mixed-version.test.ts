import { createHash, randomUUID, sign } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import {
  fleetKeyPair,
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";
import {
  participatingDevice,
  realSource,
  NOW,
  at,
} from "./helpers/fleet-shared-admission";
import { loadLegacyFleet, LEGACY_REVISION } from "./helpers/fleet-legacy";
import { canonicalFleetRequest } from "../src/lib/fleet-signature";
import { FLEET_READ_SCOPE } from "../src/lib/esi/client";
import {
  readFleetSharingMode,
  transitionFleetSharingMode,
  readFleetKeyIdentityState,
} from "../src/services/fleet-sharing-mode";
import { replaceDeviceProjection } from "../src/services/fleet-relay";
import {
  startFleetKeyIdentityReconciliation,
  reconcileFleetKeyIdentityBatch,
} from "../src/services/fleet-key-identity";
import {
  fleetDevice,
  fleetDeviceSession,
  fleetDeviceKeyIdentity,
  fleetEligibility,
  fleetPublisherLease,
  fleetTelemetryRow,
  fleetSourceIntent,
  outbox,
} from "../src/db/schema";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
let old: Awaited<ReturnType<typeof loadLegacyFleet>>;
beforeAll(async () => {
  ctx = await setupTestDb();
  old = await loadLegacyFleet();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(async () => {
  await ctx.cleanup();
});

it("rehearses quiescence acknowledgements, alias/conflict preservation and interrupted bounded readiness before enabling", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const aliasKey = fleetKeyPair();
  const alias = {
    ...aliasKey,
    publicKeySpki: new Uint8Array([...aliasKey.publicKeySpki, 0]),
  };
  const registered = await pairDevice(ctx.db, owner.id, NOW, [], alias);
  const conflictKey = fleetKeyPair();
  await pairDevice(ctx.db, owner.id, NOW, [], conflictKey);
  await pairDevice(ctx.db, owner.id, NOW, [], {
    ...conflictKey,
    publicKeySpki: new Uint8Array([...conflictKey.publicKeySpki, 0]),
  });
  for (let i = 0; i < 100; i++) await pairDevice(ctx.db, owner.id, NOW);
  const before = await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id);
  await expect(
    transitionFleetSharingMode(ctx.db, { enabled: true, expectedRevision: 0 }),
  ).rejects.toThrow("feature_disabled");
  for (const [oldWritersDrained, deletionWritersQuiescent] of [
    [false, true],
    [true, false],
  ])
    await expect(
      startFleetKeyIdentityReconciliation(ctx.db, {
        expectedRevision: 0,
        // Deliberately cross the typed operator boundary with false values.
        oldWritersDrained: oldWritersDrained as true,
        deletionWritersQuiescent: deletionWritersQuiescent as true,
      }),
    ).rejects.toThrow();
  // These booleans ACKNOWLEDGE an external deployment check; they cannot
  // discover whether arbitrary old replicas/deletion writers are quiescent.
  const started = await startFleetKeyIdentityReconciliation(ctx.db, {
    expectedRevision: 0,
    oldWritersDrained: true,
    deletionWritersQuiescent: true,
  });
  const partial = await reconcileFleetKeyIdentityBatch(ctx.db, {
    expectedRevision: started.revision,
  });
  expect(partial.keyIdentityPhase).toBe("reconciling");
  expect(partial.keyIdentityCursor).not.toBeNull();
  expect(await readFleetKeyIdentityState(ctx.db)).toEqual(partial);
  await expect(
    transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: partial.revision,
    }),
  ).rejects.toThrow("feature_disabled");
  const ready = await reconcileFleetKeyIdentityBatch(ctx.db, {
    expectedRevision: partial.revision,
  });
  expect(ready.keyIdentityPhase).toBe("ready");
  const index = await ctx.db.select().from(fleetDeviceKeyIdentity);
  expect(
    index.find(
      (i) =>
        i.canonicalSpkiB64 === Buffer.from(aliasKey.publicKeySpki).toString("base64"),
    )?.deviceId,
  ).toBe(registered.device.id);
  expect(
    index.find(
      (i) =>
        i.canonicalSpkiB64 === Buffer.from(conflictKey.publicKeySpki).toString("base64"),
    ),
  ).toMatchObject({ conflicted: true, deviceId: null });
  expect(await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id)).toEqual(before);
  const on = await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
  await transitionFleetSharingMode(ctx.db, {
    enabled: false,
    expectedRevision: on.revision,
  });
  expect((await readFleetKeyIdentityState(ctx.db)).keyIdentityPhase).toBe("ready");
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual([]);
  expect(await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id)).toEqual(before);
});

it("genuine pinned dispatcher drops new source work while default-off, rather than pretending an old worker understands it", async () => {
  expect(LEGACY_REVISION).toBe("62b2c6cd8d5ad7cc346ad4f96205e96e19f3e07d");
  expect(old.hashes["src/worker/dispatcher.ts"]).toMatch(/^[a-f0-9]{64}$/);
  expect((await readFleetSharingMode(ctx.db)).enabled).toBe(false);
  await ctx.db
    .insert(outbox)
    .values({ payload: { kind: "fleet-source", sourceId: randomUUID(), generation: 1 } });
  const send = vi.fn(async () => undefined);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await old.dispatchOutbox(ctx.db, send)).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect((await ctx.db.select().from(outbox))[0].dispatchedAt).not.toBeNull();
    expect(log).toHaveBeenCalledWith(
      "outbox payload not dispatchable; dropping row",
      expect.any(Object),
    );
  } finally {
    log.mockRestore();
  }
});

it("actual old reader locks block cutover, queued authenticated old read fails after drain, and rollback permits no old access to shared rows", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 91910001,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const legacy = await pairDevice(ctx.db, owner.id, NOW);
  // Compatibility-only legacy state. This cache is NEVER new shared authority.
  await ctx.db.insert(fleetEligibility).values({
    characterId: boss.id,
    accountId: owner.id,
    fleetId: 6200001,
    rosterCharacterIds: [boss.id],
    verifiedAt: NOW,
    expiresAt: at(60_000),
    outcomeCode: "ok",
  });
  expect(
    await old.replaceDeviceProjection(ctx.db, {
      sessionId: legacy.sessionId,
      revision: 1,
      now: NOW,
      rows: [{ characterId: boss.id, dps: 42, ewar: [] }],
    }),
  ).toEqual({ ok: true });
  const ready = await reconcileFleetKeys(ctx.db);
  const authHeaders = {
    sessionId: legacy.sessionId,
    issuedAt: at(1000).toISOString(),
    revision: 3,
    bodySha256: createHash("sha256").update("").digest("hex"),
    signature: "",
  };
  const path = "/api/fleet/v1/snapshot";
  authHeaders.signature = sign(
    null,
    canonicalFleetRequest({ protocol: 1, method: "GET", path, ...authHeaders }),
    legacy.privateKey,
  ).toString("base64url");
  const authenticated = await old.authenticateFleetRequest(
    ctx.db,
    authHeaders,
    new Uint8Array(),
    { method: "GET", path, now: at(1000) },
  );
  expect(authenticated.ok).toBe(true);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let admitted!: (pid: number) => void;
  const admission = new Promise<number>((resolve) => {
    admitted = resolve;
  });
  const reader = ctx.db.transaction(async (tx) => {
    const result = await old.readFleetProjection(tx, {
      sessionId: legacy.sessionId,
      revision: 2,
      now: at(500),
    });
    expect(result).toMatchObject({ ok: true, rows: [{ dps: 42 }] });
    const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    admitted(pid.rows[0].pid);
    // Preserve the actual reader's locks until the response owner is released.
    await hold;
  });
  const pid = await admission;
  let cutover: ReturnType<typeof transitionFleetSharingMode> | undefined;
  let queued: ReturnType<typeof old.readFleetProjection> | undefined;
  try {
    cutover = transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: at(1000),
    });
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    expect((await readFleetSharingMode(ctx.db)).enabled).toBe(false);
    queued = old.readFleetProjection(ctx.db, {
      sessionId: legacy.sessionId,
      revision: 3,
      now: at(1000),
    });
    // Queue order is observed in PostgreSQL, not inferred from a sleep.
    await vi.waitFor(async () => {
      const waits = await ctx.pool.query<{ n: number }>(
        "select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
      );
      expect(waits.rows[0].n).toBeGreaterThanOrEqual(2);
    });
  } finally {
    release();
    await reader;
  }
  await cutover;
  expect(await queued).toEqual({ ok: false, code: "forbidden" });
  expect(await ctx.db.select().from(fleetEligibility)).toEqual([]);
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual([]);
  const current = await participatingDevice(ctx.db, owner.id);
  await realSource(ctx.db, current, boss, 6200001, [boss.id]);
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: current.sessionId,
      revision: 4,
      now: at(2500),
      rows: [{ characterId: boss.id, dps: 99, ewar: [] }],
    }),
  ).toEqual({ ok: true });
  expect(await ctx.db.select().from(fleetTelemetryRow)).toHaveLength(1);
  expect(
    await old.readFleetProjection(ctx.db, {
      sessionId: legacy.sessionId,
      revision: 4,
      now: at(3000),
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  // Even a new capable session cannot make the OLD reader discover authority.
  expect(
    await old.readFleetProjection(ctx.db, {
      sessionId: current.sessionId,
      revision: 5,
      now: at(3000),
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  const devices = await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id);
  const index = await ctx.db
    .select()
    .from(fleetDeviceKeyIdentity)
    .orderBy(fleetDeviceKeyIdentity.canonicalSpkiB64);
  await transitionFleetSharingMode(ctx.db, {
    enabled: false,
    expectedRevision: ready.revision + 1,
    now: at(3500),
  });
  for (const table of [
    fleetTelemetryRow,
    fleetPublisherLease,
    fleetDeviceSession,
    fleetEligibility,
  ])
    expect(await ctx.db.select().from(table)).toEqual([]);
  expect(
    (await ctx.db.select().from(fleetSourceIntent)).every((s) => s.state === "ended"),
  ).toBe(true);
  expect(await ctx.db.select().from(fleetDevice).orderBy(fleetDevice.id)).toEqual(
    devices,
  );
  expect(
    await ctx.db
      .select()
      .from(fleetDeviceKeyIdentity)
      .orderBy(fleetDeviceKeyIdentity.canonicalSpkiB64),
  ).toEqual(index);
  expect((await readFleetKeyIdentityState(ctx.db)).keyIdentityPhase).toBe("ready");
  expect(
    await old.readFleetProjection(ctx.db, {
      sessionId: current.sessionId,
      revision: 6,
      now: at(4000),
    }),
  ).toEqual({ ok: false, code: "forbidden" });
});

import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  fleetDevice,
  fleetDeviceSession,
  fleetEligibility,
  fleetPublisherLease,
  fleetTelemetryRow,
} from "@/db/schema";
import {
  readFleetSharingMode,
  transitionFleetSharingMode,
} from "@/services/fleet-sharing-mode";
import { parseModeOptions, runFleetSharingMode } from "../scripts/fleet-sharing-mode";
import { readFleetProjection, replaceDeviceProjection } from "@/services/fleet-relay";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { setupTestDb, truncateAll } from "./helpers/db";
import { testConfig } from "./helpers/config";
import { seedAccount, seedCharacter } from "./helpers/seed";
import {
  pairDevice,
  waitUntilBlockedBy,
  reconcileFleetKeys,
} from "./helpers/fleet-sharing";

const NOW = new Date("2026-09-07T12:00:00Z");
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());

async function legacyFixture() {
  const member = await seedAccount(ctx.db, { tier: "member" });
  const paired = await pairDevice(ctx.db, member.id, NOW);
  await seedCharacter(ctx.db, testConfig(), {
    id: 95998001,
    accountId: member.id,
    scopes: [FLEET_READ_SCOPE],
  });
  // Only a compatibility fixture, never new-model authority.
  await ctx.db.insert(fleetEligibility).values({
    characterId: 95998001,
    accountId: member.id,
    fleetId: 6200001,
    rosterCharacterIds: [95998001],
    verifiedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60000),
    outcomeCode: "ok",
  });
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: paired.sessionId,
      revision: 1,
      now: NOW,
      sampledAtMs: NOW.getTime(),
      rows: [
        {
          characterId: 95998001,
          outgoingDps: 42,
          incomingDps: null,
          activityAgeMs: 0,
          effects: [],
        },
      ],
    }),
  ).toEqual({ ok: false, code: "feature_disabled" });
  // Retained-state lifecycle fixture only. Off cannot publish or serve these
  // rows; mode drain must still remove them without discarding registrations.
  const common = {
    characterId: 95998001,
    deviceId: paired.device.id,
    sessionId: createHash("sha256").update(paired.sessionId).digest("base64url"),
    fleetId: 6200001,
  };
  await ctx.db
    .insert(fleetPublisherLease)
    .values({ ...common, leaseExpiresAt: new Date(NOW.getTime() + 10000) });
  await ctx.db.insert(fleetTelemetryRow).values({
    ...common,
    publicationId: randomUUID(),
    outgoingDps: 42,
    incomingDps: null,
    sampledAtMs: NOW.getTime(),
    activityOriginMs: NOW.getTime(),
    effects: [],
    receivedAt: NOW,
    staleAt: new Date(NOW.getTime() + 3000),
    hardExpiresAt: new Date(NOW.getTime() + 10000),
  });
  return { ...paired, member };
}

describe("operator-only fleet sharing cutover", () => {
  it("requires explicit apply/dry-run intent and keeps the intermediate CLI non-release-ready", async () => {
    expect(() => parseModeOptions([])).toThrow(
      "explicit_mode_target_and_revision_required",
    );
    expect(() =>
      parseModeOptions(["--apply", "--dry-run", "--enable", "--expected-revision", "0"]),
    ).toThrow();
    expect(() =>
      parseModeOptions(["--dry-run", "--enable", "--expected-revision", "-1"]),
    ).toThrow("invalid_revision");
    const paired = await legacyFixture();
    const dry = parseModeOptions(["--dry-run", "--enable", "--expected-revision", "0"]);
    expect(await runFleetSharingMode(ctx.db, dry)).toMatchObject({
      dryRun: true,
      releaseReady: false,
      sessionsToRetire: 1,
      legacyEligibilityToDelete: 1,
      telemetryToDelete: 1,
      revisionMatches: true,
    });
    await expect(runFleetSharingMode(ctx.db, { ...dry, apply: true })).rejects.toThrow(
      "compatible_web_worker_and_drained_old_replicas_required",
    );
    await expect(
      runFleetSharingMode(ctx.db, {
        ...dry,
        apply: true,
        compatibleWeb: true,
        compatibleWorker: true,
        oldReplicasDrained: true,
      }),
    ).rejects.toThrow("full_source_model_not_release_ready");
    expect((await readFleetSharingMode(ctx.db)).enabled).toBe(false);
    expect(
      await readFleetProjection(ctx.db, {
        sessionId: paired.sessionId,
        revision: 2,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "feature_disabled" });
    expect(await ctx.db.select().from(fleetTelemetryRow)).toMatchObject([
      { outgoingDps: 42 },
    ]);
  });
  it("defaults off and drains legacy authority, sessions and rows while retaining registrations", async () => {
    expect(await readFleetSharingMode(ctx.db)).toEqual({
      enabled: false,
      revision: 0,
      transitionedAt: null,
    });
    const { device, sessionId, member } = await legacyFixture();
    const second = await pairDevice(ctx.db, member.id, NOW);
    await pairDevice(ctx.db, member.id, NOW, [], second);
    expect(
      await readFleetProjection(ctx.db, { sessionId, revision: 2, now: NOW }),
    ).toEqual({ ok: false, code: "feature_disabled" });
    expect(await ctx.db.select().from(fleetTelemetryRow)).toMatchObject([
      { outgoingDps: 42 },
    ]);
    const ready = await reconcileFleetKeys(ctx.db);
    expect(
      await transitionFleetSharingMode(ctx.db, {
        enabled: true,
        expectedRevision: ready.revision,
        now: NOW,
      }),
    ).toEqual({ enabled: true, revision: ready.revision + 1, transitionedAt: NOW });
    for (const table of [
      fleetDeviceSession,
      fleetEligibility,
      fleetPublisherLease,
      fleetTelemetryRow,
    ])
      expect(await ctx.db.select().from(table)).toEqual([]);
    const [retained] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.id, device.id));
    expect(retained).toEqual(device);
    expect(
      await readFleetProjection(ctx.db, { sessionId, revision: 3, now: NOW }),
    ).toEqual({ ok: false, code: "forbidden" });
  });

  it("never admits legacy authority into shared mode even if a fixture restores the old cache", async () => {
    const { member } = await legacyFixture();
    const [legacyAuthority] = await ctx.db.select().from(fleetEligibility);
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
    const fresh = await pairDevice(ctx.db, member.id, NOW);
    // Deliberately adversarial fixture, not a supported production writer.
    await ctx.db.insert(fleetEligibility).values(legacyAuthority);
    expect(
      await replaceDeviceProjection(ctx.db, {
        sessionId: fresh.sessionId,
        revision: 1,
        now: NOW,
        sampledAtMs: NOW.getTime(),
        rows: [
          {
            characterId: 95998001,
            outgoingDps: 91,
            incomingDps: null,
            activityAgeMs: 0,
            effects: [],
          },
        ],
      }),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(
      await readFleetProjection(ctx.db, {
        sessionId: fresh.sessionId,
        revision: 1,
        now: NOW,
      }),
    ).toEqual({ ok: false, code: "forbidden" });
  });

  it("rejects stale revisions without draining and drains again on rollback", async () => {
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
    const member = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(ctx.db, member.id, NOW);
    await expect(
      transitionFleetSharingMode(ctx.db, {
        enabled: false,
        expectedRevision: 0,
        now: NOW,
      }),
    ).rejects.toThrow("conflict");
    expect(await ctx.db.select().from(fleetDeviceSession)).toHaveLength(1);
    await transitionFleetSharingMode(ctx.db, {
      enabled: false,
      expectedRevision: ready.revision + 1,
      now: NOW,
    });
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual([]);
    expect((await ctx.db.select().from(fleetDevice))[0].id).toBe(paired.device.id);
    expect(await readFleetSharingMode(ctx.db)).toEqual({
      enabled: false,
      revision: ready.revision + 2,
      transitionedAt: NOW,
    });
  });

  it("waits for a held pre-transition session; that retired session cannot select a new row after cutover", async () => {
    const { device, sessionId, member } = await legacyFixture();
    const ready = await reconcileFleetKeys(ctx.db);
    const key = createHash("sha256").update(sessionId).digest("base64url");
    const client = await ctx.pool.connect();
    let transition: ReturnType<typeof transitionFleetSharingMode> | undefined;
    try {
      await client.query("begin");
      const {
        rows: [{ pid }],
      } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      // This retained-state fixture holds only the read-side session lock.
      // The transition must wait even without a mode/advisory lock. Actual
      // pinned old-reader code is exercised separately on the pre-0025 DB.
      await client.query("select id from fleet_device_session where id = $1 for update", [
        key,
      ]);
      transition = transitionFleetSharingMode(ctx.db, {
        enabled: true,
        expectedRevision: ready.revision,
        now: NOW,
      });
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      const oldRows = await client.query(
        "select outgoing_dps from fleet_telemetry_row where fleet_id = 6200001",
      );
      expect(oldRows.rows).toEqual([{ outgoing_dps: 42 }]);
      expect((await readFleetSharingMode(ctx.db)).enabled).toBe(false);
    } finally {
      await client.query("rollback");
      client.release();
      await transition;
    }
    const fresh = await pairDevice(ctx.db, member.id, NOW);
    const [freshSession] = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, fresh.device.id));
    // Synthetic future row, not evidence of a shared publisher (Task 5).
    await ctx.db.insert(fleetTelemetryRow).values({
      characterId: 95998001,
      fleetId: 6200001,
      deviceId: fresh.device.id,
      sessionId: freshSession.id,
      publicationId: randomUUID(),
      outgoingDps: 99,
      incomingDps: null,
      sampledAtMs: NOW.getTime(),
      activityOriginMs: NOW.getTime(),
      effects: [],
      receivedAt: NOW,
      staleAt: new Date(NOW.getTime() + 3000),
      hardExpiresAt: new Date(NOW.getTime() + 10000),
    });
    expect(await ctx.db.select().from(fleetTelemetryRow)).toHaveLength(1);
    expect(
      await ctx.db
        .select()
        .from(fleetDeviceSession)
        .where(eq(fleetDeviceSession.id, key)),
    ).toEqual([]);
    expect(
      await readFleetProjection(ctx.db, { sessionId, revision: 3, now: NOW }),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(
      (await ctx.db.select().from(fleetDevice).where(eq(fleetDevice.id, device.id)))[0]
        .revokedAt,
    ).toBeNull();
  });
});

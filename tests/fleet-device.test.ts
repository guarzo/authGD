import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { account, fleetDevice, fleetDeviceSession } from "@/db/schema";
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
  approvePairing,
  beginPairing,
  completePairing,
  pairingChallengePreimage,
  revokeFleetDevice,
} from "@/services/fleet-pairing";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import {
  pairDevice,
  waitUntilBlockedBy,
  reconcileFleetKeys,
} from "./helpers/fleet-sharing";
import { readDeviceCatalogueForSession } from "@/services/fleet-relay";
import { seedAccount } from "./helpers/seed";
import {
  acknowledgeFleetCapabilities,
  readFleetDeviceState,
} from "@/services/fleet-device";
import { setupTestDb, truncateAll } from "./helpers/db";

const NOW = new Date("2026-09-07T12:00:00Z");
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
afterEach(() => vi.useRealTimers());

describe("explicit shared fleet capability consent", () => {
  it("cannot self-grant shared capabilities from a legacy pairing", async () => {
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
    const member = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, member.id, NOW, []);
    expect(
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId,
        revision: 1,
        now: NOW,
        capabilities: [SHARED_CAPABILITY],
      }),
    ).toEqual({ ok: false, code: "capability_required" });
    expect(
      await readFleetDeviceState(ctx.db, { sessionId, revision: 1, now: NOW }),
    ).toMatchObject({
      ok: true,
      value: {
        approvedCapabilities: [],
        sessionApprovedCapabilities: [],
        acknowledgedCapabilities: [],
        participation: { enabled: false, generation: 0 },
      },
    });
  });
  it("a retained-key upgrade grants a new session, never a previously-issued session", async () => {
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
    const member = await seedAccount(ctx.db, { tier: "member", status: "cryo" });
    const legacy = await pairDevice(ctx.db, member.id, NOW);
    const upgraded = await pairDevice(
      ctx.db,
      member.id,
      NOW,
      [SHARED_CAPABILITY],
      legacy,
    );
    expect(upgraded.device.id).toBe(legacy.device.id);
    expect(
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: legacy.sessionId,
        revision: 1,
        now: NOW,
        capabilities: [SHARED_CAPABILITY],
      }),
    ).toEqual({ ok: false, code: "capability_required" });
    expect(
      await readFleetDeviceState(ctx.db, {
        sessionId: legacy.sessionId,
        revision: 1,
        now: NOW,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        approvedCapabilities: [SHARED_CAPABILITY],
        sessionApprovedCapabilities: [],
        acknowledgedCapabilities: [],
      },
    });
    expect(
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: upgraded.sessionId,
        revision: 1,
        now: NOW,
        capabilities: [SHARED_CAPABILITY],
      }),
    ).toMatchObject({
      ok: true,
      value: {
        approvedCapabilities: [SHARED_CAPABILITY],
        sessionApprovedCapabilities: [SHARED_CAPABILITY],
        acknowledgedCapabilities: [SHARED_CAPABILITY],
        participation: { enabled: false, generation: 0 },
      },
    });
    const legacyAgain = await pairDevice(ctx.db, member.id, NOW, [], legacy);
    expect(
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: legacyAgain.sessionId,
        revision: 1,
        now: NOW,
        capabilities: [SHARED_CAPABILITY],
      }),
    ).toEqual({ ok: false, code: "capability_required" });
  });

  it("requires the current device grant as well as the immutable session ceiling", async () => {
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
    const member = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(ctx.db, member.id, NOW, [SHARED_CAPABILITY]);
    await ctx.db
      .update(fleetDevice)
      .set({ approvedCapabilities: [] })
      .where(eq(fleetDevice.id, paired.device.id));
    expect(
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: paired.sessionId,
        revision: 1,
        now: NOW,
        capabilities: [SHARED_CAPABILITY],
      }),
    ).toEqual({ ok: false, code: "capability_required" });
  });

  it("never moves a retained key to another account during capability approval", async () => {
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
    const first = await seedAccount(ctx.db, { tier: "member" });
    const other = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(ctx.db, first.id, NOW);
    await expect(
      pairDevice(ctx.db, other.id, NOW, [SHARED_CAPABILITY], paired),
    ).rejects.toThrow("different account");
    expect(
      await readFleetDeviceState(ctx.db, {
        sessionId: paired.sessionId,
        revision: 1,
        now: NOW,
      }),
    ).toMatchObject({
      ok: true,
      value: { approvedCapabilities: [], sessionApprovedCapabilities: [] },
    });
  });

  it("shares cadence and revision with catalogue and distinguishes Member from admin standing", async () => {
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
    const member = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, member.id, NOW, [SHARED_CAPABILITY]);
    expect(
      (await readFleetDeviceState(ctx.db, { sessionId, revision: 1, now: NOW })).ok,
    ).toBe(true);
    expect(
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId,
        revision: 2,
        now: NOW,
        capabilities: [SHARED_CAPABILITY],
      }),
    ).toEqual({ ok: false, code: "rate_limited" });
    const later = new Date(NOW.getTime() + 500);
    expect(
      (
        await acknowledgeFleetCapabilities(ctx.db, {
          sessionId,
          revision: 2,
          now: later,
          capabilities: [SHARED_CAPABILITY],
        })
      ).ok,
    ).toBe(true);
    expect(
      await readDeviceCatalogueForSession(ctx.db, { sessionId, revision: 3, now: later }),
    ).toEqual({ ok: false, code: "rate_limited" });
    expect(
      await readFleetDeviceState(ctx.db, {
        sessionId,
        revision: 2,
        now: new Date(NOW.getTime() + 1000),
      }),
    ).toEqual({ ok: false, code: "revision_replayed" });
    await ctx.db
      .update(account)
      .set({ tier: "alumni", isAdmin: true })
      .where(eq(account.id, member.id));
    expect(
      await readFleetDeviceState(ctx.db, {
        sessionId,
        revision: 3,
        now: new Date(NOW.getTime() + 1000),
      }),
    ).toEqual({ ok: false, code: "forbidden" });
  });

  it("blocks acknowledgment while off, but signed setup and legacy pairing remain available", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, member.id, NOW);
    expect(
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId,
        revision: 1,
        now: NOW,
        capabilities: [SHARED_CAPABILITY],
      }),
    ).toEqual({ ok: false, code: "feature_disabled" });
    expect(
      await readFleetDeviceState(ctx.db, { sessionId, revision: 1, now: NOW }),
    ).toMatchObject({
      ok: true,
      value: { featureEnabled: false, participation: { enabled: false, generation: 0 } },
    });
  });

  it("rechecks enrollment at approval and completion after the operator disables sharing", async () => {
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
    const member = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(ctx.db, member.id, NOW);
    const args = {
      publicKeySpki: paired.publicKeySpki,
      requestedCapabilities: [SHARED_CAPABILITY],
      now: NOW,
    };
    const pending = await beginPairing(ctx.db, args);
    const approved = await beginPairing(ctx.db, args);
    await approvePairing(ctx.db, approved.pairingId, member.id, NOW);
    await transitionFleetSharingMode(ctx.db, {
      enabled: false,
      expectedRevision: ready.revision + 1,
      now: NOW,
    });
    await expect(
      approvePairing(ctx.db, pending.pairingId, member.id, NOW),
    ).rejects.toThrow("feature_disabled");
    await expect(
      completePairing(ctx.db, {
        pairingId: approved.pairingId,
        now: NOW,
        completionSignature: ed25519Sign(
          null,
          pairingChallengePreimage(approved.pairingId),
          paired.privateKey,
        ).toString("base64url"),
      }),
    ).rejects.toThrow("feature_disabled");
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual([]);
  });

  it("samples device admission and commits cadence after the session lock wait", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(ctx.db, member.id, NOW);
    const client = await ctx.pool.connect();
    let pending: ReturnType<typeof readFleetDeviceState> | undefined;
    const later = new Date(NOW.getTime() + 1000);
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      await client.query("begin");
      const {
        rows: [{ pid }],
      } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      await client.query(
        "select id from fleet_device_session where device_id = $1 for update",
        [paired.device.id],
      );
      pending = readFleetDeviceState(ctx.db, {
        sessionId: paired.sessionId,
        revision: 1,
      });
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      vi.setSystemTime(later);
      await client.query("commit");
      expect((await pending).ok).toBe(true);
      const [session] = await ctx.db
        .select()
        .from(fleetDeviceSession)
        .where(eq(fleetDeviceSession.deviceId, paired.device.id));
      expect(session.lastReadAt).toEqual(later);
      expect(
        await readDeviceCatalogueForSession(ctx.db, {
          sessionId: paired.sessionId,
          revision: 2,
        }),
      ).toEqual({ ok: false, code: "rate_limited" });
    } finally {
      await client.query("rollback");
      client.release();
      await pending;
    }
  });

  it("unknown, expired and revoked sessions share the same setup refusal", async () => {
    const member = await seedAccount(ctx.db, { tier: "member" });
    const paired = await pairDevice(ctx.db, member.id, NOW);
    const expired = await readFleetDeviceState(ctx.db, {
      sessionId: paired.sessionId,
      revision: 1,
      now: new Date(NOW.getTime() + 30 * 60000),
    });
    await revokeFleetDevice(ctx.db, paired.device.id, member.id, NOW);
    expect(
      await readFleetDeviceState(ctx.db, {
        sessionId: paired.sessionId,
        revision: 1,
        now: NOW,
      }),
    ).toEqual(expired);
    expect(
      await readFleetDeviceState(ctx.db, {
        sessionId: "unknown-session",
        revision: 1,
        now: NOW,
      }),
    ).toEqual(expired);
    expect(expired).toEqual({ ok: false, code: "unauthorized" });
  });

  it("binds the browser-approved requested capability without enabling participation", async () => {
    const ready = await reconcileFleetKeys(ctx.db);
    await transitionFleetSharingMode(ctx.db, {
      enabled: true,
      expectedRevision: ready.revision,
      now: NOW,
    });
    const member = await seedAccount(ctx.db, { tier: "member" });
    const { device } = await pairDevice(ctx.db, member.id, NOW, [SHARED_CAPABILITY]);
    expect(device.approvedCapabilities).toEqual([SHARED_CAPABILITY]);
    expect(device.participationEnabled).toBe(false);
    expect(device.participationGeneration).toBe(0);
  });
  it("defaults to disabled for new shared enrollment but keeps legacy pairing available", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const args = {
      publicKeySpki: new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
      now: NOW,
      requestedCapabilities: ["shared-source-v1"],
    };
    await expect(beginPairing(ctx.db, args)).rejects.toThrow("feature_disabled");
    await expect(
      beginPairing(ctx.db, { ...args, requestedCapabilities: [] }),
    ).resolves.toHaveProperty("pairingId");
  });
});

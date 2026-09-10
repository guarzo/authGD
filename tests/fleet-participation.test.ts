import { createHash } from "node:crypto";
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
  auditLog,
  fleetDevice,
  fleetDeviceSession,
  fleetPublisherLease,
  fleetTelemetryRow,
} from "@/db/schema";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import {
  acknowledgeFleetCapabilities,
  readFleetDeviceState,
} from "@/services/fleet-device";
import { setFleetParticipation } from "@/services/fleet-participation";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { readDeviceCatalogueForSession } from "@/services/fleet-relay";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";
import { withInjectedPgFault } from "./helpers/pg-fault";

const NOW = new Date("2026-09-07T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
afterEach(() => vi.useRealTimers());

async function setup() {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: NOW,
  });
  const owner = await seedAccount(ctx.db, { tier: "member", status: "cryo" });
  const paired = await pairDevice(ctx.db, owner.id, NOW, [SHARED_CAPABILITY]);
  expect(
    (
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: paired.sessionId,
        revision: 1,
        now: NOW,
        capabilities: [SHARED_CAPABILITY],
      })
    ).ok,
  ).toBe(true);
  return { owner, ...paired };
}

async function projection(p: Awaited<ReturnType<typeof setup>>) {
  await setFleetParticipation(ctx.db, {
    sessionId: p.sessionId,
    revision: 2,
    now: at(500),
    enabled: true,
    expectedGeneration: 0,
  });
  const ch = await seedCharacter(ctx.db, testConfig(), {
    id: 99001,
    accountId: p.owner.id,
  });
  // Legacy/provenance cleanup fixture, not positive shared publication.
  const sessionId = createHash("sha256").update(p.sessionId).digest("base64url");
  await ctx.db.insert(fleetPublisherLease).values({
    characterId: ch.id,
    deviceId: p.device.id,
    sessionId,
    fleetId: 123,
    leaseExpiresAt: at(10000),
  });
  await ctx.db.insert(fleetTelemetryRow).values({
    characterId: ch.id,
    deviceId: p.device.id,
    sessionId,
    fleetId: 123,
    dps: 10,
    receivedAt: NOW,
    staleAt: at(3000),
    hardExpiresAt: at(10000),
  });
}

describe("participation transaction boundaries", () => {
  it("an audit failure rolls back Off generation, projection cleanup and cadence", async () => {
    const p = await setup();
    await projection(p);
    const device = await ctx.db.select().from(fleetDevice);
    const sessions = await ctx.db.select().from(fleetDeviceSession);
    const rows = await ctx.db.select().from(fleetTelemetryRow);
    const leases = await ctx.db.select().from(fleetPublisherLease);
    const audit = await ctx.db.select().from(auditLog);
    const off = {
      sessionId: p.sessionId,
      revision: 3,
      now: at(1000),
      enabled: false,
      expectedGeneration: 1,
    };
    expect(
      await withInjectedPgFault(
        ctx.pool,
        { matchSql: /insert into "audit_log"/i, code: "40001" },
        () => setFleetParticipation(ctx.db, off),
      ),
    ).toEqual({ ok: false, code: "service_unavailable" });
    expect(await ctx.db.select().from(fleetDevice)).toEqual(device);
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(sessions);
    expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual(rows);
    expect(await ctx.db.select().from(fleetPublisherLease)).toEqual(leases);
    expect(await ctx.db.select().from(auditLog)).toEqual(audit);
    expect((await setFleetParticipation(ctx.db, off)).ok).toBe(true);
  });
  it.each([false, true])(
    "resamples after a real cleanup lock wait (expired=%s)",
    async (expired) => {
      const p = await setup();
      await projection(p);
      await ctx.db
        .update(fleetDeviceSession)
        .set({ expiresAt: at(expired ? 2000 : 10000) });
      const client = await ctx.pool.connect();
      let pending: ReturnType<typeof setFleetParticipation> | undefined;
      try {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(at(1000));
        await client.query("begin");
        const {
          rows: [{ pid }],
        } = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
        await client.query("select pg_advisory_xact_lock(2, hashint8(99001))");
        pending = setFleetParticipation(ctx.db, {
          sessionId: p.sessionId,
          revision: 3,
          enabled: false,
          expectedGeneration: 1,
        });
        expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
        vi.setSystemTime(at(2000));
        await client.query("commit");
        expect(await pending).toEqual(
          expired
            ? { ok: false, code: "unauthorized" }
            : { ok: true, value: { enabled: false, generation: 2 } },
        );
        const [session] = await ctx.db.select().from(fleetDeviceSession);
        expect(session.lastReadAt).toEqual(at(expired ? 500 : 2000));
        expect(await ctx.db.select().from(fleetTelemetryRow)).toHaveLength(
          expired ? 1 : 0,
        );
        expect((await ctx.db.select().from(fleetDevice))[0].participationGeneration).toBe(
          expired ? 1 : 2,
        );
      } finally {
        await client.query("rollback");
        client.release();
        await pending;
      }
    },
  );
  it("disabled and not-ready modes refuse without changing consent", async () => {
    const p = await setup();
    await transitionFleetSharingMode(ctx.db, {
      enabled: false,
      expectedRevision: 3,
      now: NOW,
    });
    const paired = await pairDevice(ctx.db, p.owner.id, NOW, [], p);
    expect(
      await setFleetParticipation(ctx.db, {
        sessionId: paired.sessionId,
        revision: 1,
        now: at(1000),
        enabled: false,
        expectedGeneration: 0,
      }),
    ).toEqual({ ok: false, code: "feature_disabled" });
  });
});

describe("explicit per-device participation", () => {
  it("newer and repeated Off fence stale On across real sessions, without retiring sessions", async () => {
    const p = await setup();
    const second = await pairDevice(ctx.db, p.owner.id, NOW, [SHARED_CAPABILITY], p);
    await acknowledgeFleetCapabilities(ctx.db, {
      sessionId: second.sessionId,
      revision: 1,
      now: NOW,
      capabilities: [SHARED_CAPABILITY],
    });
    expect(
      await setFleetParticipation(ctx.db, {
        sessionId: p.sessionId,
        revision: 2,
        now: at(500),
        enabled: true,
        expectedGeneration: 0,
      }),
    ).toEqual({ ok: true, value: { enabled: true, generation: 1 } });
    expect(
      await setFleetParticipation(ctx.db, {
        sessionId: second.sessionId,
        revision: 2,
        now: at(1000),
        enabled: false,
        expectedGeneration: 1,
      }),
    ).toEqual({ ok: true, value: { enabled: false, generation: 2 } });
    expect(
      await setFleetParticipation(ctx.db, {
        sessionId: p.sessionId,
        revision: 3,
        now: at(1500),
        enabled: true,
        expectedGeneration: 0,
      }),
    ).toEqual({ ok: false, code: "conflict" });
    expect(
      await setFleetParticipation(ctx.db, {
        sessionId: p.sessionId,
        revision: 3,
        now: at(1500),
        enabled: false,
        expectedGeneration: 2,
      }),
    ).toEqual({ ok: true, value: { enabled: false, generation: 3 } });
    expect(await ctx.db.select().from(fleetDeviceSession)).toHaveLength(2);
    expect(
      await readFleetDeviceState(ctx.db, {
        sessionId: second.sessionId,
        revision: 3,
        now: at(2000),
      }),
    ).toMatchObject({
      ok: true,
      value: { participation: { enabled: false, generation: 3 } },
    });
  });
  it("shares the 500ms read bucket and one revision; refusals change neither", async () => {
    const p = await setup();
    const call = {
      sessionId: p.sessionId,
      revision: 2,
      enabled: true,
      expectedGeneration: 0,
    };
    expect(await setFleetParticipation(ctx.db, { ...call, now: at(499) })).toEqual({
      ok: false,
      code: "rate_limited",
    });
    expect((await setFleetParticipation(ctx.db, { ...call, now: at(500) })).ok).toBe(
      true,
    );
    expect(
      await readDeviceCatalogueForSession(ctx.db, {
        sessionId: p.sessionId,
        revision: 3,
        now: at(999),
      }),
    ).toEqual({ ok: false, code: "rate_limited" });
    expect(
      await readDeviceCatalogueForSession(ctx.db, {
        sessionId: p.sessionId,
        revision: 2,
        now: at(1000),
      }),
    ).toEqual({ ok: false, code: "revision_replayed" });
  });
  it.each(["device grant", "session ceiling", "acknowledgment", "Member"])(
    "requires current %s even for Off",
    async (removed) => {
      const p = await setup();
      if (removed === "device grant")
        await ctx.db
          .update(fleetDevice)
          .set({ approvedCapabilities: [] })
          .where(eq(fleetDevice.id, p.device.id));
      if (removed === "session ceiling")
        await ctx.db.update(fleetDeviceSession).set({ approvedCapabilities: [] });
      if (removed === "acknowledgment")
        await acknowledgeFleetCapabilities(ctx.db, {
          sessionId: p.sessionId,
          revision: 2,
          now: at(500),
          capabilities: [],
        });
      if (removed === "Member")
        await ctx.db
          .update(account)
          .set({ tier: "alumni", isAdmin: true })
          .where(eq(account.id, p.owner.id));
      expect(
        await setFleetParticipation(ctx.db, {
          sessionId: p.sessionId,
          revision: 3,
          now: at(1000),
          enabled: false,
          expectedGeneration: 0,
        }),
      ).toEqual({
        ok: false,
        code: removed === "Member" ? "forbidden" : "capability_required",
      });
      const [device] = await ctx.db.select().from(fleetDevice);
      expect(device.participationGeneration).toBe(0);
    },
  );
  it("Off withdraws only its own relay rows/leases, not registrations or sessions", async () => {
    const p = await setup();
    await setFleetParticipation(ctx.db, {
      sessionId: p.sessionId,
      revision: 2,
      now: at(500),
      enabled: true,
      expectedGeneration: 0,
    });
    const ch = await seedCharacter(ctx.db, testConfig(), {
      id: 99001,
      accountId: p.owner.id,
    });
    // Explicit legacy relay fixture for withdrawal only: not positive shared admission.
    const sessionId = createHash("sha256").update(p.sessionId).digest("base64url");
    await ctx.db.insert(fleetPublisherLease).values({
      characterId: ch.id,
      deviceId: p.device.id,
      sessionId,
      fleetId: 123,
      leaseExpiresAt: at(10000),
    });
    await ctx.db.insert(fleetTelemetryRow).values({
      characterId: ch.id,
      deviceId: p.device.id,
      sessionId,
      fleetId: 123,
      dps: 10,
      receivedAt: NOW,
      staleAt: at(3000),
      hardExpiresAt: at(10000),
    });
    expect(
      (
        await setFleetParticipation(ctx.db, {
          sessionId: p.sessionId,
          revision: 3,
          now: at(1000),
          enabled: false,
          expectedGeneration: 1,
        })
      ).ok,
    ).toBe(true);
    expect(await ctx.db.select().from(fleetPublisherLease)).toEqual([]);
    expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([]);
    expect(await ctx.db.select().from(fleetDeviceSession)).toHaveLength(1);
    expect((await ctx.db.select().from(fleetDevice))[0].revokedAt).toBeNull();
  });
});

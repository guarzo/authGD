import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  character,
  fleetDeviceSession,
  fleetPublisherLease,
  fleetSharingGate,
  fleetSourceAuthority,
  fleetSourceIntent,
  fleetTelemetryRow,
  outbox,
} from "@/db/schema";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import {
  reserveDueFleetSources,
  cleanupFleetSources,
} from "@/services/fleet-source-maintenance";
import {
  startFleetSourceScheduler,
  createFleetSourceOwner,
} from "@/worker/fleet-source-scheduler";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { pairDevice, reconcileFleetKeys } from "./helpers/fleet-sharing";
import { seedLifecycleSource } from "./helpers/fleet-source-lifecycle";
const NOW = new Date("2026-09-07T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
async function seeded() {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: NOW,
  });
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(
    ctx.db,
    { ...(await import("./helpers/config")).testConfig() },
    { id: 99001, accountId: owner.id, scopes: [FLEET_READ_SCOPE] },
  );
  const device = await pairDevice(ctx.db, owner.id, NOW, [SHARED_CAPABILITY]);
  const source = await seedLifecycleSource(ctx.db, {
    boss,
    deviceId: device.device.id,
    now: NOW,
  });
  await ctx.db
    .update(fleetSourceIntent)
    .set({ nextFetchAt: NOW })
    .where(eq(fleetSourceIntent.id, source.id));
  return source;
}
describe("bounded source scheduling and cleanup (lifecycle fixtures, not provider proof)", () => {
  it("reserves due outbox once across scheduler overlap; an undispatched row stays bounded past lease expiry", async () => {
    const source = await seeded();
    expect(
      await Promise.all([
        reserveDueFleetSources(ctx.db, () => NOW),
        reserveDueFleetSources(ctx.db, () => NOW),
      ]),
    ).toEqual(expect.arrayContaining([0, 1]));
    expect((await ctx.db.select().from(outbox)).map((r) => r.payload)).toEqual([
      { kind: "fleet-source", sourceId: source.id, generation: 1 },
    ]);
    await reserveDueFleetSources(ctx.db, () => at(40000));
    expect(await ctx.db.select().from(outbox)).toHaveLength(1);
  });
  it("independent cleanup clears expired evidence without a reader or successful source job", async () => {
    await seeded();
    await cleanupFleetSources(ctx.db, () => at(10000));
    expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
      sourceId: null,
      linkedCharacters: [],
      expiresAt: null,
    });
    expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("paused");
  });
  it("cleanup ends preactivation paused intents, but retains activated pauses and bounds tombstone work to 100", async () => {
    const source = await seeded();
    await ctx.db.update(fleetSourceIntent).set({ state: "paused", activatedAt: null });
    await cleanupFleetSources(ctx.db, () => at(60000));
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "ended",
      terminalReason: "expired",
    });
    const rows = Array.from({ length: 101 }, () => ({
      ...source,
      id: randomUUID(),
      state: "ended" as const,
      endedAt: NOW,
      terminalReason: "stopped",
      retainUntil: at(60001),
    }));
    await ctx.db.insert(fleetSourceIntent).values(rows);
    await cleanupFleetSources(ctx.db, () => at(86461000));
    expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(2);
  });
  it("bounds legacy relay cleanup to 100 identities even while source admission is disabled", async () => {
    const source = await seeded();
    const [session] = await ctx.db.select().from(fleetDeviceSession);
    const ids = Array.from({ length: 101 }, (_, i) => 200000 + i);
    await ctx.db.insert(character).values(
      ids.map((id) => ({
        id,
        name: "Cleanup fixture",
        ownerHash: `fixture-${id}`,
        accountId: source.accountId!,
        refreshTokenEnc: null,
        tokenStatus: "missing" as const,
        scopes: [],
      })),
    );
    // Lifecycle/legacy cleanup fixture ONLY; never positive shared admission.
    await ctx.db.insert(fleetTelemetryRow).values(
      ids.map((characterId) => ({
        characterId,
        deviceId: source.deviceId!,
        sessionId: session.id,
        fleetId: 123,
        dps: 1,
        receivedAt: NOW,
        staleAt: at(3000),
        hardExpiresAt: at(10000),
      })),
    );
    await ctx.db.insert(fleetPublisherLease).values(
      ids.map((characterId) => ({
        characterId,
        deviceId: source.deviceId!,
        sessionId: session.id,
        fleetId: 123,
        leaseExpiresAt: at(10000),
      })),
    );
    await ctx.db.update(fleetSharingGate).set({ enabled: false });
    await cleanupFleetSources(ctx.db, () => at(10000));
    expect(await ctx.db.select().from(fleetTelemetryRow)).toHaveLength(1);
    expect(await ctx.db.select().from(fleetPublisherLease)).toHaveLength(1);
    expect((await ctx.db.select().from(fleetSourceAuthority))[0].sourceId).toBeNull();
    await cleanupFleetSources(ctx.db, () => at(10000));
    expect(await ctx.db.select().from(fleetTelemetryRow)).toHaveLength(0);
    expect(await ctx.db.select().from(fleetPublisherLease)).toHaveLength(0);
  });
  it("startup catches up immediately, never overlaps, and stop waits for the owned tick", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const tick = vi.fn(async () => {
      await held;
    });
    const stop = startFleetSourceScheduler(tick, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(tick).toHaveBeenCalledTimes(1);
    let stopped = false;
    const pending = stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toBe(false);
    release();
    await pending;
    expect(stopped).toBe(true);
  });
  it("owns the real handler promise even when a framework timeout no longer awaits it", async () => {
    const owner = createFleetSourceOwner();
    let release!: () => void;
    let settled = false;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const handler = owner.wrap(async () => {
      await held;
      settled = true;
    });
    const task = handler({});
    owner.stopAdmission();
    let drained = false;
    const draining = owner.drain().then(() => {
      drained = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(drained).toBe(false);
    expect(owner.signal.aborted).toBe(true);
    release();
    await task;
    await draining;
    expect(settled).toBe(true);
    await owner.wrap(async () => {
      throw new Error("must not admit");
    })({});
  });
});

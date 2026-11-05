import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  account,
  auditLog,
  character,
  fleetDevice,
  fleetDeviceSession,
  fleetSourceIntent,
  outbox,
} from "@/db/schema";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { revokeFleetDevice } from "@/services/fleet-pairing";
import { controlFleetSource, readFleetSourceState } from "@/services/fleet-source";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import { pairDevice, reconcileFleetKeys } from "./helpers/fleet-sharing";
import { withInjectedPgFault } from "./helpers/pg-fault";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
async function setup() {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
    now: NOW,
  });
  const owner = await seedAccount(ctx.db, { tier: "member", status: "cryo" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 99001,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
    tokenStatus: "needs_reauth",
  });
  const p = await pairDevice(ctx.db, owner.id, NOW, [SHARED_CAPABILITY]);
  await acknowledgeFleetCapabilities(ctx.db, {
    sessionId: p.sessionId,
    revision: 1,
    now: NOW,
    capabilities: [SHARED_CAPABILITY],
  });
  const command = {
    protocol: 2 as const,
    operation: "start" as const,
    source_id: randomUUID(),
    expected_generation: 0 as const,
    character_id: boss.id,
    character_link_epoch: boss.fleetLinkEpoch,
    intent_created_at: NOW.toISOString(),
  };
  return { owner, boss, ...p, command };
}
describe("source-only signed-session controls", () => {
  it("bounds pending source admission per account, while identical retries consume no capacity", async () => {
    const p = await setup();
    for (let i = 0; i < 16; i++)
      expect(
        (
          await controlFleetSource(ctx.db, {
            sessionId: p.sessionId,
            revision: i + 2,
            now: at(500 + 500 * i),
            command: {
              ...p.command,
              source_id: i === 0 ? p.command.source_id : randomUUID(),
            },
          })
        ).ok,
      ).toBe(true);
    expect(
      (
        await controlFleetSource(ctx.db, {
          sessionId: p.sessionId,
          revision: 18,
          now: at(8500),
          command: p.command,
        })
      ).ok,
    ).toBe(true);
    expect(
      await controlFleetSource(ctx.db, {
        sessionId: p.sessionId,
        revision: 19,
        now: at(9000),
        command: { ...p.command, source_id: randomUUID() },
      }),
    ).toEqual({ ok: false, code: "rate_limited" });
    expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(16);
    expect(await ctx.db.select().from(outbox)).toHaveLength(16);
  });
  it("refuses an oversized own-character catalogue rather than silently truncating a source control DTO", async () => {
    const p = await setup();
    await ctx.db.insert(character).values(
      Array.from({ length: 256 }, (_, i) => ({
        ...p.boss,
        id: 100000 + i,
        fleetLinkEpoch: randomUUID(),
      })),
    );
    expect(
      await readFleetSourceState(ctx.db, {
        sessionId: p.sessionId,
        revision: 2,
        now: at(500),
      }),
    ).toEqual({ ok: false, code: "service_unavailable" });
    expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(1);
  });
  it("Start commits pending + audit + exact outbox once, without participation or participant grants", async () => {
    const p = await setup();
    const call = {
      sessionId: p.sessionId,
      revision: 2,
      now: at(500),
      command: p.command,
    };
    expect(await controlFleetSource(ctx.db, call)).toMatchObject({
      ok: true,
      value: {
        protocol: 2,
        source: {
          source_id: p.command.source_id,
          generation: 1,
          state: "pending",
          pending_expires_at: at(60000).toISOString(),
          automatic: null,
        },
      },
    });
    expect(
      await controlFleetSource(ctx.db, { ...call, revision: 3, now: at(1000) }),
    ).toMatchObject({ ok: true, value: { source: { generation: 1 } } });
    expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(1);
    expect((await ctx.db.select().from(outbox)).map((r) => r.payload)).toEqual([
      { kind: "fleet-source", sourceId: p.command.source_id, generation: 1 },
    ]);
    expect(
      (await ctx.db.select().from(auditLog)).filter(
        (r) => r.action === "fleet_source.started",
      ),
    ).toHaveLength(1);
    expect((await ctx.db.select().from(fleetDevice))[0].participationEnabled).toBe(false);
    expect(
      await readFleetSourceState(ctx.db, {
        sessionId: p.sessionId,
        revision: 4,
        now: at(1500),
      }),
    ).toMatchObject({
      ok: true,
      value: {
        characters: [
          {
            character_id: p.boss.id,
            character_link_epoch: p.boss.fleetLinkEpoch,
            has_fleet_read: true,
            token_usable: true,
          },
        ],
        sources: [{ state: "pending" }],
      },
    });
  });
  it("same-account second-device retry preserves initiating attribution; its original device revocation still ends consent", async () => {
    const p = await setup();
    await controlFleetSource(ctx.db, {
      sessionId: p.sessionId,
      revision: 2,
      now: at(500),
      command: p.command,
    });
    const second = await pairDevice(ctx.db, p.owner.id, NOW, [SHARED_CAPABILITY]);
    await acknowledgeFleetCapabilities(ctx.db, {
      sessionId: second.sessionId,
      revision: 1,
      now: NOW,
      capabilities: [SHARED_CAPABILITY],
    });
    const before = (await ctx.db.select().from(fleetSourceIntent))[0];
    expect(
      await controlFleetSource(ctx.db, {
        sessionId: second.sessionId,
        revision: 2,
        now: at(1000),
        command: p.command,
      }),
    ).toMatchObject({ ok: true, value: { source: { generation: 1, state: "pending" } } });
    expect(await ctx.db.select().from(fleetSourceIntent)).toEqual([before]);
    expect(await ctx.db.select().from(outbox)).toHaveLength(1);
    expect(
      (await ctx.db.select().from(auditLog)).filter(
        (r) => r.action === "fleet_source.started",
      ),
    ).toHaveLength(1);
    expect(
      (await ctx.db.select().from(fleetDevice)).every((d) => !d.participationEnabled),
    ).toBe(true);
    await revokeFleetDevice(ctx.db, p.device.id, p.owner.id, at(1500));
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
      state: "ended",
      deviceId: p.device.id,
      generation: 2,
    });
  });
  it("audit/outbox failures roll back the intent and session cadence", async () => {
    const p = await setup();
    for (const table of ["audit_log", "outbox"]) {
      expect(
        await withInjectedPgFault(
          ctx.pool,
          { matchSql: new RegExp('insert into "' + table + '"', "i"), code: "40001" },
          () =>
            controlFleetSource(ctx.db, {
              sessionId: p.sessionId,
              revision: 2,
              now: at(500),
              command: p.command,
            }),
        ),
      ).toEqual({ ok: false, code: "service_unavailable" });
      expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(0);
      expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(1);
    }
  });
  it("rejects expired/future first intents even with no retained tombstone", async () => {
    const p = await setup();
    for (const intent_created_at of [at(-60000).toISOString(), at(1000).toISOString()])
      expect(
        await controlFleetSource(ctx.db, {
          sessionId: p.sessionId,
          revision: 2,
          now: at(500),
          command: { ...p.command, intent_created_at },
        }),
      ).toEqual({ ok: false, code: "invalid_intent" });
    expect(
      await controlFleetSource(ctx.db, {
        sessionId: p.sessionId,
        revision: 2,
        now: at(500),
        command: { ...p.command, intent_created_at: "not-a-date" },
      }),
    ).toEqual({ ok: false, code: "bad_request" });
    expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(0);
  });
  it("Stop-before-Start creates an attributed cancellation fence with 24-hour retention", async () => {
    const p = await setup();
    const stopped = await controlFleetSource(ctx.db, {
      sessionId: p.sessionId,
      revision: 2,
      now: at(500),
      command: {
        protocol: 2,
        operation: "stop",
        request_id: randomUUID(),
        intent_created_at: NOW.toISOString(),
        source_id: p.command.source_id,
        expected_generation: 0,
        expected_automatic: null,
      },
    });
    expect(stopped).toMatchObject({
      ok: true,
      value: {
        source: { state: "ended", generation: 1 },
        automatic_effect: "unknown_cancelled",
      },
    });
    expect(
      await controlFleetSource(ctx.db, {
        sessionId: p.sessionId,
        revision: 3,
        now: at(1000),
        command: p.command,
      }),
    ).toEqual({ ok: false, code: "conflict" });
    const [s] = await ctx.db.select().from(fleetSourceIntent);
    expect(s.accountId).toBe(p.owner.id);
    expect(s.deviceId).toBe(p.device.id);
    expect(s.retainUntil.getTime()).toBeGreaterThanOrEqual(
      s.intentExpiresAt.getTime() + 86400000,
    );
    expect(await ctx.db.select().from(outbox)).toHaveLength(0);
  });
  it.each(["Member", "grant", "ceiling", "ack", "link"])(
    "requires current %s without consulting sharingOn",
    async (loss) => {
      const p = await setup();
      if (loss === "Member") await ctx.db.update(account).set({ tier: "alumni" });
      if (loss === "grant")
        await ctx.db.update(fleetDevice).set({ approvedCapabilities: [] });
      if (loss === "ceiling")
        await ctx.db.update(fleetDeviceSession).set({ approvedCapabilities: [] });
      if (loss === "ack")
        await ctx.db.update(fleetDeviceSession).set({ acknowledgedCapabilities: [] });
      if (loss === "link")
        await ctx.db
          .update(character)
          .set({ fleetLinkEpoch: randomUUID() })
          .where(eq(character.id, p.boss.id));
      expect(
        (
          await controlFleetSource(ctx.db, {
            sessionId: p.sessionId,
            revision: 2,
            now: at(500),
            command: p.command,
          })
        ).ok,
      ).toBe(false);
      expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(0);
    },
  );
});

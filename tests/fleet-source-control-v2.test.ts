import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  account,
  fleetAutomaticConsent,
  fleetAutomaticReceipt,
  fleetDeviceSession,
  fleetSourceIntent,
  outbox,
} from "@/db/schema";
import type { SourceStart, SourceStop } from "@/core/fleet-automatic";
import { controlFleetSource, readFleetSourceState } from "@/services/fleet-source";
import {
  controlFleetAutomatic,
  readFleetAutomaticReceipt,
} from "@/services/fleet-automatic";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import {
  invalidateFleetSources,
  lockFleetAccounts,
  lockFleetLifecycle,
} from "@/services/fleet-lifecycle";
import { linkCharacter } from "@/services/accounts";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import {
  pairDevice,
  reconcileFleetKeys,
  waitUntilBlockedBy,
} from "./helpers/fleet-sharing";
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
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 99001,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const p = await pairDevice(ctx.db, owner.id, NOW, ["shared-source-v1"]);
  await acknowledgeFleetCapabilities(ctx.db, {
    sessionId: p.sessionId,
    revision: 1,
    now: NOW,
    capabilities: ["shared-source-v1"],
  });
  let revision = 1;
  const start: SourceStart = {
    protocol: 2,
    operation: "start",
    source_id: randomUUID(),
    expected_generation: 0,
    character_id: boss.id,
    character_link_epoch: boss.fleetLinkEpoch.toUpperCase(),
    intent_created_at: NOW.toISOString(),
  };
  const stop = (
    id = start.source_id,
    generation = 1,
    automatic: number | null = null,
  ): SourceStop => ({
    protocol: 2,
    operation: "stop",
    source_id: id,
    expected_generation: generation,
    expected_automatic: automatic === null ? null : { consent_generation: automatic },
    request_id: randomUUID(),
    intent_created_at: NOW.toISOString(),
  });
  const call = (ms?: number) => ({
    sessionId: p.sessionId,
    revision: ++revision,
    now: at(ms ?? revision * 500),
  });
  const run = (command: SourceStart | SourceStop, ms?: number) =>
    controlFleetSource(ctx.db, { ...call(ms), command });
  const on = (generation = 0, expectedRevision = generation) =>
    controlFleetAutomatic(ctx.db, call(), {
      protocol: 2,
      request_id: randomUUID(),
      intent_created_at: NOW.toISOString(),
      enabled: true,
      expected_generation: generation,
      expected_revision: expectedRevision,
    });
  const automaticSource = async () => {
    const [source] = await ctx.db
      .insert(fleetSourceIntent)
      .values({
        id: randomUUID(),
        accountId: owner.id,
        deviceId: p.device.id,
        bossCharacterId: boss.id,
        bossOwnerHash: boss.ownerHash,
        bossLinkEpoch: boss.fleetLinkEpoch,
        generation: 1,
        state: "active",
        activatedAt: NOW,
        intentCreatedAt: NOW,
        intentExpiresAt: at(60000),
        retainUntil: at(86460000),
        nextFetchAt: at(1000),
        automaticConsentAccountId: owner.id,
        automaticConsentGeneration: 1,
      })
      .returning();
    return source;
  };
  return { ...p, owner, boss, start, stop, call, run, on, automaticSource };
}
it("v2 manual Start returns one closed source with null provenance and catalogue, never implicit On", async () => {
  const p = await setup();
  expect(await p.run(p.start)).toMatchObject({
    ok: true,
    value: {
      protocol: 2,
      source: {
        source_id: p.start.source_id,
        generation: 1,
        state: "pending",
        automatic: null,
        pending_expires_at: at(60000).toISOString(),
      },
    },
  });
  expect(
    await p.run({ ...p.start, source_id: p.start.source_id.toUpperCase() }),
  ).toMatchObject({ ok: true, value: { source: { generation: 1 } } });
  expect(await ctx.db.select().from(outbox)).toHaveLength(1);
  expect(await ctx.db.select().from(fleetAutomaticConsent)).toHaveLength(0);
  expect(await readFleetSourceState(ctx.db, p.call())).toMatchObject({
    ok: true,
    value: {
      protocol: 2,
      sources: [{ automatic: null }],
      characters: [{ character_id: p.boss.id, has_fleet_read: true }],
    },
  });
});
it("manual Stop is terminal without Member/C/K; exact replay precedes age and source CAS", async () => {
  const p = await setup();
  expect((await p.run(p.start)).ok).toBe(true);
  await ctx.db.update(account).set({ tier: "alumni" }).where(eq(account.id, p.owner.id));
  await ctx.db
    .update(fleetDeviceSession)
    .set({ approvedCapabilities: [], acknowledgedCapabilities: [] });
  const stop = p.stop();
  const result = await p.run(stop);
  expect(result).toMatchObject({
    ok: true,
    value: {
      protocol: 2,
      result: "applied",
      automatic_effect: "manual_only",
      source: { state: "ended", generation: 2 },
      receipt: { command: stop },
    },
  });
  expect(
    await p.run({ ...stop, source_id: stop.source_id.toUpperCase() }, 120000),
  ).toMatchObject({ ok: true, value: { result: "replayed" } });
  expect(await p.run({ ...stop, expected_generation: 2 }, 121000)).toEqual({
    ok: false,
    code: "request_id_conflict",
  });
  expect(await readFleetSourceState(ctx.db, p.call(122000))).toEqual({
    ok: false,
    code: "forbidden",
  });
});
it("naturally ended current source Stop checks stale CAS then disables current consent and siblings", async () => {
  const p = await setup();
  expect((await p.on()).ok).toBe(true);
  const target = await p.automaticSource();
  // The storage index allows only one live boss/link: sibling uses another link.
  const sibling = await ctx.db
    .insert(fleetSourceIntent)
    .values({ ...target, id: randomUUID(), bossLinkEpoch: randomUUID() })
    .returning();
  await ctx.db.transaction(async (tx) => {
    await lockFleetAccounts(tx, [p.owner.id]);
    await invalidateFleetSources(
      tx,
      await lockFleetLifecycle(tx, { sourceIds: [target.id] }),
      "not_in_fleet",
      "system",
      at(2000),
    );
  });
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0].enabled).toBe(true);
  expect(await p.run(p.stop(target.id, 1, 1), 2500)).toEqual({
    ok: false,
    code: "conflict",
  });
  expect(await p.run(p.stop(target.id, 2, null), 3000)).toEqual({
    ok: false,
    code: "conflict",
  });
  const command = p.stop(target.id, 2, 1);
  expect(await p.run(command, 3500)).toMatchObject({
    ok: true,
    value: {
      result: "applied",
      automatic_effect: "disabled_current",
      source: { generation: 2 },
      status: {
        consent: { enabled: false, revision: 2, closed_reason: "source_stop" },
        sources: [],
      },
    },
  });
  expect(
    (
      await ctx.db
        .select()
        .from(fleetSourceIntent)
        .where(eq(fleetSourceIntent.id, sibling[0].id))
    )[0].state,
  ).toBe("ended");
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(1);
  expect(await p.run(p.stop(target.id, 2, 1), 4000)).toMatchObject({
    ok: true,
    value: {
      result: "already_stopped",
      receipt: null,
      automatic_effect: "current_already_off",
    },
  });
  expect(
    await readFleetAutomaticReceipt(ctx.db, p.call(4500), command.request_id),
  ).toMatchObject({
    ok: true,
    value: { receipt: { command, automatic_effect: "disabled_current" } },
  });
});
it("unknown cancellation requires zero/null and reserves one inline receipt, never current consent", async () => {
  const p = await setup();
  expect((await p.on()).ok).toBe(true);
  expect(await p.run(p.stop(p.start.source_id, 0, 1))).toEqual({
    ok: false,
    code: "conflict",
  });
  expect(await p.run(p.stop(p.start.source_id, 1))).toEqual({
    ok: false,
    code: "conflict",
  });
  expect(await p.run(p.stop(p.start.source_id, 0))).toMatchObject({
    ok: true,
    value: {
      result: "applied",
      automatic_effect: "unknown_cancelled",
      source: { generation: 1, state: "ended", automatic: null },
      status: { consent: { enabled: true } },
    },
  });
  expect(await p.run(p.start)).toEqual({ ok: false, code: "conflict" });
  expect(await p.run(p.stop())).toMatchObject({
    ok: true,
    value: { result: "already_stopped", automatic_effect: "manual_only" },
  });
});
it("older-generation Stop and historical replay cannot disable replacement On", async () => {
  const p = await setup();
  expect((await p.on()).ok).toBe(true);
  const source = await p.automaticSource();
  expect((await p.on(1)).ok).toBe(true);
  const stop = p.stop(source.id, 2, 1);
  expect(await p.run(stop)).toMatchObject({
    ok: true,
    value: {
      automatic_effect: "older_generation_only",
      status: { consent: { enabled: true, generation: 2 } },
    },
  });
  expect(await p.run(stop)).toMatchObject({
    ok: true,
    value: { result: "replayed", status: { consent: { enabled: true, generation: 2 } } },
  });
});
it("Stop consumes its inline slot at H255/R1 and shares live UUID namespace with automatic receipts", async () => {
  const p = await setup();
  expect((await p.on()).ok).toBe(true);
  const source = await p.automaticSource();
  const [record] = await ctx.db.select().from(fleetAutomaticReceipt);
  await ctx.db.insert(fleetAutomaticReceipt).values(
    Array.from({ length: 254 }, () => {
      const id = randomUUID();
      return {
        ...record,
        requestId: id,
        receipt: {
          ...record.receipt,
          command: { ...record.receipt.command, request_id: id },
        },
      };
    }),
  );
  const command = p.stop(source.id, 1, 1);
  expect(await p.run({ ...command, request_id: record.requestId })).toEqual({
    ok: false,
    code: "request_id_conflict",
  });
  expect((await ctx.db.select().from(fleetSourceIntent))[0].state).toBe("active");
  expect(await p.run(command)).toMatchObject({
    ok: true,
    value: { automatic_effect: "disabled_current" },
  });
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(255);
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0].enabled).toBe(false);
});
it("expired Stop payload never recycles the lifetime fence; fresh no-op allocates no history", async () => {
  const p = await setup();
  const command = p.stop(p.start.source_id, 0);
  expect((await p.run(command)).ok).toBe(true);
  await ctx.db.update(fleetDeviceSession).set({ expiresAt: at(3 * 86400000) });
  await ctx.db.update(fleetSourceIntent).set({ stopReceipt: null });
  expect(await p.run(command, 86402000)).toEqual({ ok: false, code: "invalid_intent" });
  expect(
    await p.run({ ...p.stop(), intent_created_at: at(86402000).toISOString() }, 86403000),
  ).toMatchObject({ ok: true, value: { result: "already_stopped", receipt: null } });
  expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
    stopReceipt: null,
    explicitlyStopped: true,
    generation: 1,
  });
  expect(
    await readFleetAutomaticReceipt(ctx.db, p.call(86404000), command.request_id),
  ).toEqual({ ok: false, code: "receipt_not_found" });
});
it.each([false, true])(
  "real account lock orders SourceStop versus replacement On, replacementFirst=%s",
  async (replacementFirst) => {
    const p = await setup();
    expect((await p.on()).ok).toBe(true);
    const source = await p.automaticSource();
    const q = await pairDevice(ctx.db, p.owner.id, NOW, ["shared-source-v1"]);
    await acknowledgeFleetCapabilities(ctx.db, {
      sessionId: q.sessionId,
      revision: 1,
      now: NOW,
      capabilities: ["shared-source-v1"],
    });
    const replacement = () =>
      controlFleetAutomatic(
        ctx.db,
        { sessionId: q.sessionId, revision: 2, now: at(2000) },
        {
          protocol: 2,
          request_id: randomUUID(),
          enabled: true,
          intent_created_at: NOW.toISOString(),
          expected_generation: 1,
          expected_revision: 1,
        },
      );
    const terminal = () => p.run(p.stop(source.id, 1, 1), 2000);
    const holder = await ctx.pool.connect();
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from account where id=$1 for update", [p.owner.id]);
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      first = replacementFirst ? replacement() : terminal();
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      second = replacementFirst ? terminal() : replacement();
      await holder.query("commit");
      expect(await first).toMatchObject({ ok: true });
      expect(await second).toEqual({ ok: false, code: "conflict" });
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled(
        [first, second].filter((p): p is Promise<unknown> => p !== undefined),
      );
    }
    expect((await ctx.db.select().from(fleetAutomaticConsent))[0]).toMatchObject({
      generation: replacementFirst ? 2 : 1,
      revision: 2,
      enabled: replacementFirst,
    });
  },
);
it("real account merge clears ended inline receipts while preserving provenance and explicit Stop fence", async () => {
  const p = await setup();
  expect((await p.on()).ok).toBe(true);
  const original = await p.automaticSource();
  expect((await p.run(p.stop(original.id, 1, 1))).ok).toBe(true);
  const target = await seedAccount(ctx.db);
  expect(
    await ctx.db.transaction((tx) =>
      linkCharacter(tx, testConfig(), target.id, {
        characterId: p.boss.id,
        characterName: p.boss.name,
        ownerHash: p.boss.ownerHash,
        scopes: p.boss.scopes,
        refreshToken: "merged-test-refresh",
      }),
    ),
  ).toEqual({ ok: true });
  expect(await ctx.db.select().from(fleetAutomaticConsent)).toHaveLength(0);
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(0);
  expect((await ctx.db.select().from(fleetSourceIntent))[0]).toMatchObject({
    accountId: p.owner.id,
    stopReceipt: null,
    explicitlyStopped: true,
    automaticConsentAccountId: p.owner.id,
    automaticConsentGeneration: 1,
    state: "ended",
  });
});
it.each(["audit_log", "fleet_source_intent"])(
  "Stop %s failure rolls back withdrawal and inline receipt",
  async (table) => {
    const p = await setup();
    expect((await p.on()).ok).toBe(true);
    const source = await p.automaticSource();
    const command = p.stop(source.id, 1, 1);
    const call = { ...p.call(), command };
    expect(
      await withInjectedPgFault(
        ctx.pool,
        {
          matchSql:
            table === "audit_log"
              ? /insert into "audit_log"/i
              : /update "fleet_source_intent" set "stop_receipt"/i,
          code: "40001",
        },
        () => controlFleetSource(ctx.db, call),
      ),
    ).toEqual({ ok: false, code: "service_unavailable" });
    expect((await ctx.db.select().from(fleetAutomaticConsent))[0].enabled).toBe(true);
    expect((await ctx.db.select().from(fleetSourceIntent))[0]).toEqual(source);
    expect(await controlFleetSource(ctx.db, call)).toMatchObject({
      ok: true,
      value: { automatic_effect: "disabled_current" },
    });
  },
);

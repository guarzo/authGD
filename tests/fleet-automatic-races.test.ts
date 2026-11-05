import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  account,
  auditLog,
  fleetAutomaticConsent,
  fleetAutomaticCandidate,
  fleetAutomaticReceipt,
  fleetDeviceSession,
  fleetSourceIntent,
} from "@/db/schema";
import type { AutomaticCommand, SourceStopReceipt } from "@/core/fleet-automatic";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { setTierManual } from "@/services/admin-accounts";
import { revokeFleetDevice } from "@/services/fleet-pairing";
import { acknowledgeFleetCapabilities } from "@/services/fleet-device";
import {
  controlFleetAutomatic,
  readFleetAutomatic,
  readFleetAutomaticReceipt,
} from "@/services/fleet-automatic";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount } from "./helpers/seed";
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
  const p = await pairDevice(ctx.db, owner.id, NOW, [SHARED_CAPABILITY]);
  await acknowledgeFleetCapabilities(ctx.db, {
    sessionId: p.sessionId,
    revision: 1,
    now: NOW,
    capabilities: [SHARED_CAPABILITY],
  });
  let revision = 1;
  const command = (
    enabled = true,
    generation = 0,
    consentRevision = generation,
  ): AutomaticCommand => ({
    protocol: 2,
    request_id: randomUUID(),
    intent_created_at: NOW.toISOString(),
    enabled,
    expected_generation: generation,
    expected_revision: consentRevision,
  });
  const run = (command: AutomaticCommand, ms = ++revision * 500) =>
    controlFleetAutomatic(
      ctx.db,
      { sessionId: p.sessionId, revision, now: at(ms) },
      command,
    );
  return { ...p, owner, command, run };
}
it("absent status and matching ancient Off allocate no consent, receipt or audit history", async () => {
  const p = await setup();
  const before = await ctx.db.select().from(auditLog);
  const off = { ...p.command(false), intent_created_at: "2000-01-01T00:00:00.000Z" };
  expect(await p.run(off)).toMatchObject({
    ok: true,
    value: {
      protocol: 2,
      result: "already_off",
      receipt: null,
      status: {
        readiness: "off",
        sources: [],
        consent: { generation: 0, revision: 0, enabled: false },
      },
    },
  });
  expect(await ctx.db.select().from(fleetAutomaticConsent)).toHaveLength(0);
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(0);
  expect(await ctx.db.select().from(auditLog)).toEqual(before);
  expect(
    await readFleetAutomaticReceipt(
      ctx.db,
      { sessionId: p.sessionId, revision: 3, now: at(1500) },
      off.request_id,
    ),
  ).toEqual({ ok: false, code: "receipt_not_found" });
});
it("On saves explicit account approval without grants, sources, combat or participation", async () => {
  const p = await setup();
  const on = p.command();
  expect(await p.run(on)).toMatchObject({
    ok: true,
    value: {
      result: "applied",
      status: {
        readiness: "waiting_for_grant",
        consent: {
          generation: 1,
          revision: 1,
          enabled: true,
          approving_device_id: p.device.id,
        },
      },
    },
  });
  expect(await ctx.db.select().from(fleetSourceIntent)).toHaveLength(0);
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(1);
  expect(await p.run(on)).toMatchObject({ ok: true, value: { result: "replayed" } });
  expect(await p.run({ ...on, enabled: false })).toEqual({
    ok: false,
    code: "request_id_conflict",
  });
});
it("terminal Off and receipt replay survive Member and session ceiling/ack loss", async () => {
  const p = await setup();
  const on = p.command();
  expect((await p.run(on)).ok).toBe(true);
  await ctx.db.update(account).set({ tier: "alumni" }).where(eq(account.id, p.owner.id));
  await ctx.db
    .update(fleetDeviceSession)
    .set({ approvedCapabilities: [], acknowledgedCapabilities: [] });
  expect(await p.run(on)).toMatchObject({
    ok: true,
    value: { result: "replayed", status: { readiness: "member_required" } },
  });
  expect(await p.run(p.command(true, 1))).toEqual({ ok: false, code: "forbidden" });
  expect(
    await p.run({
      ...p.command(false, 1),
      intent_created_at: "2000-01-01T00:00:00.000Z",
    }),
  ).toMatchObject({
    ok: true,
    value: {
      result: "applied",
      status: { consent: { generation: 1, revision: 2, enabled: false } },
    },
  });
});
it("both CAS fields fence old Off after reauthorization", async () => {
  const p = await setup();
  expect((await p.run(p.command())).ok).toBe(true);
  expect((await p.run(p.command(true, 1))).ok).toBe(true);
  for (const [g, r] of [
    [1, 1],
    [1, 2],
    [2, 1],
  ])
    expect(await p.run(p.command(false, g, r))).toEqual({ ok: false, code: "conflict" });
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0]).toMatchObject({
    generation: 2,
    revision: 2,
    enabled: true,
  });
});
it("H255 plus durable R accepts Off; replay at H256 and no-op do not grow history", async () => {
  const p = await setup();
  const on = p.command();
  expect((await p.run(on)).ok).toBe(true);
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
  expect(await p.run(p.command(true, 1))).toEqual({
    ok: false,
    code: "receipt_capacity",
  });
  const off = p.command(false, 1);
  expect(await p.run(off)).toMatchObject({ ok: true, value: { result: "applied" } });
  expect(await p.run(off)).toMatchObject({ ok: true, value: { result: "replayed" } });
  expect(await p.run(p.command(false, 1, 2))).toMatchObject({
    ok: true,
    value: { result: "already_off", receipt: null },
  });
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(256);
});
it.each(["fleet_automatic_receipt", "audit_log"])(
  "%s failure rolls back consent and cadence",
  async (table) => {
    const p = await setup();
    expect(
      await withInjectedPgFault(
        ctx.pool,
        { matchSql: new RegExp('insert into "' + table + '"', "i"), code: "40001" },
        () => p.run(p.command()),
      ),
    ).toEqual({ ok: false, code: "service_unavailable" });
    expect(await ctx.db.select().from(fleetAutomaticConsent)).toHaveLength(0);
    expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(0);
    expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(1);
  },
);
it("complete response byte refusal rolls back the accepted command", async () => {
  const p = await setup();
  const original = Buffer.byteLength.bind(Buffer);
  const spy = vi
    .spyOn(Buffer, "byteLength")
    .mockImplementation((value, encoding) =>
      typeof value === "string" &&
      value.startsWith('{"protocol":2,') &&
      value.includes('"status"')
        ? 16385
        : original(value, encoding),
    );
  try {
    expect(await p.run(p.command())).toEqual({ ok: false, code: "service_unavailable" });
  } finally {
    spy.mockRestore();
  }
  expect(await ctx.db.select().from(fleetAutomaticConsent)).toHaveLength(0);
  expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(1);
});
it.each([false, true])(
  "account lock serializes competing explicit On first=%s",
  async (reverse) => {
    const p = await setup();
    const q = await pairDevice(ctx.db, p.owner.id, NOW, [SHARED_CAPABILITY]);
    await acknowledgeFleetCapabilities(ctx.db, {
      sessionId: q.sessionId,
      revision: 1,
      now: NOW,
      capabilities: [SHARED_CAPABILITY],
    });
    const holder = await ctx.pool.connect();
    let a: ReturnType<typeof controlFleetAutomatic> | undefined;
    let b: ReturnType<typeof controlFleetAutomatic> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from account where id=$1 for update", [p.owner.id]);
      const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      const ids = reverse ? [q.sessionId, p.sessionId] : [p.sessionId, q.sessionId];
      a = controlFleetAutomatic(
        ctx.db,
        { sessionId: ids[0], revision: 2, now: at(1000) },
        p.command(),
      );
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      b = controlFleetAutomatic(
        ctx.db,
        { sessionId: ids[1], revision: 2, now: at(1000) },
        p.command(),
      );
      await holder.query("commit");
      expect(await a).toMatchObject({
        ok: true,
        value: { status: { consent: { generation: 1, revision: 1 } } },
      });
      expect(await b).toEqual({ ok: false, code: "conflict" });
    } finally {
      await holder.query("rollback");
      holder.release();
      await Promise.allSettled(
        [a, b].filter((v): v is NonNullable<typeof v> => v !== undefined),
      );
    }
    expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(1);
  },
);
it("zero-source approver revocation closes only its current generation without a user receipt", async () => {
  const p = await setup();
  expect((await p.run(p.command())).ok).toBe(true);
  await revokeFleetDevice(ctx.db, p.device.id, p.owner.id, at(1500));
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0]).toMatchObject({
    enabled: false,
    revision: 2,
    closedReason: "approver_revoked",
    approvingDeviceId: p.device.id,
  });
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(1);
});
it("revoking an old approver preserves replacement-device On", async () => {
  const p = await setup();
  expect((await p.run(p.command())).ok).toBe(true);
  const q = await pairDevice(ctx.db, p.owner.id, NOW, [SHARED_CAPABILITY]);
  await acknowledgeFleetCapabilities(ctx.db, {
    sessionId: q.sessionId,
    revision: 1,
    now: NOW,
    capabilities: [SHARED_CAPABILITY],
  });
  expect(
    (
      await controlFleetAutomatic(
        ctx.db,
        { sessionId: q.sessionId, revision: 2, now: at(1500) },
        p.command(true, 1),
      )
    ).ok,
  ).toBe(true);
  await revokeFleetDevice(ctx.db, p.device.id, p.owner.id, at(2000));
  expect((await ctx.db.select().from(fleetAutomaticConsent))[0]).toMatchObject({
    enabled: true,
    generation: 2,
    revision: 2,
    approvingDeviceId: q.device.id,
  });
});
it.each(["member", "mode"])(
  "%s loss/quick restore leaves dormant On but clears candidate claims without counter reset",
  async (loss) => {
    const p = await setup();
    expect((await p.run(p.command())).ok).toBe(true);
    await ctx.db.insert(fleetAutomaticCandidate).values({
      accountId: p.owner.id,
      characterId: 99001,
      consentGeneration: 1,
      candidateGeneration: 5,
      claimGeneration: 9,
      ownerHash: "test",
      linkEpoch: randomUUID(),
      nextAttemptAt: at(5000),
      claimReservationId: randomUUID(),
      claimExpiresAt: at(30000),
    });
    if (loss === "member") {
      const admin = await seedAccount(ctx.db, { isAdmin: true });
      expect(
        (
          await ctx.db.transaction((tx) =>
            setTierManual(tx, admin.id, p.owner.id, "alumni"),
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await ctx.db.transaction((tx) =>
            setTierManual(tx, admin.id, p.owner.id, "member"),
          )
        ).ok,
      ).toBe(true);
    } else {
      const mode = await transitionFleetSharingMode(ctx.db, {
        enabled: false,
        expectedRevision: 3,
        now: at(2000),
      });
      await transitionFleetSharingMode(ctx.db, {
        enabled: true,
        expectedRevision: mode.revision,
        now: at(2500),
      });
    }
    expect((await ctx.db.select().from(fleetAutomaticConsent))[0]).toMatchObject({
      enabled: true,
      generation: 1,
      revision: 1,
    });
    expect((await ctx.db.select().from(fleetAutomaticCandidate))[0]).toMatchObject({
      candidateGeneration: 5,
      claimGeneration: 9,
      claimReservationId: null,
      claimExpiresAt: null,
      reservationId: null,
      enqueueUntil: null,
      sourceId: null,
    });
  },
);
it("expired On receipt does not strand unchanged days-old Off and expired applied Off cannot replay", async () => {
  const p = await setup();
  expect((await p.run(p.command())).ok).toBe(true);
  await ctx.db.update(fleetDeviceSession).set({ expiresAt: at(3 * 86400000) });
  const off = p.command(false, 1);
  expect(
    await controlFleetAutomatic(
      ctx.db,
      { sessionId: p.sessionId, revision: 3, now: at(86402000) },
      off,
    ),
  ).toMatchObject({ ok: true, value: { result: "applied" } });
  expect(await ctx.db.select().from(fleetAutomaticReceipt)).toHaveLength(1);
  expect(
    await controlFleetAutomatic(
      ctx.db,
      { sessionId: p.sessionId, revision: 4, now: at(2 * 86400000 + 3000) },
      off,
    ),
  ).toEqual({ ok: false, code: "conflict" });
  expect(
    await readFleetAutomaticReceipt(
      ctx.db,
      { sessionId: p.sessionId, revision: 4, now: at(2 * 86400000 + 3000) },
      off.request_id,
    ),
  ).toEqual({ ok: false, code: "receipt_not_found" });
});
it.each(["future", "stale", "date-bound"])(
  "new On %s refuses with no consent or cadence mutation",
  async (kind) => {
    const p = await setup();
    const time = kind === "date-bound" ? new Date("9999-12-31T23:59:58.000Z") : at(1000);
    if (kind === "date-bound")
      await ctx.db
        .update(fleetDeviceSession)
        .set({ expiresAt: new Date("9999-12-31T23:59:59.999Z") });
    const command = {
      ...p.command(),
      intent_created_at:
        kind === "future"
          ? at(2000).toISOString()
          : kind === "stale"
            ? at(-60000).toISOString()
            : time.toISOString(),
    };
    expect(
      await controlFleetAutomatic(
        ctx.db,
        { sessionId: p.sessionId, revision: 2, now: time },
        command,
      ),
    ).toEqual({
      ok: false,
      code: kind === "date-bound" ? "service_unavailable" : "invalid_intent",
    });
    expect(await ctx.db.select().from(fleetAutomaticConsent)).toHaveLength(0);
    expect((await ctx.db.select().from(fleetDeviceSession))[0].lastRevision).toBe(1);
  },
);
it("new command freshness and CAS precede work-only permission refusal", async () => {
  const p = await setup();
  await ctx.db.update(account).set({ tier: "alumni" });
  expect(
    await p.run({ ...p.command(), intent_created_at: at(-60000).toISOString() }),
  ).toEqual({ ok: false, code: "invalid_intent" });
  expect(await p.run(p.command(true, 1))).toEqual({ ok: false, code: "conflict" });
});
it("automatic commands share live request UUID namespace with inline Stop receipts", async () => {
  const p = await setup();
  const command = p.command();
  const sourceId = randomUUID();
  const stop: SourceStopReceipt = {
    kind: "source_stop",
    command: {
      protocol: 2,
      operation: "stop",
      request_id: command.request_id,
      intent_created_at: NOW.toISOString(),
      source_id: sourceId.toUpperCase(),
      expected_generation: 0,
      expected_automatic: null,
    },
    accepted_at: at(500).toISOString(),
    expires_at: at(86400500).toISOString(),
    source: {
      source_id: sourceId,
      generation: 1,
      character_id: null,
      state: "ended",
      reason: "stopped",
      pending_expires_at: null,
      automatic: null,
    },
    automatic_effect: "unknown_cancelled",
    consent: {
      generation: 0,
      revision: 0,
      enabled: false,
      approving_device_id: null,
      approved_at: null,
      disabled_at: null,
      closed_reason: null,
    },
  };
  await ctx.db.insert(fleetSourceIntent).values({
    id: sourceId,
    accountId: p.owner.id,
    deviceId: p.device.id,
    generation: 1,
    state: "ended",
    intentCreatedAt: NOW,
    intentExpiresAt: at(60000),
    endedAt: at(500),
    terminalReason: "stopped",
    retainUntil: at(86460000),
    explicitlyStopped: true,
    stopReceipt: stop,
  });
  expect(await p.run(command)).toEqual({ ok: false, code: "request_id_conflict" });
  expect(
    await readFleetAutomaticReceipt(
      ctx.db,
      { sessionId: p.sessionId, revision: 3, now: at(1500) },
      command.request_id,
    ),
  ).toMatchObject({
    ok: true,
    value: { receipt: stop, status: { consent: { generation: 0, enabled: false } } },
  });
  expect(await ctx.db.select().from(fleetAutomaticConsent)).toHaveLength(0);
});
it("terminal status never bypasses expired sessions", async () => {
  const p = await setup();
  await ctx.db.update(fleetDeviceSession).set({ expiresAt: NOW });
  expect(
    await readFleetAutomatic(ctx.db, {
      sessionId: p.sessionId,
      revision: 2,
      now: at(1000),
    }),
  ).toEqual({ ok: false, code: "unauthorized" });
});

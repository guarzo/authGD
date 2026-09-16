import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  fleetDevice,
  fleetDeviceSession,
  fleetTelemetryRow,
  fleetPublisherLease,
  character,
  fleetSourceAuthority,
} from "@/db/schema";
import { replaceDeviceProjection, readFleetProjection } from "@/services/fleet-relay";
import {
  acknowledgeFleetCapabilities,
  readFleetDeviceState,
} from "@/services/fleet-device";
import { pairDevice, waitUntilBlockedBy } from "./helpers/fleet-sharing";
import { setFleetParticipation } from "@/services/fleet-participation";
import { seedAccount } from "./helpers/seed";
import { setupTestDb, truncateAll } from "./helpers/db";
import { sharedAccounts, at, NOW } from "./helpers/fleet-shared-admission";

const BOTH = ["shared-source-v1", "combat-v2"];
it("participation Off keeps its existing forbidden publish ruling rather than claiming combat approval is missing", async () => {
  const p = await published();
  await ctx.db
    .update(fleetDevice)
    .set({ participationEnabled: false })
    .where(eq(fleetDevice.id, p.b.device.id));
  const before = await retained();
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 3,
      now: at(3500),
      sampledAtMs: at(3000).getTime(),
      rows: p.rows,
    }),
  ).toEqual({ ok: false, code: "forbidden" });
  expect(await retained()).toEqual(before);
});
it("sharing Off never falls back to an old reader/writer, including empty withdrawal", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const p = await pairDevice(ctx.db, owner.id, NOW);
  const before = await retained();
  const call = { sessionId: p.sessionId, revision: 1, now: NOW };
  expect(await readFleetProjection(ctx.db, call)).toEqual({
    ok: false,
    code: "feature_disabled",
  });
  expect(
    await replaceDeviceProjection(ctx.db, { ...call, sampledAtMs: 0, rows: [] }),
  ).toEqual({ ok: false, code: "feature_disabled" });
  expect(await retained()).toEqual(before);
});
it("device anchor waits for its actual DB lock and ignores a displaced application clock", async () => {
  const dbNow = (await ctx.pool.query<{ now: Date }>("select clock_timestamp() as now"))
    .rows[0].now;
  const p = await combatAccounts(new Date(dbNow.getTime() - 3000));
  const holder = await ctx.pool.connect();
  let pending: ReturnType<typeof readFleetDeviceState> | undefined;
  try {
    await holder.query("begin");
    await holder.query("select id from fleet_device where id = $1 for update", [
      p.b.device.id,
    ]);
    const pid = (await holder.query<{ pid: number }>("select pg_backend_pid() as pid"))
      .rows[0].pid;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(dbNow.getTime() + 5000));
    pending = readFleetDeviceState(ctx.db, { sessionId: p.b.sessionId, revision: 2 });
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    const releaseAt = (
      await holder.query<{ now: Date }>("select clock_timestamp() as now")
    ).rows[0].now;
    await holder.query("commit");
    const result = await pending;
    if (!result.ok) throw new Error(result.code);
    const after = (await ctx.pool.query<{ now: Date }>("select clock_timestamp() as now"))
      .rows[0].now;
    expect(result.value.serverTimeMs).toBeGreaterThanOrEqual(releaseAt.getTime());
    expect(result.value.serverTimeMs).toBeLessThanOrEqual(after.getTime());
    const session = (await retained()).sessions.find(
      (s) => s.id === createHash("sha256").update(p.b.sessionId).digest("base64url"),
    )!;
    expect(session.lastReadAt!.getTime()).toBe(result.value.serverTimeMs);
  } finally {
    vi.useRealTimers();
    await holder.query("rollback");
    holder.release();
    await pending;
  }
});
async function combatAccounts(baseNow = NOW) {
  const p = await sharedAccounts(ctx.db, baseNow);
  const b = await pairDevice(ctx.db, p.participant.id, baseNow, BOTH, {
    privateKey: p.b.privateKey,
    publicKeySpki: p.b.publicKeySpki,
  });
  expect(
    (
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: b.sessionId,
        revision: 1,
        now: baseNow,
        capabilities: BOTH,
      })
    ).ok,
  ).toBe(true);
  return { ...p, b };
}
const combatRow = (characterId: number) => ({
  characterId,
  outgoingDps: null,
  incomingDps: 42,
  activityAgeMs: 5000,
  effects: [
    {
      kind: "SCRAM" as const,
      observations: [
        { name: "é", ageMs: 6000 },
        { name: null, ageMs: 29900 },
      ],
    },
    { kind: "NEUT" as const, observations: [{ name: null, ageMs: 8000 }] },
  ],
});
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());

// Returning an app-clock/absent anchor instead of the admitted DB sample must fail.
it("device anchor is exactly the same post-lock sample committed to read cadence", async () => {
  const p = await sharedAccounts(ctx.db);
  const result = await readFleetDeviceState(ctx.db, {
    sessionId: p.b.sessionId,
    revision: 3,
    now: at(2500),
  });
  expect(result).toMatchObject({ ok: true, value: { serverTimeMs: at(2500).getTime() } });
  const [session] = await ctx.db
    .select()
    .from(fleetDeviceSession)
    .where(eq(fleetDeviceSession.deviceId, p.b.device.id));
  expect(session.lastReadAt).toEqual(at(2500));
});

it("complete combat replaces the sole payload, prunes transit-expired effects and authorizes a shared-only receiver", async () => {
  const p = await combatAccounts();
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 2,
      now: at(2700),
      sampledAtMs: at(2000).getTime(),
      rows: [combatRow(p.alts[0].id)],
    }),
  ).toEqual({ ok: true, json: '{"protocol":2}' });
  const [stored] = await ctx.db.select().from(fleetTelemetryRow);
  expect(stored).toMatchObject({
    outgoingDps: null,
    incomingDps: 42,
    sampledAtMs: at(2000).getTime(),
    activityOriginMs: at(-3000).getTime(),
    effects: [
      { kind: "SCRAM", observations: [{ name: "é", origin_ms: at(-4000).getTime() }] },
      { kind: "NEUT", observations: [{ name: null, origin_ms: at(-6000).getTime() }] },
    ],
    receivedAt: at(2700),
    staleAt: at(5000),
    hardExpiresAt: at(12000),
    sourceId: p.source.sourceId,
    sourceGeneration: 1,
    authorityGeneration: 1,
    linkEpoch: p.alts[0].fleetLinkEpoch,
    participationGeneration: 1,
  });
  const read = await readFleetProjection(ctx.db, {
    sessionId: p.a.sessionId,
    revision: 4,
    now: at(4000),
  });
  expect(read).toMatchObject({
    ok: true,
    serverTimeMs: at(4000).getTime(),
    rows: [
      {
        characterId: p.alts[0].id,
        outgoingDps: null,
        incomingDps: 42,
        ageMs: 2000,
        activityAgeMs: 7000,
        state: "live",
        effects: [
          { kind: "SCRAM", observations: [{ name: "é", ageMs: 8000 }] },
          { kind: "NEUT", observations: [{ name: null, ageMs: 10000 }] },
        ],
      },
    ],
  });
});

it("real same-key approval unions device rights, never the next session ceiling or acknowledgement", async () => {
  const p = await sharedAccounts(ctx.db);
  const keys = { privateKey: p.b.privateKey, publicKeySpki: p.b.publicKeySpki };
  const upgrade = await pairDevice(
    ctx.db,
    p.participant.id,
    NOW,
    ["shared-source-v1", "combat-v2"],
    keys,
  );
  const smaller = await pairDevice(
    ctx.db,
    p.participant.id,
    NOW,
    ["shared-source-v1"],
    keys,
  );
  expect(upgrade.device.id).toBe(p.b.device.id);
  expect(
    await readFleetDeviceState(ctx.db, {
      sessionId: smaller.sessionId,
      revision: 1,
      now: at(2500),
    }),
  ).toMatchObject({
    ok: true,
    value: {
      approvedCapabilities: ["shared-source-v1", "combat-v2"],
      sessionApprovedCapabilities: ["shared-source-v1"],
      acknowledgedCapabilities: [],
    },
  });
  expect(
    await acknowledgeFleetCapabilities(ctx.db, {
      sessionId: smaller.sessionId,
      revision: 2,
      now: at(3000),
      capabilities: ["shared-source-v1", "combat-v2"],
    }),
  ).toEqual({ ok: false, code: "capability_required" });
});

it("malformed complete device output refuses before acknowledgement and cadence commit", async () => {
  const p = await sharedAccounts(ctx.db);
  await ctx.db
    .update(fleetDevice)
    .set({ approvedCapabilities: ["shared-source-v1", "unknown"] })
    .where(eq(fleetDevice.id, p.b.device.id));
  const before = await ctx.db.select().from(fleetDeviceSession);
  expect(
    await acknowledgeFleetCapabilities(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 3,
      now: at(2500),
      capabilities: [],
    }),
  ).toEqual({ ok: false, code: "service_unavailable" });
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
});

async function published() {
  const p = await combatAccounts();
  const rows = [combatRow(p.alts[0].id)];
  expect(
    (
      await replaceDeviceProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 2,
        now: at(2700),
        sampledAtMs: at(2000).getTime(),
        rows,
      })
    ).ok,
  ).toBe(true);
  return { ...p, rows };
}
async function retained() {
  return {
    rows: await ctx.db
      .select()
      .from(fleetTelemetryRow)
      .orderBy(fleetTelemetryRow.characterId),
    leases: await ctx.db
      .select()
      .from(fleetPublisherLease)
      .orderBy(fleetPublisherLease.characterId),
    sessions: await ctx.db
      .select()
      .from(fleetDeviceSession)
      .orderBy(fleetDeviceSession.id),
  };
}
it("republishing the same measurement changes per-row UUID but never sample, evidence origins or transport deadlines", async () => {
  const p = await published();
  const before = (await retained()).rows[0];
  expect(
    (
      await replaceDeviceProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 3,
        now: at(3500),
        sampledAtMs: at(2000).getTime(),
        rows: p.rows,
      })
    ).ok,
  ).toBe(true);
  const after = (await retained()).rows[0];
  expect(after.publicationId).not.toBe(before.publicationId);
  expect(after).toMatchObject({
    sampledAtMs: before.sampledAtMs,
    activityOriginMs: before.activityOriginMs,
    effects: before.effects,
    staleAt: before.staleAt,
    hardExpiresAt: before.hardExpiresAt,
    receivedAt: at(3500),
  });
});
it.each([2999, 3000, 9999, 10000])(
  "measurement age %sms, not receipt age, determines live/stale/expired",
  async (ageMs) => {
    const p = await published();
    if (ageMs >= 9999) {
      p.source.setNow(7000);
      await p.source.run();
    }
    const read = await readFleetProjection(ctx.db, {
      sessionId: p.a.sessionId,
      revision: 4,
      now: at(2000 + ageMs),
    });
    expect(read).toMatchObject({
      ok: true,
      rows:
        ageMs < 10000
          ? [expect.objectContaining({ ageMs, state: ageMs < 3000 ? "live" : "stale" })]
          : [],
    });
  },
);
it.each([
  "future sample",
  "expired sample",
  "expired row",
  "negative origin",
  "noncanonical name",
  "bad withdrawal",
])(
  "%s refuses atomic replacement without touching projection, lease or cadence",
  async (bad) => {
    const p = await published();
    const before = await retained();
    let sampledAtMs = at(3000).getTime();
    let rows = [combatRow(p.alts[1].id)];
    if (bad === "future sample") sampledAtMs = at(3501).getTime();
    if (bad === "expired sample") sampledAtMs = at(-6500).getTime();
    if (bad === "expired row")
      rows = [
        { ...combatRow(p.alts[1].id), effects: [], activityAgeMs: 0 },
        { ...combatRow(p.alts[0].id), effects: [], activityAgeMs: 29999 },
      ];
    if (bad === "negative origin") sampledAtMs = 4999;
    if (bad === "noncanonical name") rows[0].effects[0].observations[0].name = "e\u0301";
    if (bad === "bad withdrawal") rows = [];
    expect(
      await replaceDeviceProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 3,
        now: at(3500),
        sampledAtMs,
        rows,
      }),
    ).toEqual({ ok: false, code: "bad_request" });
    expect(await retained()).toEqual(before);
  },
);
it("independent observed names/null buckets expire without hiding live row activity or manufacturing zero DPS", async () => {
  const p = await combatAccounts();
  expect(
    (
      await replaceDeviceProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 2,
        now: at(2000),
        sampledAtMs: at(2000).getTime(),
        rows: [
          {
            characterId: p.alts[0].id,
            outgoingDps: null,
            incomingDps: null,
            activityAgeMs: 0,
            effects: [
              {
                kind: "SCRAM",
                observations: [
                  { name: "A", ageMs: 29000 },
                  { name: "B", ageMs: 28000 },
                  { name: null, ageMs: 29000 },
                ],
              },
              { kind: "POINT", observations: [{ name: "A", ageMs: 28000 }] },
              { kind: "NEUT", observations: [{ name: null, ageMs: 29000 }] },
            ],
          },
        ],
      })
    ).ok,
  ).toBe(true);
  const read = await readFleetProjection(ctx.db, {
    sessionId: p.a.sessionId,
    revision: 4,
    now: at(3000),
  });
  expect(read).toMatchObject({
    ok: true,
    rows: [
      {
        outgoingDps: null,
        incomingDps: null,
        activityAgeMs: 1000,
        effects: [
          { kind: "SCRAM", observations: [{ name: "B", ageMs: 29000 }] },
          { kind: "POINT", observations: [{ name: "A", ageMs: 29000 }] },
        ],
      },
    ],
  });
  const quiet = await readFleetProjection(ctx.db, {
    sessionId: p.a.sessionId,
    revision: 5,
    now: at(4000),
  });
  expect(quiet).toMatchObject({
    ok: true,
    rows: [{ outgoingDps: null, incomingDps: null, activityAgeMs: 2000, effects: [] }],
  });
});
it("lease competition is global and omission/participation-Off withdrawal removes only this device's complete projection", async () => {
  const p = await published();
  const other = await pairDevice(ctx.db, p.participant.id, NOW, BOTH);
  expect(
    (
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: other.sessionId,
        revision: 1,
        now: NOW,
        capabilities: BOTH,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await setFleetParticipation(ctx.db, {
        sessionId: other.sessionId,
        revision: 2,
        now: at(500),
        enabled: true,
        expectedGeneration: 0,
      })
    ).ok,
  ).toBe(true);
  const before = await retained();
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: other.sessionId,
      revision: 3,
      now: at(3500),
      sampledAtMs: at(3000).getTime(),
      rows: [combatRow(p.alts[1].id), ...p.rows],
    }),
  ).toEqual({ ok: false, code: "conflict" });
  expect(await retained()).toEqual(before);
  expect(
    (
      await replaceDeviceProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 3,
        now: at(3500),
        sampledAtMs: at(3000).getTime(),
        rows: [combatRow(p.alts[1].id)],
      })
    ).ok,
  ).toBe(true);
  expect((await retained()).rows.map((r) => r.characterId)).toEqual([p.alts[1].id]);
  expect(
    (
      await setFleetParticipation(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 4,
        now: at(4000),
        enabled: false,
        expectedGeneration: 1,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await replaceDeviceProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 5,
        now: at(4500),
        sampledAtMs: 0,
        rows: [],
      })
    ).ok,
  ).toBe(true);
  expect((await retained()).rows).toEqual([]);
});
it.each(["D", "C", "K", "revoked", "proof"])(
  "current publisher %s loss fences both writes and retained disclosures",
  async (loss) => {
    const p = await published();
    if (loss === "D")
      await ctx.db
        .update(fleetDevice)
        .set({ approvedCapabilities: ["shared-source-v1"] })
        .where(eq(fleetDevice.id, p.b.device.id));
    if (loss === "C" || loss === "K")
      await ctx.db
        .update(fleetDeviceSession)
        .set(
          loss === "C"
            ? { approvedCapabilities: ["shared-source-v1"] }
            : { acknowledgedCapabilities: ["shared-source-v1"] },
        )
        .where(eq(fleetDeviceSession.deviceId, p.b.device.id));
    if (loss === "revoked")
      await ctx.db
        .update(fleetDevice)
        .set({ revokedAt: at(3000) })
        .where(eq(fleetDevice.id, p.b.device.id));
    if (loss === "proof")
      await ctx.db.update(fleetSourceAuthority).set({ expiresAt: at(3000) });
    const before = await retained();
    expect(
      (
        await replaceDeviceProjection(ctx.db, {
          sessionId: p.b.sessionId,
          revision: 3,
          now: at(3500),
          sampledAtMs: at(3000).getTime(),
          rows: p.rows,
        })
      ).ok,
    ).toBe(false);
    expect(await retained()).toEqual(before);
    const read = await readFleetProjection(ctx.db, {
      sessionId: p.a.sessionId,
      revision: 4,
      now: at(3500),
    });
    expect(read.ok ? read.rows : []).toEqual([]);
    expect((await retained()).rows).toEqual(before.rows);
  },
);
it("a shared-only source boss remains viable with participation Off and no initiating session", async () => {
  const p = await published();
  expect(
    (
      await setFleetParticipation(ctx.db, {
        sessionId: p.a.sessionId,
        revision: 4,
        now: at(3000),
        enabled: false,
        expectedGeneration: 1,
      })
    ).ok,
  ).toBe(true);
  await ctx.db
    .delete(fleetDeviceSession)
    .where(eq(fleetDeviceSession.deviceId, p.a.device.id));
  const read = await readFleetProjection(ctx.db, {
    sessionId: p.b.sessionId,
    revision: 3,
    now: at(3500),
  });
  expect(read).toMatchObject({ ok: true, rows: [{ characterId: p.alts[0].id }] });
});
it.each(["identity", "observation", "oversize"])(
  "invalid selected %s refuses WHOLE output without advancing receiver cadence",
  async (bad) => {
    const p = await published();
    expect(
      (
        await replaceDeviceProjection(ctx.db, {
          sessionId: p.b.sessionId,
          revision: 3,
          now: at(3500),
          sampledAtMs: at(3000).getTime(),
          rows: [...p.rows, combatRow(p.alts[1].id)],
        })
      ).ok,
    ).toBe(true);
    if (bad === "identity")
      await ctx.db
        .update(character)
        .set({ name: "bad\u200dname" })
        .where(eq(character.id, p.alts[1].id));
    if (bad === "observation")
      await ctx.db
        .update(fleetTelemetryRow)
        .set({
          effects: [
            {
              kind: "POINT",
              observations: [{ name: "e\u0301", origin_ms: at(-3000).getTime() }],
            },
          ],
        })
        .where(eq(fleetTelemetryRow.characterId, p.alts[1].id));
    const before = await retained();
    // A valid bounded DTO cannot reach 64MiB. Inject a transport-size fault at the
    // real serializer's byte counter, not a fake DB/read model; tx must roll back.
    const bytes = Buffer.byteLength.bind(Buffer);
    const spy =
      bad === "oversize"
        ? vi
            .spyOn(Buffer, "byteLength")
            .mockImplementation((value, encoding) =>
              typeof value === "string" && value.includes('"server_time_ms"')
                ? 67108865
                : bytes(value, encoding),
            )
        : null;
    try {
      expect(
        await readFleetProjection(ctx.db, {
          sessionId: p.a.sessionId,
          revision: 4,
          now: at(4000),
        }),
      ).toEqual({ ok: false, code: "service_unavailable" });
    } finally {
      spy?.mockRestore();
    }
    expect(await retained()).toEqual(before);
  },
);
it("the actual DB constraints reject unsafe origins, DPS and malformed/beyond-capacity effect objects", async () => {
  await published();
  const original = (await retained()).rows;
  for (const mutation of [
    { outgoingDps: -1 },
    { incomingDps: 10000001 },
    { sampledAtMs: 9007199254740992 },
    { activityOriginMs: -1 },
    { activityOriginMs: at(2001).getTime() },
    { effects: [{ kind: "NEUT", observations: [{ name: "bad", origin_ms: 0 }] }] },
    { effects: [{ kind: "POINT", observations: [{ name: null, origin_ms: -1 }] }] },
    {
      effects: [
        {
          kind: "POINT",
          observations: [{ name: null, origin_ms: at(-4000).getTime() + 0.5 }],
        },
      ],
    },
    {
      effects: [
        {
          kind: "POINT",
          observations: [
            { name: null, origin_ms: at(-4000).getTime() },
            { name: null, origin_ms: at(-4000).getTime() },
          ],
        },
      ],
    },
    {
      effects: [
        {
          kind: "POINT",
          observations: Array.from({ length: 9 }, (_, i) => ({
            name: String(i),
            origin_ms: at(-4000).getTime(),
          })),
        },
      ],
    },
    { effects: [{ kind: "POINT", observations: [] }] },
    { effects: [{ kind: "POINT", observations: [{ origin_ms: at(-4000).getTime() }] }] },
  ]) {
    await expect(
      ctx.db
        .update(fleetTelemetryRow)
        .set(mutation as Partial<typeof fleetTelemetryRow.$inferInsert>),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    expect((await retained()).rows).toEqual(original);
  }
});
it("lock-delayed publication expires against actual PostgreSQL post-lock time, not injected/app/transaction-start time", async () => {
  const dbClock = (await ctx.pool.query<{ now: Date }>("select clock_timestamp() as now"))
    .rows[0].now;
  const p = await combatAccounts(new Date(dbClock.getTime() - 3000));
  const holder = await ctx.pool.connect();
  let pending: ReturnType<typeof replaceDeviceProjection> | undefined;
  try {
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(2, hashint8($1::bigint))", [
      p.alts[0].id,
    ]);
    const {
      rows: [{ pid }],
    } = await holder.query<{ pid: number }>("select pg_backend_pid() as pid");
    const now = (await holder.query<{ now: Date }>("select clock_timestamp() as now"))
      .rows[0].now;
    const before = await retained();
    pending = replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 2,
      sampledAtMs: now.getTime() - 9500,
      rows: [{ ...combatRow(p.alts[0].id), activityAgeMs: 0, effects: [] }],
    });
    expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
    await holder.query("select pg_sleep(0.6)");
    await holder.query("commit");
    expect(await pending).toEqual({ ok: false, code: "bad_request" });
    expect(await retained()).toEqual(before);
  } finally {
    await holder.query("rollback");
    holder.release();
    await pending;
  }
});
it.each([
  new Date(NaN),
  new Date("0000-01-01T00:00:00.000Z"),
  new Date("+010000-01-01T00:00:00.000Z"),
])("unsupported DB clock %s refuses device response before cadence", async (now) => {
  const p = await sharedAccounts(ctx.db);
  const before = await retained();
  expect(
    await readFleetDeviceState(ctx.db, { sessionId: p.b.sessionId, revision: 3, now }),
  ).toEqual({ ok: false, code: "service_unavailable" });
  expect(await retained()).toEqual(before);
});

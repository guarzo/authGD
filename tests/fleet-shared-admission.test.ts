import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  account,
  character,
  fleetDevice,
  fleetDeviceKeyIdentity,
  fleetDeviceSession,
  fleetEligibility,
  fleetPublisherLease,
  fleetSourceAuthority,
  fleetSourceIntent,
  fleetTelemetryRow,
} from "@/db/schema";
import { setFleetParticipation } from "@/services/fleet-participation";
import { SHARED_CAPABILITY } from "@/core/fleet-sharing";
import { pairDevice } from "./helpers/fleet-sharing";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import {
  buildDeviceCatalogue,
  readDeviceEligibility,
} from "@/services/fleet-eligibility";
import { readFleetProjection, replaceDeviceProjection } from "@/services/fleet-relay";
import { setupTestDb, truncateAll } from "./helpers/db";
import {
  at,
  NOW,
  participatingDevice,
  realSource,
  sharedAccounts,
} from "./helpers/fleet-shared-admission";
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());

it("eligibility discloses only own matching IDs and provenance, without requiring participant tokens", async () => {
  const p = await sharedAccounts(ctx.db);
  expect(
    await readDeviceEligibility(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 3,
      now: at(2500),
    }),
  ).toEqual({
    ok: true,
    value: {
      participationGeneration: 1,
      state: "ready",
      characters: p.alts.slice(0, 2).map((ch) => ({
        characterId: ch.id,
        sourceId: p.source.sourceId,
        sourceGeneration: 1,
        authorityGeneration: 1,
        expiresAt: at(12000),
      })),
    },
  });
});

// Removing source admission (or retaining the legacy own-FleetRead gate) fails
// this positive proof, rather than merely producing two indistinguishable refusals.
it("real boss authority admits an ungranted second account and a quiet receiver, with exact row AND lease provenance", async () => {
  const p = await sharedAccounts(ctx.db);
  expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
    sourceId: p.source.sourceId,
    verifiedAt: at(2000),
    expiresAt: at(12000),
  });
  const catalogue = await buildDeviceCatalogue(ctx.db, p.participant.id);
  expect(catalogue.characters.map((ch) => ch.characterId)).toEqual([
    90000002, 90000003, 90000004,
  ]);
  expect(await ctx.db.select().from(fleetEligibility)).toEqual([]);
  expect(
    (
      await ctx.db
        .select()
        .from(character)
        .where(eq(character.accountId, p.participant.id))
    ).every(
      (ch) =>
        ch.scopes.length === 0 &&
        ch.refreshTokenEnc === null &&
        ch.tokenStatus === "missing",
    ),
  ).toBe(true);
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.a.sessionId,
      revision: 4,
      now: at(2500),
      rows: [{ characterId: p.boss.id, dps: 42, ewar: [] }],
    }),
  ).toEqual({ ok: true });
  expect(
    await readFleetProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 3,
      now: at(2500),
    }),
  ).toMatchObject({
    ok: true,
    rows: [
      {
        characterId: p.boss.id,
        characterName: p.boss.name,
        dps: 42,
        ewar: [],
        state: "live",
        ageMs: 0,
      },
    ],
  });
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 4,
      now: at(3000),
      rows: [{ characterId: p.alts[0].id, dps: 77, ewar: ["SCRAM/POINT"] }],
    }),
  ).toEqual({ ok: true });
  const read = await readFleetProjection(ctx.db, {
    sessionId: p.a.sessionId,
    revision: 5,
    now: at(3000),
  });
  expect(read.ok && read.rows.map((row) => row.characterId).sort()).toEqual([
    90000001, 90000002,
  ]);
  for (const table of [fleetTelemetryRow, fleetPublisherLease]) {
    const [row] = await ctx.db
      .select()
      .from(table)
      .where(eq(table.characterId, p.alts[0].id));
    expect(row).toMatchObject({
      sourceId: p.source.sourceId,
      sourceGeneration: 1,
      authorityGeneration: 1,
      linkEpoch: p.alts[0].fleetLinkEpoch,
      participationGeneration: 1,
      deviceId: p.b.device.id,
      fleetId: 123,
    });
  }
  expect(await buildDeviceCatalogue(ctx.db, p.participant.id)).toEqual(catalogue);
  expect(await ctx.db.select().from(fleetEligibility)).toEqual([]);
});

async function admitted() {
  const p = await sharedAccounts(ctx.db);
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 3,
      now: at(2500),
      rows: [{ characterId: p.alts[0].id, dps: 77, ewar: ["SCRAM/POINT"] }],
    }),
  ).toEqual({ ok: true });
  const read = await readFleetProjection(ctx.db, {
    sessionId: p.a.sessionId,
    revision: 4,
    now: at(2500),
  });
  expect(read.ok && read.rows.map((r) => r.characterId)).toEqual([p.alts[0].id]);
  return p;
}

it.each([
  "publisher Off",
  "publisher tier",
  "publisher revoked",
  "publisher key",
  "publisher grant",
  "publisher ceiling",
  "publisher ack",
  "publisher expiry",
  "publisher link",
  "publisher ownership",
  "receiver Off",
  "receiver tier",
  "receiver revoked",
  "receiver key",
  "receiver grant",
  "receiver ceiling",
  "receiver ack",
  "receiver expiry",
  "boss owner",
  "boss epoch",
  "boss scope",
  "boss token",
  "source paused",
  "source pending",
  "source activation",
  "source generation",
  "source fleet",
  "source account",
  "source device",
  "authority generation",
  "authority expiry",
  "authority future",
  "authority origin age",
  "row future",
  "row hard expiry",
  "lease expiry",
  "lease fleet",
  "lease device",
  "lease session",
] as const)(
  "retained real-admitted row is never served after current %s invalidity, before cleanup",
  async (loss) => {
    const p = await admitted();
    const originalRows = await ctx.db.select().from(fleetTelemetryRow);
    const originalLeases = await ctx.db.select().from(fleetPublisherLease);
    const participant = loss.startsWith("publisher");
    const device = participant ? p.b : p.a;
    const deviceWhere = eq(fleetDevice.id, device.device.id);
    const sessionWhere = eq(fleetDeviceSession.deviceId, device.device.id);
    if (loss.endsWith(" Off"))
      await ctx.db
        .update(fleetDevice)
        .set({ participationEnabled: false })
        .where(deviceWhere);
    else if (loss.endsWith(" tier"))
      await ctx.db
        .update(account)
        .set({ tier: "alumni" })
        .where(eq(account.id, device.device.accountId));
    else if (loss.endsWith(" revoked"))
      await ctx.db
        .update(fleetDevice)
        .set({ revokedAt: at(3000) })
        .where(deviceWhere);
    else if (loss.endsWith(" key"))
      await ctx.db
        .update(fleetDeviceKeyIdentity)
        .set({ deviceId: null, conflicted: true })
        .where(eq(fleetDeviceKeyIdentity.deviceId, device.device.id));
    else if (loss.endsWith(" grant"))
      await ctx.db
        .update(fleetDevice)
        .set({ approvedCapabilities: [] })
        .where(deviceWhere);
    else if (loss.endsWith(" ceiling"))
      await ctx.db
        .update(fleetDeviceSession)
        .set({ approvedCapabilities: [] })
        .where(sessionWhere);
    else if (loss.endsWith(" ack"))
      await ctx.db
        .update(fleetDeviceSession)
        .set({ acknowledgedCapabilities: [] })
        .where(sessionWhere);
    else if (loss === "publisher expiry" || loss === "receiver expiry")
      await ctx.db
        .update(fleetDeviceSession)
        .set({ expiresAt: at(3000) })
        .where(sessionWhere);
    else if (loss === "publisher link")
      await ctx.db
        .update(character)
        .set({ fleetLinkEpoch: randomUUID() })
        .where(eq(character.id, p.alts[0].id));
    else if (loss === "publisher ownership")
      await ctx.db
        .update(character)
        .set({ accountId: p.owner.id })
        .where(eq(character.id, p.alts[0].id));
    else if (loss === "boss owner")
      await ctx.db
        .update(character)
        .set({ ownerHash: "new-owner" })
        .where(eq(character.id, p.boss.id));
    else if (loss === "boss epoch")
      await ctx.db
        .update(character)
        .set({ fleetLinkEpoch: randomUUID() })
        .where(eq(character.id, p.boss.id));
    else if (loss === "boss scope")
      await ctx.db
        .update(character)
        .set({ scopes: [] })
        .where(eq(character.id, p.boss.id));
    else if (loss === "boss token")
      await ctx.db
        .update(character)
        .set({ refreshTokenEnc: null, tokenStatus: "missing" })
        .where(eq(character.id, p.boss.id));
    else if (loss === "source paused" || loss === "source pending")
      await ctx.db
        .update(fleetSourceIntent)
        .set({ state: loss === "source paused" ? "paused" : "pending" });
    else if (loss === "source activation")
      await ctx.db.update(fleetSourceIntent).set({ activatedAt: null });
    else if (loss === "source generation")
      await ctx.db.update(fleetSourceIntent).set({ generation: 2 });
    else if (loss === "source fleet")
      await ctx.db.update(fleetSourceIntent).set({ fleetId: 456 });
    else if (loss === "source account")
      await ctx.db.update(fleetSourceIntent).set({ accountId: p.participant.id });
    else if (loss === "source device")
      await ctx.db.update(fleetSourceIntent).set({ deviceId: p.b.device.id });
    else if (loss === "authority generation")
      await ctx.db.update(fleetSourceAuthority).set({ authorityGeneration: 2 });
    else if (loss === "authority expiry")
      await ctx.db.update(fleetSourceAuthority).set({ expiresAt: at(3000) });
    else if (loss === "authority future")
      await ctx.db.update(fleetSourceAuthority).set({ verifiedAt: at(3001) });
    else if (loss === "authority origin age")
      await ctx.db.update(fleetSourceAuthority).set({ verifiedAt: at(-7000) });
    else if (loss === "row future")
      await ctx.db.update(fleetTelemetryRow).set({ receivedAt: at(3001) });
    else if (loss === "row hard expiry")
      await ctx.db.update(fleetTelemetryRow).set({ hardExpiresAt: at(3000) });
    else if (loss === "lease expiry")
      await ctx.db.update(fleetPublisherLease).set({ leaseExpiresAt: at(3000) });
    else if (loss === "lease fleet")
      await ctx.db.update(fleetPublisherLease).set({ fleetId: 456 });
    else if (loss === "lease device")
      await ctx.db.update(fleetPublisherLease).set({ deviceId: p.a.device.id });
    else if (loss === "lease session") {
      const other = await pairDevice(ctx.db, p.participant.id, NOW, [SHARED_CAPABILITY]);
      const [s] = await ctx.db
        .select()
        .from(fleetDeviceSession)
        .where(eq(fleetDeviceSession.deviceId, other.device.id));
      await ctx.db.update(fleetPublisherLease).set({ sessionId: s.id });
    }
    const rows = await ctx.db.select().from(fleetTelemetryRow);
    const leases = await ctx.db.select().from(fleetPublisherLease);
    expect(rows).toHaveLength(1);
    expect(leases).toHaveLength(1);
    if (!loss.startsWith("row ")) expect(rows).toEqual(originalRows);
    if (!loss.startsWith("lease ")) expect(leases).toEqual(originalLeases);
    const read = await readFleetProjection(ctx.db, {
      sessionId: p.a.sessionId,
      revision: 5,
      now: at(3000),
    });
    expect(read.ok ? read.rows : []).toEqual([]);
    expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual(rows);
    expect(await ctx.db.select().from(fleetPublisherLease)).toEqual(leases);
  },
);

it.each(["row", "lease"] as const)(
  "all five %s provenance fields are read-side authority, not just cleanup hints",
  async (target) => {
    const p = await admitted();
    const table = target === "row" ? fleetTelemetryRow : fleetPublisherLease;
    const [original] = await ctx.db.select().from(table);
    let revision = 5;
    for (const mutation of [
      { sourceId: randomUUID() },
      { sourceGeneration: 2 },
      { authorityGeneration: 2 },
      { linkEpoch: randomUUID() },
      { participationGeneration: 2 },
      { sourceId: null },
    ]) {
      await ctx.db.update(table).set(mutation);
      const now = at(3000 + 500 * (revision - 5));
      const read = await readFleetProjection(ctx.db, {
        sessionId: p.a.sessionId,
        revision: revision++,
        now,
      });
      expect(read).toMatchObject({ ok: true, rows: [] });
      await ctx.db.update(table).set(original);
    }
    const restored = await readFleetProjection(ctx.db, {
      sessionId: p.a.sessionId,
      revision,
      now: at(6500),
    });
    expect(restored.ok && restored.rows.map((r) => r.characterId)).toEqual([
      p.alts[0].id,
    ]);
  },
);

it("whole-batch invalidity and global lease conflict preserve prior rows, leases, revision and cadence; omissions and empty Off withdrawal work", async () => {
  const p = await admitted();
  const other = await participatingDevice(ctx.db, p.participant.id);
  const before = {
    rows: await ctx.db.select().from(fleetTelemetryRow),
    leases: await ctx.db.select().from(fleetPublisherLease),
    sessions: await ctx.db.select().from(fleetDeviceSession),
  };
  for (const [device, rows, code] of [
    [
      p.b,
      [
        { characterId: p.alts[1].id, dps: 2, ewar: [] },
        { characterId: p.alts[2].id, dps: 1, ewar: [] },
      ],
      "character_not_eligible",
    ],
    [p.b, [{ characterId: p.boss.id, dps: 1, ewar: [] }], "character_not_linked"],
    [
      other,
      [
        { characterId: p.alts[1].id, dps: 2, ewar: [] },
        { characterId: p.alts[0].id, dps: 1, ewar: [] },
      ],
      "lease_conflict",
    ],
  ] as const)
    expect(
      await replaceDeviceProjection(ctx.db, {
        sessionId: device.sessionId,
        revision: 4,
        now: at(3000),
        rows,
      }),
    ).toEqual({ ok: false, code });
  expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual(before.rows);
  expect(await ctx.db.select().from(fleetPublisherLease)).toEqual(before.leases);
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before.sessions);
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 4,
      now: at(3000),
      rows: [{ characterId: p.alts[1].id, dps: 0, ewar: [] }],
    }),
  ).toEqual({ ok: true });
  expect(
    (await ctx.db.select().from(fleetTelemetryRow)).map((r) => r.characterId),
  ).toEqual([p.alts[1].id]);
  expect(
    (
      await setFleetParticipation(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 5,
        now: at(3500),
        enabled: false,
        expectedGeneration: 1,
      })
    ).ok,
  ).toBe(true);
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 6,
      now: at(4000),
      rows: [],
    }),
  ).toEqual({ ok: true });
  expect(
    await readDeviceEligibility(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 7,
      now: at(4000),
    }),
  ).toEqual({
    ok: true,
    value: { state: "participation_off", participationGeneration: 2, characters: [] },
  });
  expect(
    (
      await readFleetProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 8,
        now: at(4500),
      })
    ).ok,
  ).toBe(false);
});

it.each([2999, 3000, 9999, 10000])(
  "original receive age %sms, independent of refreshed source evidence",
  async (ageMs) => {
    const p = await admitted();
    if (ageMs >= 4500) {
      p.source.setNow(7000);
      await p.source.run();
    }
    const read = await readFleetProjection(ctx.db, {
      sessionId: p.a.sessionId,
      revision: 5,
      now: at(2500 + ageMs),
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

it("initiator session and participation are not source lifetime; source-only setup never couples participant tokens", async () => {
  const p = await admitted();
  expect(
    (
      await setFleetParticipation(ctx.db, {
        sessionId: p.a.sessionId,
        revision: 5,
        now: at(3000),
        enabled: false,
        expectedGeneration: 1,
      })
    ).ok,
  ).toBe(true);
  await ctx.db
    .delete(fleetDeviceSession)
    .where(eq(fleetDeviceSession.deviceId, p.a.device.id));
  expect(
    await readDeviceEligibility(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 4,
      now: at(3500),
    }),
  ).toMatchObject({ ok: true, value: { state: "ready" } });
  expect(
    await readFleetProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 5,
      now: at(4000),
    }),
  ).toMatchObject({ ok: true, rows: [{ characterId: p.alts[0].id }] });
});

it("multi-fleet quiet receiver reads the flat union and withholds ambiguous IDs rather than choosing lowest fleet", async () => {
  const p = await sharedAccounts(ctx.db);
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 90000010,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const c = await participatingDevice(ctx.db, owner.id);
  await realSource(ctx.db, c, boss, 124, [boss.id, p.alts[1].id]);
  // alt1 exists in both proofs: not the lower fleet, not eligible at all.
  const ambiguous = await readDeviceEligibility(ctx.db, {
    sessionId: p.b.sessionId,
    revision: 3,
    now: at(2500),
  });
  expect(ambiguous.ok && ambiguous.value.characters.map((ch) => ch.characterId)).toEqual([
    p.alts[0].id,
  ]);
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 4,
      now: at(3000),
      rows: [{ characterId: p.alts[1].id, dps: 1, ewar: [] }],
    }),
  ).toEqual({ ok: false, code: "character_not_eligible" });
  p.source.setRosterIds([p.boss.id, p.alts[0].id]);
  p.source.setNow(7000);
  await p.source.run();
  for (const [device, id] of [
    [p.a, p.boss.id],
    [c, boss.id],
  ] as const)
    expect(
      await replaceDeviceProjection(ctx.db, {
        sessionId: device.sessionId,
        revision: 4,
        now: at(7500),
        rows: [{ characterId: id, dps: 1, ewar: [] }],
      }),
    ).toEqual({ ok: true });
  const union = await readFleetProjection(ctx.db, {
    sessionId: p.b.sessionId,
    revision: 4,
    now: at(7500),
  });
  expect(union.ok && union.rows.map((r) => r.characterId).sort()).toEqual([
    p.boss.id,
    boss.id,
  ]);
  expect(await ctx.db.select().from(fleetEligibility)).toEqual([]);
});

it.each(["key", "grant", "revoked", "tier"] as const)(
  "source initiator %s invalidates an otherwise valid independent publisher/receiver without cleanup",
  async (loss) => {
    const p = await admitted();
    if (loss === "key")
      await ctx.db
        .update(fleetDeviceKeyIdentity)
        .set({ deviceId: null, conflicted: true })
        .where(eq(fleetDeviceKeyIdentity.deviceId, p.a.device.id));
    else if (loss === "grant")
      await ctx.db
        .update(fleetDevice)
        .set({ approvedCapabilities: [] })
        .where(eq(fleetDevice.id, p.a.device.id));
    else if (loss === "revoked")
      await ctx.db
        .update(fleetDevice)
        .set({ revokedAt: at(3000) })
        .where(eq(fleetDevice.id, p.a.device.id));
    else
      await ctx.db
        .update(account)
        .set({ tier: "alumni" })
        .where(eq(account.id, p.owner.id));
    expect(await ctx.db.select().from(fleetTelemetryRow)).toHaveLength(1);
    expect(
      (
        await readFleetProjection(ctx.db, {
          sessionId: p.b.sessionId,
          revision: 4,
          now: at(3000),
        })
      ).ok,
    ).toBe(false);
    expect(await ctx.db.select().from(fleetTelemetryRow)).toHaveLength(1);
  },
);

it.each([{ capabilities: [] }, { capabilities: [SHARED_CAPABILITY] }])(
  "shared admission refuses legacy/unacknowledged sessions $capabilities without preventing setup",
  async ({ capabilities }) => {
    const p = await sharedAccounts(ctx.db);
    const fresh = await pairDevice(ctx.db, p.participant.id, NOW, capabilities);
    expect(
      (
        await readDeviceEligibility(ctx.db, {
          sessionId: fresh.sessionId,
          revision: 1,
          now: at(2500),
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await replaceDeviceProjection(ctx.db, {
          sessionId: fresh.sessionId,
          revision: 1,
          now: at(2500),
          rows: [],
        })
      ).ok,
    ).toBe(false);
  },
);

it("8192 plus sentinel ownership overflow refuses atomically rather than silently truncating eligible characters", async () => {
  const p = await admitted();
  await ctx.db.insert(character).values(
    Array.from({ length: 8193 }, (_, i) => ({
      id: 91000000 + i,
      accountId: p.participant.id,
      name: `overflow ${i}`,
      ownerHash: `overflow-${i}`,
      scopes: [],
      refreshTokenEnc: null,
      tokenStatus: "missing" as const,
    })),
  );
  const before = await ctx.db.select().from(fleetDeviceSession);
  expect(
    await readDeviceEligibility(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 4,
      now: at(3000),
    }),
  ).toEqual({ ok: false, code: "service_unavailable" });
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 4,
      now: at(3000),
      rows: [],
    }),
  ).toEqual({ ok: false, code: "service_unavailable" });
  expect(await ctx.db.select().from(fleetTelemetryRow)).toHaveLength(1);
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
});

it("read union exceeds both 32-row publication and 256-pair per-source bounds without truncation", async () => {
  const p = await sharedAccounts(ctx.db);
  const chars = await ctx.db
    .insert(character)
    .values(
      Array.from({ length: 260 }, (_, i) => ({
        id: 91000000 + i,
        accountId: p.participant.id,
        name: `participant ${i}`,
        ownerHash: `participant-${i}`,
        scopes: [],
        refreshTokenEnc: null,
        tokenStatus: "missing" as const,
      })),
    )
    .returning();
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 90000010,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const c = await participatingDevice(ctx.db, owner.id);
  await realSource(ctx.db, c, boss, 124, [
    boss.id,
    ...chars.slice(130).map((ch) => ch.id),
  ]);
  p.source.setRosterIds([p.boss.id, ...chars.slice(0, 130).map((ch) => ch.id)]);
  p.source.setNow(7000);
  await p.source.run();
  for (let i = 0; i < chars.length; i += 32) {
    const device = await participatingDevice(ctx.db, p.participant.id);
    expect(
      await replaceDeviceProjection(ctx.db, {
        sessionId: device.sessionId,
        revision: 3,
        now: at(7500),
        rows: chars
          .slice(i, i + 32)
          .map((ch) => ({ characterId: ch.id, dps: 10_000_000, ewar: [] })),
      }),
    ).toEqual({ ok: true });
  }
  const union = await readFleetProjection(ctx.db, {
    sessionId: p.b.sessionId,
    revision: 3,
    now: at(8000),
  });
  expect(union.ok && union.rows.length).toBe(260);
  expect(union.ok && new Set(union.rows.map((r) => r.characterId)).size).toBe(260);
}, 30000);

it("a real worker handover changes authority generations; old admitted provenance cannot resurrect under the new boss", async () => {
  const p = await admitted();
  const [oldRow] = await ctx.db.select().from(fleetTelemetryRow);
  const [oldLease] = await ctx.db.select().from(fleetPublisherLease);
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 90000010,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const c = await participatingDevice(ctx.db, owner.id);
  const next = await realSource(
    ctx.db,
    c,
    boss,
    123,
    [boss.id, p.boss.id, p.alts[0].id],
    3000,
  );
  expect((await ctx.db.select().from(fleetSourceAuthority))[0]).toMatchObject({
    sourceId: next.sourceId,
    authorityGeneration: 2,
  });
  expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual([]);
  expect(
    await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 4,
      now: at(3500),
      rows: [{ characterId: p.alts[0].id, dps: 88, ewar: [] }],
    }),
  ).toEqual({ ok: true });
  expect(
    await readFleetProjection(ctx.db, {
      sessionId: c.sessionId,
      revision: 4,
      now: at(3500),
    }),
  ).toMatchObject({ ok: true, rows: [{ dps: 88 }] });
  // Explicit negative ABA mutation: replay retained OLD admission, never positive proof.
  await ctx.db.update(fleetTelemetryRow).set(oldRow);
  await ctx.db.update(fleetPublisherLease).set(oldLease);
  expect(
    await readFleetProjection(ctx.db, {
      sessionId: c.sessionId,
      revision: 5,
      now: at(4000),
    }),
  ).toMatchObject({ ok: true, rows: [] });
});

it("ambiguity outside the receiver's initial fleet union withholds an already-admitted publisher row", async () => {
  const p = await admitted();
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const boss = await seedCharacter(ctx.db, testConfig(), {
    id: 90000010,
    accountId: owner.id,
    scopes: [FLEET_READ_SCOPE],
  });
  const c = await participatingDevice(ctx.db, owner.id);
  await realSource(ctx.db, c, boss, 124, [boss.id, p.alts[0].id], 3000);
  expect(
    await readFleetProjection(ctx.db, {
      sessionId: p.a.sessionId,
      revision: 5,
      now: at(3500),
    }),
  ).toMatchObject({ ok: true, rows: [] });
  expect(await ctx.db.select().from(fleetTelemetryRow)).toHaveLength(1);
});

it("a PostgreSQL-triggered serialization fault between lease and row writes rolls back replacement and cadence", async () => {
  const p = await admitted();
  const before = {
    rows: await ctx.db.select().from(fleetTelemetryRow),
    leases: await ctx.db.select().from(fleetPublisherLease),
    sessions: await ctx.db.select().from(fleetDeviceSession),
  };
  // Test DB only. PostgreSQL itself aborts the real transaction after the lease
  // write; this is not a mocked Db transaction or a synthetic driver rejection.
  await ctx.pool.query(
    "create function task5_refuse_relay() returns trigger language plpgsql as 'begin raise exception ''task5 refusal'' using errcode = ''40001''; end;'",
  );
  try {
    await ctx.pool.query(
      "create trigger task5_relay_fault before insert on fleet_telemetry_row for each row execute function task5_refuse_relay()",
    );
    const result = await replaceDeviceProjection(ctx.db, {
      sessionId: p.b.sessionId,
      revision: 4,
      now: at(3000),
      rows: [{ characterId: p.alts[1].id, dps: 88, ewar: [] }],
    });
    expect(result).toEqual({ ok: false, code: "try_again" });
  } finally {
    await ctx.pool.query(
      "drop trigger if exists task5_relay_fault on fleet_telemetry_row",
    );
    await ctx.pool.query("drop function task5_refuse_relay()");
  }
  expect(await ctx.db.select().from(fleetTelemetryRow)).toEqual(before.rows);
  expect(await ctx.db.select().from(fleetPublisherLease)).toEqual(before.leases);
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before.sessions);
});

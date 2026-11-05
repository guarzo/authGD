import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  fleetDevice,
  fleetDeviceSession,
  fleetPublisherLease,
  fleetTelemetryRow,
} from "@/db/schema";
import {
  renewFleetDeviceSession,
  revokeFleetDevice,
  revokeFleetRelayForAccount,
} from "@/services/fleet-pairing";
import {
  isRetryableRelayError,
  type PublishedRow,
  pruneExpiredFleetRelay,
  readFleetProjection,
  replaceDeviceProjection,
} from "@/services/fleet-relay";
import { setupTestDb, truncateAll } from "./helpers/db";
import { withInjectedPgFault } from "./helpers/pg-fault";
import { at, realSource } from "./helpers/fleet-shared-admission";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import {
  combatAccounts,
  combatDevice,
  combatRow as row,
  POINT,
} from "./helpers/fleet-combat";
import { waitUntilBlockedBy } from "./helpers/fleet-sharing";

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());
const SUCCESS = { ok: true, json: '{"protocol":2}' };
type Device = Awaited<ReturnType<typeof combatDevice>>;
// Envelope construction only: no authority or revision translation, and the
// original measurement is required independently of post-lock admission time.
function measured(
  device: Device,
  revision: number,
  sampledAt: Date,
  rows: readonly PublishedRow[],
  now = sampledAt,
) {
  return {
    sessionId: device.sessionId,
    revision,
    sampledAtMs: rows.length ? sampledAt.getTime() : 0,
    rows,
    now,
  };
}
async function rowFor(characterId: number) {
  return (
    await ctx.db
      .select()
      .from(fleetTelemetryRow)
      .where(eq(fleetTelemetryRow.characterId, characterId))
  )[0];
}
async function leaseFor(characterId: number) {
  return (
    await ctx.db
      .select()
      .from(fleetPublisherLease)
      .where(eq(fleetPublisherLease.characterId, characterId))
  )[0];
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
async function baseline() {
  const p = await combatAccounts(ctx.db);
  expect(
    await replaceDeviceProjection(
      ctx.db,
      measured(p.b, 3, at(2500), [row(p.alts[0].id, 100)]),
    ),
  ).toEqual(SUCCESS);
  expect(await rowFor(p.alts[0].id)).toMatchObject({
    outgoingDps: 100,
    deviceId: p.b.device.id,
  });
  return p;
}

describe("replaceDeviceProjection: sparse replacement and withdrawal", () => {
  it("writes rows for a valid batch, and a later non-empty batch that omits one deletes it immediately", async () => {
    const p = await combatAccounts(ctx.db);
    const alice = row(p.alts[0].id, 1000, POINT),
      bob = row(p.alts[1].id, 2000);
    expect(
      await replaceDeviceProjection(ctx.db, measured(p.b, 3, at(2500), [alice, bob])),
    ).toEqual(SUCCESS);
    expect(await rowFor(alice.characterId)).toBeDefined();
    expect(await rowFor(bob.characterId)).toBeDefined();
    expect(
      await replaceDeviceProjection(ctx.db, measured(p.b, 4, at(3100), [bob])),
    ).toEqual(SUCCESS);
    expect(await rowFor(alice.characterId)).toBeUndefined();
    expect(await leaseFor(alice.characterId)).toBeUndefined();
    expect(await rowFor(bob.characterId)).toMatchObject({
      outgoingDps: 2000,
      deviceId: p.b.device.id,
    });
  });
  it("withdraws every row on an empty batch", async () => {
    const p = await baseline();
    expect(await replaceDeviceProjection(ctx.db, measured(p.b, 4, at(3100), []))).toEqual(
      SUCCESS,
    );
    expect(await rowFor(p.alts[0].id)).toBeUndefined();
    expect(await leaseFor(p.alts[0].id)).toBeUndefined();
  });
});

describe("replaceDeviceProjection: batch validation", () => {
  it.each([
    "duplicate IDs",
    "unknown effect",
    "negative DPS",
    "excessive DPS",
    "33 rows",
    "int4 revision overflow",
  ])("rejects %s as a whole batch without mutation", async (bad) => {
    const p = await baseline();
    const before = await retained();
    let rows: PublishedRow[] = [row(p.alts[0].id, 200)];
    let revision = 4;
    if (bad === "duplicate IDs") rows.push(row(p.alts[0].id, 300));
    if (bad === "unknown effect")
      rows = [
        row(p.alts[0].id, 0, [
          { kind: "scram", observations: [{ name: null, ageMs: 0 }] },
        ] as unknown as PublishedRow["effects"]),
      ];
    if (bad === "negative DPS") rows = [row(p.alts[0].id, -1)];
    if (bad === "excessive DPS") rows = [row(p.alts[0].id, 10000001)];
    if (bad === "33 rows")
      rows = Array.from({ length: 33 }, (_, i) => row(95401000 + i, 0));
    if (bad === "int4 revision overflow") {
      revision = 2147483648;
      rows = [];
    }
    expect(
      await replaceDeviceProjection(ctx.db, measured(p.b, revision, at(3100), rows)),
    ).toEqual({ ok: false, code: "bad_request" });
    expect(await retained()).toEqual(before);
  });
});

describe("replaceDeviceProjection: identity and eligibility", () => {
  it("rejects a character linked to a DIFFERENT account than the device", async () => {
    const p = await combatAccounts(ctx.db);
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 3, at(2500), [row(p.boss.id, 100)]),
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(await rowFor(p.boss.id)).toBeUndefined();
  });
  it("rejects a linked character absent from current source proof", async () => {
    const p = await combatAccounts(ctx.db);
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 3, at(2500), [row(p.alts[2].id, 100)]),
      ),
    ).toEqual({ ok: false, code: "not_verified" });
    expect(await rowFor(p.alts[2].id)).toBeUndefined();
  });
  it("rejects the whole batch atomically when only one row is ineligible", async () => {
    const p = await baseline();
    const before = await retained();
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 4, at(3100), [row(p.alts[1].id, 100), row(p.alts[2].id, 200)]),
      ),
    ).toEqual({ ok: false, code: "not_verified" });
    expect(await rowFor(p.alts[1].id)).toBeUndefined();
    expect(await retained()).toEqual(before);
  });
});

describe("replaceDeviceProjection: lease conflicts", () => {
  it("rejects a character whose lease is currently held by a different device", async () => {
    const p = await baseline();
    const rival = await combatDevice(ctx.db, p.participant.id);
    const before = await retained();
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(rival, 3, at(3000), [row(p.alts[0].id, 200)]),
      ),
    ).toEqual({ ok: false, code: "conflict" });
    expect(await retained()).toEqual(before);
    expect((await rowFor(p.alts[0].id)).outgoingDps).toBe(100);
  });
  it("allows the SAME device to renew its own lease across fresh measurements", async () => {
    const p = await baseline();
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 4, at(3500), [row(p.alts[0].id, 150)]),
      ),
    ).toEqual(SUCCESS);
    expect((await rowFor(p.alts[0].id)).outgoingDps).toBe(150);
  });
  it("allows a different device to claim a character once the prior lease has expired", async () => {
    const p = await baseline();
    const rival = await combatDevice(ctx.db, p.participant.id);
    p.source.setNow(7000);
    await p.source.run();
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(rival, 3, at(12500), [row(p.alts[0].id, 999)]),
      ),
    ).toEqual(SUCCESS);
    expect(await rowFor(p.alts[0].id)).toMatchObject({
      outgoingDps: 999,
      deviceId: rival.device.id,
    });
  });
  it("does not delete a DIFFERENT device's takeover committed between the pre-lock probe and the relay lock", async () => {
    const p = await combatAccounts(ctx.db);
    const rival = await combatDevice(ctx.db, p.participant.id);
    const [x, y] = p.alts;
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 3, at(2500), [row(x.id, 100), row(y.id, 200)]),
      ),
    ).toEqual(SUCCESS);
    p.source.setNow(7000);
    await p.source.run();
    const rivalSession = createHash("sha256").update(rival.sessionId).digest("base64url");
    const client = await ctx.pool.connect();
    let withdrawal: ReturnType<typeof replaceDeviceProjection> | undefined;
    try {
      await client.query("begin");
      const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      await client.query("select pg_advisory_xact_lock(2, hashint8($1))", [x.id]);
      // Negative interleaving fixture: both devices have real disclosure/proof.
      // This uncommitted takeover preserves all provenance, not a fake grant.
      await client.query(
        "update fleet_publisher_lease set device_id=$1, session_id=$2, lease_expires_at=$3 where character_id=$4",
        [rival.device.id, rivalSession, at(17000), x.id],
      );
      await client.query(
        "update fleet_telemetry_row set device_id=$1, session_id=$2, outgoing_dps=999, sampled_at_ms=$3, activity_origin_ms=$3, publication_id=$4, received_at=$5, stale_at=$6, hard_expires_at=$7 where character_id=$8",
        [
          rival.device.id,
          rivalSession,
          at(12500).getTime(),
          randomUUID(),
          at(12500),
          at(15500),
          at(17000),
          x.id,
        ],
      );
      withdrawal = replaceDeviceProjection(
        ctx.db,
        measured(p.b, 4, at(12500), [row(y.id, 250)]),
      );
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      await client.query("commit");
      expect(await withdrawal).toEqual(SUCCESS);
      expect(await rowFor(x.id)).toMatchObject({
        deviceId: rival.device.id,
        outgoingDps: 999,
      });
      expect((await leaseFor(x.id)).deviceId).toBe(rival.device.id);
      expect((await rowFor(y.id)).outgoingDps).toBe(250);
    } finally {
      await client.query("rollback");
      client.release();
      await withdrawal;
    }
  });
});

describe("replaceDeviceProjection: revision and cadence", () => {
  it("rejects a replayed non-increasing revision without changing data", async () => {
    const p = await baseline();
    const before = await retained();
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 3, at(3100), [row(p.alts[0].id, 999)]),
      ),
    ).toEqual({ ok: false, code: "revision_replayed" });
    expect(await retained()).toEqual(before);
  });
  it("accepts a lost-response retry that jumps to a higher non-contiguous revision", async () => {
    const p = await baseline();
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 5, at(3100), [row(p.alts[0].id, 200)]),
      ),
    ).toEqual(SUCCESS);
    expect((await rowFor(p.alts[0].id)).outgoingDps).toBe(200);
  });
  it("enforces the minimum publish interval and does not consume a rejected revision", async () => {
    const p = await baseline();
    const before = await retained();
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 4, at(2600), [row(p.alts[0].id, 200)]),
      ),
    ).toEqual({ ok: false, code: "rate_limited" });
    expect(await retained()).toEqual(before);
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 4, at(3100), [row(p.alts[0].id, 200)]),
      ),
    ).toEqual(SUCCESS);
    expect((await rowFor(p.alts[0].id)).outgoingDps).toBe(200);
  });
});

describe("replaceDeviceProjection: session validity", () => {
  it("rejects an unknown session id", async () => {
    await combatAccounts(ctx.db);
    expect(
      await replaceDeviceProjection(ctx.db, {
        sessionId: "not-a-real-session-id",
        revision: 1,
        sampledAtMs: 0,
        rows: [],
        now: at(2500),
      }),
    ).toEqual({ ok: false, code: "forbidden" });
  });
  it("rejects an expired session even for withdrawal", async () => {
    const p = await baseline();
    const before = await retained();
    expect(
      await replaceDeviceProjection(ctx.db, measured(p.b, 4, at(31 * 60000), [])),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(await retained()).toEqual(before);
  });
  it("a device revoked mid-lifecycle can no longer publish or restore its old projection", async () => {
    const p = await baseline();
    await revokeFleetDevice(ctx.db, p.b.device.id, p.participant.id, at(3000));
    expect(await rowFor(p.alts[0].id)).toBeUndefined();
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 4, at(3500), [row(p.alts[0].id, 999)]),
      ),
    ).toEqual({ ok: false, code: "forbidden" });
    expect(await rowFor(p.alts[0].id)).toBeUndefined();
  });
});

describe("readFleetProjection: liveness", () => {
  it("is live at 2999ms and stale at exactly 3000ms using independent reader sessions", async () => {
    const p = await baseline();
    const reader1 = await combatDevice(ctx.db, p.participant.id),
      reader2 = await combatDevice(ctx.db, p.participant.id);
    const live = await readFleetProjection(ctx.db, {
      sessionId: reader1.sessionId,
      revision: 3,
      now: at(5499),
    });
    expect(live).toMatchObject({
      ok: true,
      rows: [{ characterId: p.alts[0].id, ageMs: 2999, state: "live" }],
    });
    const stale = await readFleetProjection(ctx.db, {
      sessionId: reader2.sessionId,
      revision: 3,
      now: at(5500),
    });
    expect(stale).toMatchObject({
      ok: true,
      rows: [{ characterId: p.alts[0].id, ageMs: 3000, state: "stale" }],
    });
  });
  it("is absent at exactly 10000ms while independently refreshed source proof remains valid", async () => {
    const p = await combatAccounts(ctx.db);
    // Source expiry and original sample expiry coincide; neither masks the
    // transport boundary before proof renewal extends authority independently.
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 3, at(2000), [row(p.alts[0].id, 500)]),
      ),
    ).toEqual(SUCCESS);
    p.source.setNow(7000);
    await p.source.run();
    const gone = await readFleetProjection(ctx.db, {
      sessionId: p.a.sessionId,
      revision: 4,
      now: at(12000),
    });
    expect(gone).toMatchObject({ ok: true, rows: [] });
  });
});

describe("readFleetProjection: filtered read", () => {
  it("returns only the receiver's own eligible fleets, joined names and no fleet id", async () => {
    const p = await baseline();
    const result = await readFleetProjection(ctx.db, {
      sessionId: p.a.sessionId,
      revision: 4,
      now: at(3500),
    });
    if (!result.ok) throw new Error(result.code);
    expect(result.rows).toEqual([
      {
        publicationId: (await rowFor(p.alts[0].id)).publicationId,
        characterId: p.alts[0].id,
        characterName: p.alts[0].name,
        outgoingDps: 100,
        incomingDps: null,
        effects: [],
        activityAgeMs: 1000,
        ageMs: 1000,
        state: "live",
      },
    ]);
    expect(result.rows[0]).not.toHaveProperty("fleetId");
    // A real independent fleet, not a fabricated receiver eligibility cache.
    const owner = await seedAccount(ctx.db, { tier: "member" });
    const boss = await seedCharacter(ctx.db, testConfig(), {
      id: 90000100,
      accountId: owner.id,
      scopes: [FLEET_READ_SCOPE],
    });
    const outsider = await combatDevice(ctx.db, owner.id);
    await realSource(ctx.db, outsider, boss, 456, [boss.id]);
    expect(
      await readFleetProjection(ctx.db, {
        sessionId: outsider.sessionId,
        revision: 4,
        now: at(3500),
      }),
    ).toMatchObject({ ok: true, rows: [] });
  });
  it("includes the requester's own published row without self-exclusion", async () => {
    const p = await baseline();
    expect(
      await readFleetProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 4,
        now: at(3500),
      }),
    ).toMatchObject({ ok: true, rows: [{ characterId: p.alts[0].id }] });
  });
});

describe("readFleetProjection: session validity and cadence", () => {
  it("uses the same forbidden code for an unknown session and a non-eligible account", async () => {
    await combatAccounts(ctx.db);
    expect(
      await readFleetProjection(ctx.db, {
        sessionId: "not-a-real-session-id",
        revision: 1,
        now: at(2500),
      }),
    ).toEqual({ ok: false, code: "forbidden" });
    const owner = await seedAccount(ctx.db, { tier: "member" });
    const empty = await combatDevice(ctx.db, owner.id);
    expect(
      await readFleetProjection(ctx.db, {
        sessionId: empty.sessionId,
        revision: 3,
        now: at(2500),
      }),
    ).toEqual({ ok: false, code: "forbidden" });
  });
  it("read cadence rejects without consuming revision so a later retry reuses it", async () => {
    const p = await baseline();
    expect(
      (
        await readFleetProjection(ctx.db, {
          sessionId: p.a.sessionId,
          revision: 4,
          now: at(2500),
        })
      ).ok,
    ).toBe(true);
    const before = await retained();
    expect(
      await readFleetProjection(ctx.db, {
        sessionId: p.a.sessionId,
        revision: 5,
        now: at(2600),
      }),
    ).toEqual({ ok: false, code: "rate_limited" });
    expect(await retained()).toEqual(before);
    expect(
      (
        await readFleetProjection(ctx.db, {
          sessionId: p.a.sessionId,
          revision: 5,
          now: at(3100),
        })
      ).ok,
    ).toBe(true);
  });
  it("a prior PUT consumes the SAME monotonic counter checked by GET", async () => {
    const p = await baseline();
    const before = await retained();
    expect(
      await readFleetProjection(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 3,
        now: at(3100),
      }),
    ).toEqual({ ok: false, code: "revision_replayed" });
    expect(await retained()).toEqual(before);
    expect(
      (
        await readFleetProjection(ctx.db, {
          sessionId: p.b.sessionId,
          revision: 4,
          now: at(3100),
        })
      ).ok,
    ).toBe(true);
  });
});

it("pruneExpiredFleetRelay removes hard-expired rows and leases even with no reader", async () => {
  const p = await baseline();
  expect(await rowFor(p.alts[0].id)).toBeDefined();
  expect(await leaseFor(p.alts[0].id)).toBeDefined();
  await pruneExpiredFleetRelay(ctx.db, at(12500));
  expect(await rowFor(p.alts[0].id)).toBeUndefined();
  expect(await leaseFor(p.alts[0].id)).toBeUndefined();
});
it("revoking a device removes current telemetry, leases and sessions immediately", async () => {
  const p = await baseline();
  await revokeFleetDevice(ctx.db, p.b.device.id, p.participant.id, at(3000));
  expect(await rowFor(p.alts[0].id)).toBeUndefined();
  expect(await leaseFor(p.alts[0].id)).toBeUndefined();
  expect(
    await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, p.b.device.id)),
  ).toEqual([]);
});

describe("cross-module lock order", () => {
  it("rechecks session expiry after a relay-character lock wait before any write", async () => {
    const p = await combatAccounts(ctx.db);
    await ctx.db
      .update(fleetDeviceSession)
      .set({ expiresAt: at(3500) })
      .where(eq(fleetDeviceSession.deviceId, p.b.device.id));
    const before = await retained();
    const client = await ctx.pool.connect();
    let pending: ReturnType<typeof replaceDeviceProjection> | undefined;
    let now = at(3000);
    try {
      await client.query("begin");
      const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      await client.query("select pg_advisory_xact_lock(2, hashint8($1))", [p.alts[0].id]);
      pending = replaceDeviceProjection(ctx.db, {
        ...measured(p.b, 3, at(3000), [row(p.alts[0].id, 123)]),
        get now() {
          return now;
        },
      });
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      now = at(3500);
      await client.query("commit");
      expect(await pending).toEqual({ ok: false, code: "forbidden" });
      expect(await retained()).toEqual(before);
      expect(await rowFor(p.alts[0].id)).toBeUndefined();
      expect(await leaseFor(p.alts[0].id)).toBeUndefined();
    } finally {
      await client.query("rollback");
      client.release();
      await pending;
    }
  });
  it("publish blocks without deadlock behind an already-held device lock", async () => {
    const p = await combatAccounts(ctx.db);
    const client = await ctx.pool.connect();
    let pending: ReturnType<typeof replaceDeviceProjection> | undefined;
    try {
      await client.query("begin");
      const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      await client.query("select id from fleet_device where id=$1 for update", [
        p.b.device.id,
      ]);
      pending = replaceDeviceProjection(
        ctx.db,
        measured(p.b, 3, at(2500), [row(p.alts[0].id, 100)]),
      );
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      await client.query("commit");
      expect(await pending).toEqual(SUCCESS);
    } finally {
      await client.query("rollback");
      client.release();
      await pending;
    }
  });
  it("account revocation locks the global ascending UNION rather than a per-device ascending order", async () => {
    const p = await combatAccounts(ctx.db);
    const rival = await combatDevice(ctx.db, p.participant.id);
    const ordered = await ctx.db
      .select()
      .from(fleetDevice)
      .where(
        and(eq(fleetDevice.accountId, p.participant.id), isNull(fleetDevice.revokedAt)),
      )
      .orderBy(fleetDevice.id);
    expect(ordered).toHaveLength(2);
    const devices = new Map([p.b, rival].map((d) => [d.device.id, d]));
    const high = p.alts[1].id,
      low = p.alts[0].id;
    // Match the real current device ordering, but give its first device HIGH.
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(devices.get(ordered[0].id)!, 3, at(2500), [row(high, 100)]),
      ),
    ).toEqual(SUCCESS);
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(devices.get(ordered[1].id)!, 3, at(2500), [row(low, 100)]),
      ),
    ).toEqual(SUCCESS);
    const client = await ctx.pool.connect();
    let pending: Promise<void> | undefined;
    try {
      await client.query("begin");
      const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0].pid;
      await client.query("select pg_advisory_xact_lock(2, hashint8($1))", [low]);
      pending = revokeFleetRelayForAccount(ctx.db, p.participant.id, at(3000));
      expect(await waitUntilBlockedBy(ctx.pool, pid)).toBe(true);
      // Wrong HIGH-then-LOW acquisition creates an actual AB-BA deadlock here.
      await client.query("select pg_advisory_xact_lock(2, hashint8($1))", [high]);
      await client.query("commit");
      await expect(pending).resolves.toBeUndefined();
    } finally {
      await client.query("rollback");
      client.release();
      await pending;
    }
    const after = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, p.participant.id));
    expect(after).toHaveLength(2);
    for (const d of after) expect(d.revokedAt).toEqual(at(3000));
    for (const id of [low, high]) {
      expect(await leaseFor(id)).toBeUndefined();
      expect(await rowFor(id)).toBeUndefined();
    }
  });
});

describe("protocol contract: revision is shared across signed request kinds", () => {
  it("renewal's revision blocks a subsequent publish at the identical revision", async () => {
    const p = await combatAccounts(ctx.db);
    expect(
      (
        await renewFleetDeviceSession(ctx.db, {
          sessionId: p.b.sessionId,
          revision: 3,
          now: at(2500),
        })
      ).ok,
    ).toBe(true);
    const before = await retained();
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 3, at(3100), [row(p.alts[0].id, 100)]),
      ),
    ).toEqual({ ok: false, code: "revision_replayed" });
    expect(await retained()).toEqual(before);
  });
  it("a lower revision is refused after a higher revision commits first, regardless of send order", async () => {
    const p = await combatAccounts(ctx.db);
    expect(
      await replaceDeviceProjection(
        ctx.db,
        measured(p.b, 4, at(2500), [row(p.alts[0].id, 100)]),
      ),
    ).toEqual(SUCCESS);
    const before = await retained();
    expect(
      await renewFleetDeviceSession(ctx.db, {
        sessionId: p.b.sessionId,
        revision: 3,
        now: at(3100),
      }),
    ).toEqual({ ok: false, code: "revision_replayed" });
    expect(await retained()).toEqual(before);
  });
});
describe("isRetryableRelayError", () => {
  it("recognizes Postgres deadlock and serialization-failure SQLSTATEs", () => {
    expect(isRetryableRelayError({ code: "40P01" })).toBe(true);
    expect(isRetryableRelayError({ code: "40001" })).toBe(true);
  });
  it("rejects unrelated codes, missing code and non-errors", () => {
    for (const value of [
      { code: "23505" },
      new Error("plain error"),
      null,
      "40P01",
      { code: 40001 },
    ])
      expect(isRetryableRelayError(value)).toBe(false);
  });
});
it("a retryable database failure returns closed service_unavailable instead of throwing or mutating", async () => {
  const p = await combatAccounts(ctx.db);
  const before = await retained();
  expect(
    await withInjectedPgFault(ctx.pool, { matchSql: /^\s*select/i, code: "40P01" }, () =>
      replaceDeviceProjection(
        ctx.db,
        measured(p.b, 3, at(2500), [row(p.alts[0].id, 100)]),
      ),
    ),
  ).toEqual({ ok: false, code: "service_unavailable" });
  expect(await retained()).toEqual(before);
});

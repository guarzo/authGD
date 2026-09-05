import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import {
  fleetDevice,
  fleetDeviceSession,
  fleetEligibility,
  fleetPublisherLease,
  fleetTelemetryRow,
} from "@/db/schema";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { canonicalDevicePublicKeyB64 } from "@/lib/fleet-signature";
import {
  approvePairing,
  beginPairing,
  completePairing,
  pairingChallengePreimage,
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
import { testConfig } from "./helpers/config";
import { setupTestDb } from "./helpers/db";
import { withInjectedPgFault } from "./helpers/pg-fault";
import { seedAccount, seedCharacter } from "./helpers/seed";

const cfg = testConfig();
const NOW = new Date("2026-09-04T12:00:00.000Z");

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

/** Runs the real pairing lifecycle (begin -> approve -> complete) so tests
 * exercise `replaceDeviceProjection`/`readFleetProjection` against a genuine
 * hashed device session, exactly as Task 6's routes would produce one --
 * never hand-crafting a session id or reimplementing its hash. */
async function pairDevice(db: Db, accountId: string, now: Date) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const { pairingId } = await beginPairing(db, { publicKeySpki: spki, now });
  await approvePairing(db, pairingId, accountId, now);
  const completionSignature = ed25519Sign(
    null,
    pairingChallengePreimage(pairingId),
    privateKey,
  ).toString("base64url");
  const { sessionId } = await completePairing(db, {
    pairingId,
    completionSignature,
    now,
  });
  const [device] = await db
    .select()
    .from(fleetDevice)
    .where(eq(fleetDevice.publicKeySpkiB64, canonicalDevicePublicKeyB64(spki)));
  return { sessionId, device };
}

/** Seeds a linked, Fleet-Read-scoped character plus its materialized,
 * unexpired `fleet_eligibility` row for one fleet -- the only way
 * `readEligibleAccount` (Task 4) ever grants relay eligibility. */
async function seedEligibleCharacter(
  db: Db,
  opts: {
    characterId: number;
    accountId: string;
    fleetId: number;
    rosterCharacterIds?: number[];
    now: Date;
    expiresAt?: Date;
    characterName?: string;
  },
) {
  await seedCharacter(db, cfg, {
    id: opts.characterId,
    accountId: opts.accountId,
    name: opts.characterName,
    scopes: [FLEET_READ_SCOPE],
  });
  await db.insert(fleetEligibility).values({
    characterId: opts.characterId,
    accountId: opts.accountId,
    fleetId: opts.fleetId,
    rosterCharacterIds: opts.rosterCharacterIds ?? [opts.characterId],
    verifiedAt: opts.now,
    expiresAt: opts.expiresAt ?? new Date(opts.now.getTime() + 60_000),
    outcomeCode: "ok",
  });
}

async function rowFor(db: Db, characterId: number) {
  const [row] = await db
    .select()
    .from(fleetTelemetryRow)
    .where(eq(fleetTelemetryRow.characterId, characterId));
  return row;
}

async function leaseFor(db: Db, characterId: number) {
  const [row] = await db
    .select()
    .from(fleetPublisherLease)
    .where(eq(fleetPublisherLease.characterId, characterId));
  return row;
}

function row(
  characterId: number,
  dps: number,
  ewar: PublishedRow["ewar"] = [],
): PublishedRow {
  return { characterId, dps, ewar };
}

describe("replaceDeviceProjection: sparse replacement and withdrawal", () => {
  it("writes rows for a valid batch, and a later non-empty batch that omits one deletes it immediately", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, device } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400001,
      accountId: acc.id,
      fleetId: 6100001,
      rosterCharacterIds: [95400001, 95400002],
      now: NOW,
    });
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400002,
      accountId: acc.id,
      fleetId: 6100001,
      rosterCharacterIds: [95400001, 95400002],
      now: NOW,
    });

    const common = { sessionId, now: NOW };
    const alice = row(95400001, 1000, ["SCRAM/POINT"]);
    const bob = row(95400002, 2000);

    const first = await replaceDeviceProjection(ctx.db, {
      ...common,
      rows: [alice, bob],
      revision: 1,
    });
    expect(first).toEqual({ ok: true });
    expect(await rowFor(ctx.db, 95400001)).toBeDefined();
    expect(await rowFor(ctx.db, 95400002)).toBeDefined();

    const second = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: new Date(NOW.getTime() + 600),
      rows: [bob],
      revision: 2,
    });
    expect(second).toEqual({ ok: true });
    expect(await rowFor(ctx.db, 95400001)).toBeUndefined();
    expect(await leaseFor(ctx.db, 95400001)).toBeUndefined();
    const bobRow = await rowFor(ctx.db, 95400002);
    expect(bobRow?.dps).toBe(2000);
    expect(bobRow?.deviceId).toBe(device.id);
  });

  it("withdraws every row on an empty batch", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400010,
      accountId: acc.id,
      fleetId: 6100002,
      now: NOW,
    });

    await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400010, 500)],
    });
    expect(await rowFor(ctx.db, 95400010)).toBeDefined();

    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: new Date(NOW.getTime() + 600),
      revision: 2,
      rows: [],
    });
    expect(result).toEqual({ ok: true });
    expect(await rowFor(ctx.db, 95400010)).toBeUndefined();
    expect(await leaseFor(ctx.db, 95400010)).toBeUndefined();
  });
});

describe("replaceDeviceProjection: batch validation", () => {
  it("rejects duplicate character ids within one body", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);

    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400100, 100), row(95400100, 200)],
    });
    expect(result).toEqual({ ok: false, code: "invalid_batch" });
  });

  it("rejects an EWAR value other than the exact SCRAM/POINT literal", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);

    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [
        { characterId: 95400101, dps: 0, ewar: ["scram"] } as unknown as PublishedRow,
      ],
    });
    expect(result).toEqual({ ok: false, code: "invalid_batch" });
  });

  it("rejects a negative DPS value", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);

    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400102, -1)],
    });
    expect(result).toEqual({ ok: false, code: "invalid_batch" });
  });

  it("rejects a DPS value above the maximum", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);

    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400103, 10_000_001)],
    });
    expect(result).toEqual({ ok: false, code: "invalid_batch" });
  });

  it("rejects a batch exceeding the maximum row count", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);

    const rows = Array.from({ length: 33 }, (_, i) => row(95401000 + i, 0));
    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows,
    });
    expect(result).toEqual({ ok: false, code: "invalid_batch" });
  });

  it("rejects a revision above the Postgres int4 bound", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);

    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 2_147_483_648,
      rows: [],
    });
    expect(result).toEqual({ ok: false, code: "invalid_batch" });
  });
});

describe("replaceDeviceProjection: identity and eligibility", () => {
  it("rejects a character with no linked catalogue character on this device's account", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const other = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    // Character exists, but is linked to a DIFFERENT account than the device.
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400200,
      accountId: other.id,
      fleetId: 6100010,
      now: NOW,
    });

    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400200, 100)],
    });
    expect(result).toEqual({ ok: false, code: "character_not_linked" });
    expect(await rowFor(ctx.db, 95400200)).toBeUndefined();
  });

  it("rejects a character absent from every eligible roster", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    // Linked to this account, but with no fleet_eligibility row at all.
    await seedCharacter(ctx.db, cfg, { id: 95400201, accountId: acc.id });

    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400201, 100)],
    });
    expect(result).toEqual({ ok: false, code: "character_not_eligible" });
    expect(await rowFor(ctx.db, 95400201)).toBeUndefined();
  });

  it("rejects the whole batch atomically when only one row is invalid", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400210,
      accountId: acc.id,
      fleetId: 6100011,
      now: NOW,
    });
    await seedCharacter(ctx.db, cfg, { id: 95400211, accountId: acc.id }); // not eligible

    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400210, 100), row(95400211, 200)],
    });
    expect(result).toEqual({ ok: false, code: "character_not_eligible" });
    // The valid row must NOT have been written either -- one refusal, no
    // partial mutation.
    expect(await rowFor(ctx.db, 95400210)).toBeUndefined();
  });
});

describe("replaceDeviceProjection: lease conflicts", () => {
  it("rejects a character whose lease is currently held by a different device", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId: sessionA } = await pairDevice(ctx.db, acc.id, NOW);
    const { sessionId: sessionB } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400300,
      accountId: acc.id,
      fleetId: 6100020,
      now: NOW,
    });

    const claimed = await replaceDeviceProjection(ctx.db, {
      sessionId: sessionA,
      now: NOW,
      revision: 1,
      rows: [row(95400300, 100)],
    });
    expect(claimed).toEqual({ ok: true });

    const conflict = await replaceDeviceProjection(ctx.db, {
      sessionId: sessionB,
      now: NOW,
      revision: 1,
      rows: [row(95400300, 200)],
    });
    expect(conflict).toEqual({ ok: false, code: "lease_conflict" });
    // The original device's row/lease are untouched by the refused attempt.
    expect((await rowFor(ctx.db, 95400300))?.dps).toBe(100);
  });

  it("allows the SAME device to renew its own lease across publishes", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400301,
      accountId: acc.id,
      fleetId: 6100021,
      now: NOW,
    });

    await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400301, 100)],
    });
    const second = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: new Date(NOW.getTime() + 1_000),
      revision: 2,
      rows: [row(95400301, 150)],
    });
    expect(second).toEqual({ ok: true });
    expect((await rowFor(ctx.db, 95400301))?.dps).toBe(150);
  });

  it("allows a different device to claim a character once the prior lease has expired", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId: sessionA } = await pairDevice(ctx.db, acc.id, NOW);
    const { sessionId: sessionB } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400302,
      accountId: acc.id,
      fleetId: 6100022,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

    await replaceDeviceProjection(ctx.db, {
      sessionId: sessionA,
      now: NOW,
      revision: 1,
      rows: [row(95400302, 100)],
    });

    const wellPastHardExpiry = new Date(NOW.getTime() + 11_000);
    const result = await replaceDeviceProjection(ctx.db, {
      sessionId: sessionB,
      now: wellPastHardExpiry,
      revision: 1,
      rows: [row(95400302, 999)],
    });
    expect(result).toEqual({ ok: true });
    expect((await rowFor(ctx.db, 95400302))?.dps).toBe(999);
  });

  it("does not delete a withdrawn character's row/lease if a DIFFERENT device's takeover lands between the pre-lock read and the lock (regression, fix round 1 finding M1)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId: sessionA } = await pairDevice(ctx.db, acc.id, NOW);
    const { device: deviceB } = await pairDevice(ctx.db, acc.id, NOW);
    // X (95400320) is the character fought over; Y (95400321) is a second
    // character A keeps publishing, chosen with a HIGHER id than X so the
    // deterministic ascending lock order locks X first — exactly where A's
    // call will block on B's held advisory lock below.
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400320,
      accountId: acc.id,
      fleetId: 6100023,
      rosterCharacterIds: [95400320, 95400321],
      now: NOW,
    });
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400321,
      accountId: acc.id,
      fleetId: 6100023,
      rosterCharacterIds: [95400320, 95400321],
      now: NOW,
    });

    // Device A initially claims both X and Y.
    const initial = await replaceDeviceProjection(ctx.db, {
      sessionId: sessionA,
      now: NOW,
      revision: 1,
      rows: [row(95400320, 100), row(95400321, 200)],
    });
    expect(initial).toEqual({ ok: true });

    const [sessionRowB] = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, deviceB.id));

    const takeoverNow = new Date(NOW.getTime() + 11_000); // past X's 10s hard expiry

    // Simulate device B's in-flight, NOT YET COMMITTED takeover of X (its
    // lease has expired by `takeoverNow`) on a raw connection held open
    // deliberately — the same advisory lock class/key `lockCharacterForRelay`
    // uses, so A's own call below genuinely blocks on it rather than merely
    // approximating the race.
    const client = await ctx.pool.connect();
    let withdrawal: ReturnType<typeof replaceDeviceProjection> | undefined;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(2, hashint8($1))", [95400320]);
      await client.query(
        `update fleet_publisher_lease set device_id = $1, session_id = $2, lease_expires_at = $3 where character_id = $4`,
        [deviceB.id, sessionRowB.id, new Date(takeoverNow.getTime() + 10_000), 95400320],
      );
      await client.query(
        `update fleet_telemetry_row set device_id = $1, session_id = $2, dps = $3, received_at = $4, stale_at = $5, hard_expires_at = $6 where character_id = $7`,
        [
          deviceB.id,
          sessionRowB.id,
          999,
          takeoverNow,
          new Date(takeoverNow.getTime() + 3_000),
          new Date(takeoverNow.getTime() + 10_000),
          95400320,
        ],
      );
      // Deliberately NOT committed yet: A's pre-lock `existingLeases` read
      // below must still see the OLD (device A) row, exactly as it would in
      // the real race, since B's change stays invisible to any OTHER
      // transaction under read-committed isolation until this commits.

      // Device A publishes again, resubmitting Y but omitting X (withdrawing
      // it). X sorts first in ascending lock order, so this call's lock loop
      // blocks on the advisory lock B is holding above — it cannot proceed
      // past that point until B's transaction below commits.
      withdrawal = replaceDeviceProjection(ctx.db, {
        sessionId: sessionA,
        now: takeoverNow,
        revision: 2,
        rows: [row(95400321, 250)],
      });

      // Confirm A's call is ACTUALLY blocked on a lock before releasing B's
      // transaction — a self-verifying guard against a silently-degenerate
      // race (one that never truly interleaved and so would prove nothing).
      let blocked = false;
      for (let i = 0; i < 50; i++) {
        const { rows: waiters } = await ctx.pool.query(
          "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'",
        );
        if ((waiters[0] as { n: number }).n > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);

      await client.query("commit");
    } finally {
      // Always attempt to end the transaction here, even if the assertion
      // above failed: otherwise the advisory lock stays held and A's
      // `withdrawal` call above never settles, hanging this test (and,
      // since it shares the connection pool, potentially the suite after
      // it) instead of failing cleanly.
      await client.query("commit").catch(() => client.query("rollback").catch(() => {}));
      client.release();
    }

    const result = await withdrawal;
    expect(result).toEqual({ ok: true });

    // B's takeover must survive untouched — A's withdrawal must NOT have
    // deleted the row/lease that now belongs to a different device.
    const xRow = await rowFor(ctx.db, 95400320);
    expect(xRow?.deviceId).toBe(deviceB.id);
    expect(xRow?.dps).toBe(999);
    const xLease = await leaseFor(ctx.db, 95400320);
    expect(xLease?.deviceId).toBe(deviceB.id);

    // Y, meanwhile, was correctly updated by A's own request.
    expect((await rowFor(ctx.db, 95400321))?.dps).toBe(250);
  });
});

describe("replaceDeviceProjection: revision and cadence", () => {
  it("rejects a replayed (non-increasing) revision", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400400,
      accountId: acc.id,
      fleetId: 6100030,
      now: NOW,
    });

    await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400400, 100)],
    });
    const replay = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: new Date(NOW.getTime() + 600),
      revision: 1,
      rows: [row(95400400, 999)],
    });
    expect(replay).toEqual({ ok: false, code: "revision_replayed" });
    expect((await rowFor(ctx.db, 95400400))?.dps).toBe(100);
  });

  it("accepts a lost-response retry that jumps to a higher, non-contiguous revision", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400401,
      accountId: acc.id,
      fleetId: 6100031,
      now: NOW,
    });

    await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400401, 100)],
    });
    // Revision 2's response was "lost"; the device retries at revision 3.
    const retry = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: new Date(NOW.getTime() + 600),
      revision: 3,
      rows: [row(95400401, 200)],
    });
    expect(retry).toEqual({ ok: true });
    expect((await rowFor(ctx.db, 95400401))?.dps).toBe(200);
  });

  it("enforces the minimum publish interval, then accepts once it has elapsed", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400402,
      accountId: acc.id,
      fleetId: 6100032,
      now: NOW,
    });

    await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400402, 100)],
    });
    const tooSoon = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: new Date(NOW.getTime() + 100),
      revision: 2,
      rows: [row(95400402, 200)],
    });
    expect(tooSoon).toEqual({ ok: false, code: "rate_limited" });
    // Rejected cadence attempt did not consume the revision.
    expect((await rowFor(ctx.db, 95400402))?.dps).toBe(100);

    const retry = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: new Date(NOW.getTime() + 600),
      revision: 2,
      rows: [row(95400402, 200)],
    });
    expect(retry).toEqual({ ok: true });
    expect((await rowFor(ctx.db, 95400402))?.dps).toBe(200);
  });
});

describe("replaceDeviceProjection: session validity", () => {
  it("rejects an unknown session id", async () => {
    const result = await replaceDeviceProjection(ctx.db, {
      sessionId: "not-a-real-session-id",
      now: NOW,
      revision: 1,
      rows: [],
    });
    expect(result).toEqual({ ok: false, code: "invalid_session" });
  });

  it("rejects an expired session", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    const wellPastExpiry = new Date(NOW.getTime() + 31 * 60 * 1000); // 30-minute TTL

    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: wellPastExpiry,
      revision: 1,
      rows: [],
    });
    expect(result).toEqual({ ok: false, code: "invalid_session" });
  });

  it("a device revoked mid-lifecycle can no longer publish, and its old signed session cannot restore state", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, device } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95400500,
      accountId: acc.id,
      fleetId: 6100040,
      now: NOW,
    });

    await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95400500, 100)],
    });
    expect(await rowFor(ctx.db, 95400500)).toBeDefined();

    await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);
    expect(await rowFor(ctx.db, 95400500)).toBeUndefined();

    const result = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: new Date(NOW.getTime() + 1_000),
      revision: 2,
      rows: [row(95400500, 999)],
    });
    expect(result).toEqual({ ok: false, code: "invalid_session" });
    expect(await rowFor(ctx.db, 95400500)).toBeUndefined();
  });
});

describe("readFleetProjection: liveness", () => {
  it("is live at 2,999ms and stale at exactly 3,000ms (each boundary read via its own reader session, so the 500ms read cadence cannot mask the real transition)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId: publisherSession } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500001,
      accountId: acc.id,
      fleetId: 6200001,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    await replaceDeviceProjection(ctx.db, {
      sessionId: publisherSession,
      now: NOW,
      revision: 1,
      rows: [row(95500001, 500, ["SCRAM/POINT"])],
    });

    // A read at 2,999ms and a read at 3,000ms are only 1ms apart -- reusing
    // one reader session for both would make the second read fail the
    // 500ms cadence check (`rate_limited`) instead of ever reaching the
    // liveness computation, silently "proving" the 3,000ms boundary without
    // actually exercising it (fix round 1, finding M2). A fresh, already-
    // paired reader session per read has no prior `lastReadAt` at all, so
    // cadence never applies to either read below.
    const { sessionId: readerAtLive } = await pairDevice(ctx.db, acc.id, NOW);
    const almostStale = await readFleetProjection(ctx.db, {
      sessionId: readerAtLive,
      revision: 1,
      now: new Date(NOW.getTime() + 2_999),
    });
    expect(almostStale.ok).toBe(true);
    if (!almostStale.ok) throw new Error("unreachable");
    expect(almostStale.rows.find((r) => r.characterId === 95500001)?.state).toBe("live");

    const { sessionId: readerAtStale } = await pairDevice(ctx.db, acc.id, NOW);
    const stale = await readFleetProjection(ctx.db, {
      sessionId: readerAtStale,
      revision: 1,
      now: new Date(NOW.getTime() + 3_000),
    });
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error("unreachable");
    expect(stale.rows.find((r) => r.characterId === 95500001)?.state).toBe("stale");
  });

  it("is absent at exactly 10,000ms", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId: publisherSession } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500002,
      accountId: acc.id,
      fleetId: 6200002,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    await replaceDeviceProjection(ctx.db, {
      sessionId: publisherSession,
      now: NOW,
      revision: 1,
      rows: [row(95500002, 500)],
    });

    const { sessionId: readerSession } = await pairDevice(ctx.db, acc.id, NOW);
    const gone = await readFleetProjection(ctx.db, {
      sessionId: readerSession,
      revision: 1,
      now: new Date(NOW.getTime() + 10_000),
    });
    expect(gone.ok).toBe(true);
    if (!gone.ok) throw new Error("unreachable");
    expect(gone.rows.find((r) => r.characterId === 95500002)).toBeUndefined();
  });
});

describe("readFleetProjection: filtered read", () => {
  it("returns only rows from the requester's own eligible fleets, joined names, and no fleet id", async () => {
    const publisherAcc = await seedAccount(ctx.db, { tier: "member" });
    const readerAcc = await seedAccount(ctx.db, { tier: "member" });
    const outsiderAcc = await seedAccount(ctx.db, { tier: "member" });

    const { sessionId: publisherSession } = await pairDevice(
      ctx.db,
      publisherAcc.id,
      NOW,
    );
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500101,
      accountId: publisherAcc.id,
      fleetId: 6200010,
      rosterCharacterIds: [95500101, 95500102],
      now: NOW,
      characterName: "Fleet Mate",
    });

    // Reader is in the SAME fleet via its own eligibility row.
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500102,
      accountId: readerAcc.id,
      fleetId: 6200010,
      rosterCharacterIds: [95500101, 95500102],
      now: NOW,
    });
    const { sessionId: readerSession } = await pairDevice(ctx.db, readerAcc.id, NOW);

    // Outsider is eligible for a DIFFERENT fleet entirely.
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500103,
      accountId: outsiderAcc.id,
      fleetId: 6200011,
      now: NOW,
    });
    const { sessionId: outsiderSession } = await pairDevice(ctx.db, outsiderAcc.id, NOW);

    await replaceDeviceProjection(ctx.db, {
      sessionId: publisherSession,
      now: NOW,
      revision: 1,
      rows: [row(95500101, 700, ["SCRAM/POINT"])],
    });

    const readerResult = await readFleetProjection(ctx.db, {
      sessionId: readerSession,
      revision: 1,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(readerResult.ok).toBe(true);
    if (!readerResult.ok) throw new Error("unreachable");
    expect(readerResult.rows).toHaveLength(1);
    const seen = readerResult.rows[0];
    expect(seen).toEqual({
      characterId: 95500101,
      dps: 700,
      ewar: ["SCRAM/POINT"],
      characterName: "Fleet Mate",
      state: "live",
      ageMs: 1_000,
    });
    expect(seen).not.toHaveProperty("fleetId");

    const outsiderResult = await readFleetProjection(ctx.db, {
      sessionId: outsiderSession,
      revision: 1,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(outsiderResult.ok).toBe(true);
    if (!outsiderResult.ok) throw new Error("unreachable");
    expect(outsiderResult.rows).toHaveLength(0);
  });

  it("includes the requester's own published row without self-exclusion", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500110,
      accountId: acc.id,
      fleetId: 6200020,
      now: NOW,
    });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);

    await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95500110, 300)],
    });

    const result = await readFleetProjection(ctx.db, {
      sessionId,
      revision: 2,
      now: new Date(NOW.getTime() + 1_000),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rows.map((r) => r.characterId)).toEqual([95500110]);
  });
});

describe("readFleetProjection: session validity and cadence", () => {
  it("returns the same generic forbidden code for an unknown session and for a non-eligible account", async () => {
    const unknown = await readFleetProjection(ctx.db, {
      sessionId: "not-a-real-session-id",
      revision: 1,
      now: NOW,
    });
    expect(unknown).toEqual({ ok: false, code: "forbidden" });

    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    // No fleet_eligibility row at all for this account.
    const noEligibility = await readFleetProjection(ctx.db, {
      sessionId,
      revision: 1,
      now: NOW,
    });
    expect(noEligibility).toEqual({ ok: false, code: "forbidden" });
  });

  it("enforces the minimum read interval, and a rejected cadence attempt does not consume the revision (retry reuses it)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500200,
      accountId: acc.id,
      fleetId: 6200030,
      now: NOW,
    });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);

    const first = await readFleetProjection(ctx.db, { sessionId, revision: 1, now: NOW });
    expect(first.ok).toBe(true);

    const tooSoon = await readFleetProjection(ctx.db, {
      sessionId,
      revision: 2,
      now: new Date(NOW.getTime() + 100),
    });
    expect(tooSoon).toEqual({ ok: false, code: "rate_limited" });

    const later = await readFleetProjection(ctx.db, {
      sessionId,
      revision: 2,
      now: new Date(NOW.getTime() + 600),
    });
    expect(later.ok).toBe(true);
  });

  it("rejects a replayed (non-increasing) read revision, sharing the SAME monotonic counter a prior publish already advanced", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500210,
      accountId: acc.id,
      fleetId: 6200031,
      now: NOW,
    });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);

    // The session's own PUT already consumed revision 1 -- a GET replaying
    // that same value (or anything not strictly greater) must be refused,
    // proving the read path shares fleet_device_session's ONE counter with
    // publish rather than keeping an independent one.
    const published = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95500210, 100)],
    });
    expect(published).toEqual({ ok: true });

    const replay = await readFleetProjection(ctx.db, {
      sessionId,
      revision: 1,
      now: new Date(NOW.getTime() + 600),
    });
    expect(replay).toEqual({ ok: false, code: "revision_replayed" });

    const accepted = await readFleetProjection(ctx.db, {
      sessionId,
      revision: 2,
      now: new Date(NOW.getTime() + 600),
    });
    expect(accepted.ok).toBe(true);
  });
});

describe("pruneExpiredFleetRelay", () => {
  it("removes hard-expired rows and leases even with no reader", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500300,
      accountId: acc.id,
      fleetId: 6200040,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95500300, 400)],
    });
    expect(await rowFor(ctx.db, 95500300)).toBeDefined();
    expect(await leaseFor(ctx.db, 95500300)).toBeDefined();

    await pruneExpiredFleetRelay(ctx.db, new Date(NOW.getTime() + 10_000));

    expect(await rowFor(ctx.db, 95500300)).toBeUndefined();
    expect(await leaseFor(ctx.db, 95500300)).toBeUndefined();
  });
});

describe("device/account revocation cleanup", () => {
  it("revoking a device removes its current telemetry immediately", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, device } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500400,
      accountId: acc.id,
      fleetId: 6200050,
      now: NOW,
    });
    await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 1,
      rows: [row(95500400, 500)],
    });
    expect(await rowFor(ctx.db, 95500400)).toBeDefined();

    await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);

    expect(await rowFor(ctx.db, 95500400)).toBeUndefined();
    expect(await leaseFor(ctx.db, 95500400)).toBeUndefined();
    const [session] = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, device.id));
    expect(session).toBeUndefined();
  });
});

describe("cross-module lock order (deadlock avoidance)", () => {
  it("a concurrent publish blocks on (never deadlocks against) another transaction already holding this device's row lock -- the fix for the publish/revoke cross-order deadlock", async () => {
    // Before the fix, `replaceDeviceProjection` locked SESSION then DEVICE,
    // while `revokeFleetDevice`'s cleanup locked DEVICE then SESSION -- a
    // classic AB-BA deadlock between the two. Every signed-session path now
    // goes through `gateSignedSession`, which locks DEVICE first (see
    // fleet-relay.ts's own LOCK ORDER doc); `revokeFleetDevice` locks the
    // SAME device row first too. This proves the publish side of that
    // agreement directly and deterministically: a raw connection holds the
    // device row's FOR UPDATE lock (standing in for ANY other transaction
    // that locks it first, revoke included), and a REAL, concurrent
    // `replaceDeviceProjection` call is confirmed to BLOCK on it (not
    // proceed, not throw, not deadlock) until it is released, then
    // completes successfully once it is.
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId, device } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500500,
      accountId: acc.id,
      fleetId: 6200060,
      now: NOW,
    });

    const client = await ctx.pool.connect();
    let publishResult: ReturnType<typeof replaceDeviceProjection> | undefined;
    try {
      await client.query("begin");
      await client.query("select 1 from fleet_device where id = $1 for update", [
        device.id,
      ]);

      publishResult = replaceDeviceProjection(ctx.db, {
        sessionId,
        now: NOW,
        revision: 1,
        rows: [row(95500500, 100)],
      });

      // Confirm the publish call is ACTUALLY blocked on a lock before
      // releasing the raw client's transaction -- a self-verifying guard
      // against a silently-degenerate race, the same discipline the
      // existing M1 regression test above uses.
      let blocked = false;
      for (let i = 0; i < 50; i++) {
        const { rows: waiters } = await ctx.pool.query(
          "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'",
        );
        if ((waiters[0] as { n: number }).n > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);

      await client.query("commit");
    } finally {
      client.release();
    }

    const result = await publishResult;
    expect(result).toEqual({ ok: true });
  });

  // This is the regression the previous version of this describe block
  // claimed to cover and did not: that single-device test proves
  // `gateSignedSession`'s device-before-session order, never anything about
  // `revokeFleetRelayForAccount`'s OWN character-lock order across MULTIPLE
  // devices -- it never called that function at all, so it stayed green
  // whether or not this test's own bug existed (vacuous exactly the way
  // AGENTS.md's "a test written to prove a fix must be shown to fail
  // without it" warns against). This test calls the real function, revoking
  // a real two-device account, and stands in for any OTHER caller
  // (`RELAY_CHARACTER_LOCK_CLASS = 2`, the identical advisory-lock class
  // `lockFleetCharactersAscending` uses) that touches the SAME two
  // characters in the correct, globally ascending order.
  it("revokeFleetRelayForAccount locks the UNION of every device's characters ascending, globally, before any per-device delete -- not device-by-device, which could lock a later device's higher character id before an earlier device's lower one, an AB-BA deadlock against anything else that locks the same two ascending", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { device: deviceX } = await pairDevice(ctx.db, acc.id, NOW);
    const { device: deviceY } = await pairDevice(ctx.db, acc.id, NOW);

    // `revokeFleetRelayForAccount`'s own device select carries no ORDER BY,
    // so this test does not assume which of the two devices it visits
    // first -- it asks, with a read of the exact same shape, then assigns
    // the HIGHER character id to whichever device that turns out to be. A
    // per-device (not globally ascending) revoke would then lock that HIGH
    // character while processing the device found first, and the LOW one
    // only once it reaches the device found second -- backwards from the
    // ascending order this test's raw client (standing in for any other
    // correctly-ordered caller) always uses.
    const devicesInScanOrder = await ctx.db
      .select()
      .from(fleetDevice)
      .where(and(eq(fleetDevice.accountId, acc.id), isNull(fleetDevice.revokedAt)));
    expect(devicesInScanOrder).toHaveLength(2);
    const [deviceProcessedFirst, deviceProcessedSecond] = devicesInScanOrder;
    const deviceById = new Map([
      [deviceX.id, deviceX],
      [deviceY.id, deviceY],
    ]);
    expect(deviceById.has(deviceProcessedFirst.id)).toBe(true);
    expect(deviceById.has(deviceProcessedSecond.id)).toBe(true);

    const CHAR_HIGH = 95990900;
    const CHAR_LOW = 95990100;
    await seedCharacter(ctx.db, cfg, { id: CHAR_HIGH, accountId: acc.id });
    await seedCharacter(ctx.db, cfg, { id: CHAR_LOW, accountId: acc.id });

    async function seedRelayState(characterId: number, deviceId: string): Promise<void> {
      const [session] = await ctx.db
        .select({ id: fleetDeviceSession.id })
        .from(fleetDeviceSession)
        .where(eq(fleetDeviceSession.deviceId, deviceId));
      await ctx.db.insert(fleetPublisherLease).values({
        characterId,
        deviceId,
        sessionId: session.id,
        fleetId: 5300001,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      });
      await ctx.db.insert(fleetTelemetryRow).values({
        characterId,
        fleetId: 5300001,
        deviceId,
        sessionId: session.id,
        dps: 100,
        ewar: [],
        receivedAt: NOW,
        staleAt: new Date(NOW.getTime() + 3_000),
        hardExpiresAt: new Date(NOW.getTime() + 10_000),
      });
    }
    // Whichever device is processed FIRST gets the HIGH character; whichever
    // is processed SECOND gets the LOW one -- exactly the crossed order a
    // per-device loop would lock in.
    await seedRelayState(CHAR_HIGH, deviceProcessedFirst.id);
    await seedRelayState(CHAR_LOW, deviceProcessedSecond.id);

    const client = await ctx.pool.connect();
    try {
      await client.query("begin");
      // Standing in for any other correctly-ordered caller already holding
      // the LOW character's lock -- exactly where a per-device revoke,
      // having already locked HIGH while processing the first device, would
      // next need to wait.
      await client.query("select pg_advisory_xact_lock(2, hashint8($1))", [CHAR_LOW]);

      const revokePromise = revokeFleetRelayForAccount(ctx.db, acc.id, NOW);

      let blocked = false;
      for (let i = 0; i < 50; i++) {
        const { rows: waiters } = await ctx.pool.query(
          "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'",
        );
        if ((waiters[0] as { n: number }).n > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);

      // A globally-ascending revoke's FIRST character lock for this whole
      // account is CHAR_LOW (already held above), so it cannot have reached
      // CHAR_HIGH yet -- this must succeed immediately. A per-device revoke
      // would already hold CHAR_HIGH from processing the first device,
      // creating exactly the AB-BA cycle this query would then wait on:
      // Postgres's own deadlock detector would abort one side of it, and
      // whichever side that is, either this query or the final assertion
      // below fails rather than resolving cleanly.
      await client.query("select pg_advisory_xact_lock(2, hashint8($1))", [CHAR_HIGH]);

      await client.query("commit");
      await expect(revokePromise).resolves.toBeUndefined();
    } finally {
      client.release();
    }

    const devicesAfter = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    expect(devicesAfter).toHaveLength(2);
    for (const d of devicesAfter) {
      expect(d.revokedAt).toEqual(NOW);
    }
    expect(await leaseFor(ctx.db, CHAR_HIGH)).toBeUndefined();
    expect(await leaseFor(ctx.db, CHAR_LOW)).toBeUndefined();
    expect(await rowFor(ctx.db, CHAR_HIGH)).toBeUndefined();
    expect(await rowFor(ctx.db, CHAR_LOW)).toBeUndefined();
  });
});

// docs/fleet-protocol.md's own contract: ONE monotonic revision counter and
// ONE pair of cadence timestamps per session, shared by every signed-request
// KIND (publish, catalogue read, snapshot read, session renewal) -- never one
// sequence per kind. These are the tests that contract's own doc references.
describe("protocol contract: revision/cadence are shared across every signed-request kind, not per-route (docs/fleet-protocol.md)", () => {
  it("a renewal's revision blocks a later publish at the identical revision, proving one shared counter rather than an independent one per route", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95600100,
      accountId: acc.id,
      fleetId: 6400040,
      now: NOW,
    });

    const renewed = await renewFleetDeviceSession(ctx.db, {
      sessionId,
      revision: 1,
      now: NOW,
    });
    expect(renewed.ok).toBe(true);

    // Same revision, a DIFFERENT route (publish) and cadence bucket
    // ("publish", not the renewal's "read") -- still refused, because the
    // counter it is checked against is the session's, not this route's own.
    const replay = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: new Date(NOW.getTime() + 600),
      revision: 1,
      rows: [row(95600100, 100)],
    });
    expect(replay).toEqual({ ok: false, code: "revision_replayed" });
  });

  // The concrete hazard docs/fleet-protocol.md's "one-in-flight-request"
  // section warns about: a device that constructs two signed requests
  // correctly (a strictly increasing revision each) but sends them
  // CONCURRENTLY has no guarantee they are applied in that same order.
  // Here the higher-revision request (a publish) is simply made to COMMIT
  // first -- standing in for "won the race" -- and the lower-revision one
  // (a renewal), despite being a validly-constructed request when it was
  // sent, is refused anyway. Nothing here is a bug: this IS the replay
  // defense working exactly as designed against the wrong input, which is
  // the whole point of the client-side contract -- never have two of
  // these in flight at once.
  it("a lower revision is refused once a higher one has already committed, even though it was a validly-constructed request -- the hazard the one-in-flight contract exists to avoid", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95600101,
      accountId: acc.id,
      fleetId: 6400041,
      now: NOW,
    });

    // The "second" concurrent request (by send order) commits FIRST.
    const higherFirst = await replaceDeviceProjection(ctx.db, {
      sessionId,
      now: NOW,
      revision: 2,
      rows: [row(95600101, 100)],
    });
    expect(higherFirst).toEqual({ ok: true });

    // The "first" concurrent request (by send order, revision 1 -- correctly
    // one greater than the session's counter AT THE TIME IT WAS SENT)
    // arrives and commits second, against a session counter that has since
    // moved past it.
    const lowerSecond = await renewFleetDeviceSession(ctx.db, {
      sessionId,
      revision: 1,
      now: new Date(NOW.getTime() + 600),
    });
    expect(lowerSecond).toEqual({ ok: false, code: "revision_replayed" });
  });
});

describe("isRetryableRelayError", () => {
  it("recognizes Postgres deadlock (40P01) and serialization-failure (40001) SQLSTATEs", () => {
    expect(isRetryableRelayError({ code: "40P01" })).toBe(true);
    expect(isRetryableRelayError({ code: "40001" })).toBe(true);
  });

  it("rejects any other shape: unrelated codes, missing code, and non-error values", () => {
    expect(isRetryableRelayError({ code: "23505" })).toBe(false); // unique_violation
    expect(isRetryableRelayError(new Error("plain error, no code"))).toBe(false);
    expect(isRetryableRelayError(null)).toBe(false);
    expect(isRetryableRelayError("40P01")).toBe(false);
    expect(isRetryableRelayError({ code: 40001 })).toBe(false); // number, not string
  });
});

describe("retryable Postgres errors map to try_again, not a raw 500", () => {
  it('replaceDeviceProjection returns { ok: false, code: "try_again" } instead of throwing when its transaction hits a synthetic deadlock', async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500510,
      accountId: acc.id,
      fleetId: 6200061,
      now: NOW,
    });

    const result = await withInjectedPgFault(
      ctx.pool,
      { matchSql: /^\s*select/i, code: "40P01" },
      () =>
        replaceDeviceProjection(ctx.db, {
          sessionId,
          now: NOW,
          revision: 1,
          rows: [row(95500510, 100)],
        }),
    );

    expect(result).toEqual({ ok: false, code: "try_again" });
    // Nothing was left half-mutated: the transaction rolled back, so no
    // lease/row exists for this character at all.
    expect(await rowFor(ctx.db, 95500510)).toBeUndefined();
  });
});

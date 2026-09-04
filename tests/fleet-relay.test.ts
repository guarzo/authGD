import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { eq } from "drizzle-orm";
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
  revokeFleetDevice,
} from "@/services/fleet-pairing";
import {
  type PublishedRow,
  pruneExpiredFleetRelay,
  readFleetProjection,
  replaceDeviceProjection,
} from "@/services/fleet-relay";
import { testConfig } from "./helpers/config";
import { setupTestDb } from "./helpers/db";
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
  it("is live just under 3s, stale at exactly 3s, and absent at exactly 10s", async () => {
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

    const { sessionId: readerSession } = await pairDevice(ctx.db, acc.id, NOW);

    const almostStale = await readFleetProjection(ctx.db, {
      sessionId: readerSession,
      now: new Date(NOW.getTime() + 2_999),
    });
    expect(almostStale.ok).toBe(true);
    if (!almostStale.ok) throw new Error("unreachable");
    expect(almostStale.rows.find((r) => r.characterId === 95500001)?.state).toBe("live");

    const stale = await readFleetProjection(ctx.db, {
      sessionId: readerSession,
      now: new Date(NOW.getTime() + 4_500), // past the 500ms read cadence too
    });
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error("unreachable");
    expect(stale.rows.find((r) => r.characterId === 95500001)?.state).toBe("stale");

    const gone = await readFleetProjection(ctx.db, {
      sessionId: readerSession,
      now: new Date(NOW.getTime() + 10_000),
    });
    expect(gone.ok).toBe(true);
    if (!gone.ok) throw new Error("unreachable");
    expect(gone.rows.find((r) => r.characterId === 95500001)).toBeUndefined();
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
      now: NOW,
    });
    expect(unknown).toEqual({ ok: false, code: "forbidden" });

    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);
    // No fleet_eligibility row at all for this account.
    const noEligibility = await readFleetProjection(ctx.db, { sessionId, now: NOW });
    expect(noEligibility).toEqual({ ok: false, code: "forbidden" });
  });

  it("enforces the minimum read interval", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedEligibleCharacter(ctx.db, {
      characterId: 95500200,
      accountId: acc.id,
      fleetId: 6200030,
      now: NOW,
    });
    const { sessionId } = await pairDevice(ctx.db, acc.id, NOW);

    const first = await readFleetProjection(ctx.db, { sessionId, now: NOW });
    expect(first.ok).toBe(true);

    const tooSoon = await readFleetProjection(ctx.db, {
      sessionId,
      now: new Date(NOW.getTime() + 100),
    });
    expect(tooSoon).toEqual({ ok: false, code: "rate_limited" });

    const later = await readFleetProjection(ctx.db, {
      sessionId,
      now: new Date(NOW.getTime() + 600),
    });
    expect(later.ok).toBe(true);
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

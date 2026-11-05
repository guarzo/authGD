import { createHash, sign } from "node:crypto";
import { beginFleetRecovery, completeFleetRecovery } from "@/services/fleet-recovery";
import { transitionFleetSharingMode } from "@/services/fleet-sharing-mode";
import { recoveryInitiation, recoveryCompletion } from "./helpers/fleet-recovery";
import { reconcileFleetKeys } from "./helpers/fleet-sharing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  character,
  fleetDevice,
  fleetDeviceSession,
  fleetPairingRequest,
  fleetRecoveryChallenge,
} from "@/db/schema";
import {
  beginPairing,
  approvePairing,
  completePairing,
  pairingChallengePreimage,
  renewFleetDeviceSession,
} from "@/services/fleet-pairing";
import { readDeviceCatalogueForSession } from "@/services/fleet-relay";
import {
  acknowledgeFleetCapabilities,
  readFleetDeviceState,
} from "@/services/fleet-device";
import { setFleetParticipation } from "@/services/fleet-participation";
import { readDeviceEligibility } from "@/services/fleet-eligibility";
import { sharedAccounts } from "./helpers/fleet-shared-admission";
import * as framing from "@/lib/fleet-api-v2";
import { withInjectedPgFault } from "./helpers/pg-fault";
import { fleetKeyPair, pairDevice } from "./helpers/fleet-sharing";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";

process.env.APP_BASE_URL = "https://auth.example";
let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.cleanup());

it("recovery initiation validates its closed response before even bounded cleanup writes", async () => {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
  const p = await pairDevice(
    ctx.db,
    (await seedAccount(ctx.db, { tier: "member" })).id,
    new Date(),
  );
  const expired = await beginFleetRecovery(ctx.db, recoveryInitiation(p));
  await ctx.db
    .update(fleetRecoveryChallenge)
    .set({ expiresAt: new Date(0) })
    .where(eq(fleetRecoveryChallenge.id, expired.challengeId));
  const before = await ctx.db.select().from(fleetRecoveryChallenge);
  const spy = vi
    .spyOn(framing, "serializeFleetV2Json")
    .mockReturnValue({ ok: false, code: "service_unavailable" });
  try {
    await expect(
      withInjectedPgFault(
        ctx.pool,
        { matchSql: /delete from "?fleet_recovery_challenge/i, code: "XX000" },
        () => beginFleetRecovery(ctx.db, recoveryInitiation(p)),
      ),
    ).rejects.toThrow("service_unavailable");
  } finally {
    spy.mockRestore();
  }
  expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual(before);
});

it("recovery refuses malformed durable rights without consuming proof or replacing sessions", async () => {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
  const p = await pairDevice(
    ctx.db,
    (await seedAccount(ctx.db, { tier: "member" })).id,
    new Date(),
  );
  const c = await beginFleetRecovery(ctx.db, recoveryInitiation(p));
  await ctx.db
    .update(fleetDevice)
    .set({ approvedCapabilities: ["combat-v2"] })
    .where(eq(fleetDevice.id, p.device.id));
  const before = await ctx.db.select().from(fleetDeviceSession);
  const challenges = await ctx.db.select().from(fleetRecoveryChallenge);
  await expect(completeFleetRecovery(ctx.db, recoveryCompletion(p, c))).rejects.toThrow(
    "service_unavailable",
  );
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
  expect(await ctx.db.select().from(fleetRecoveryChallenge)).toEqual(challenges);
});

it.each(["participation", "eligibility"])(
  "%s complete-output refusal does not consume shared cadence or change participation",
  async (kind) => {
    const p = await sharedAccounts(ctx.db, new Date(Date.now() - 3000));
    const devices = await ctx.db.select().from(fleetDevice);
    const sessions = await ctx.db.select().from(fleetDeviceSession);
    // Fault the real serializer boundary after setup, not service/transaction behavior.
    const spy = vi
      .spyOn(framing, "serializeFleetV2Json")
      .mockReturnValue({ ok: false, code: "service_unavailable" });
    try {
      const call = { sessionId: p.b.sessionId, revision: 3 };
      const result =
        kind === "participation"
          ? await setFleetParticipation(ctx.db, {
              ...call,
              enabled: false,
              expectedGeneration: 1,
            })
          : await readDeviceEligibility(ctx.db, call);
      expect(result).toEqual({ ok: false, code: "service_unavailable" });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await ctx.db.select().from(fleetDevice)).toEqual(devices);
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(sessions);
  },
);

it.each(["pairing", "participation"])(
  "%s rejects a single nested prototype output key before authority commit",
  async (kind) => {
    const p = await sharedAccounts(ctx.db, new Date(Date.now() - 3000));
    const keys = fleetKeyPair();
    const { pairingId } = await beginPairing(ctx.db, {
      publicKeySpki: keys.publicKeySpki,
    });
    await approvePairing(ctx.db, pairingId, p.owner.id);
    const before = {
      devices: await ctx.db.select().from(fleetDevice),
      sessions: await ctx.db.select().from(fleetDeviceSession),
      pairings: await ctx.db.select().from(fleetPairingRequest),
    };
    const serialize = framing.serializeFleetV2Json;
    const spy = vi
      .spyOn(framing, "serializeFleetV2Json")
      .mockImplementation((value, schema, maxBytes) => {
        const dto = value as { catalogue?: object; participation?: object };
        Object.defineProperty((dto.catalogue ?? dto.participation)!, "__proto__", {
          value: null,
          enumerable: true,
        });
        // Corrupt only the candidate DTO; execute the real combined output boundary.
        return serialize(value, schema, maxBytes);
      });
    try {
      if (kind === "pairing") {
        await expect(
          completePairing(ctx.db, {
            pairingId,
            completionSignature: sign(
              null,
              pairingChallengePreimage(pairingId),
              keys.privateKey,
            ).toString("base64url"),
          }),
        ).rejects.toThrow("service_unavailable");
      } else {
        expect(
          await setFleetParticipation(ctx.db, {
            sessionId: p.b.sessionId,
            revision: 3,
            enabled: false,
            expectedGeneration: 1,
          }),
        ).toEqual({ ok: false, code: "service_unavailable" });
      }
    } finally {
      spy.mockRestore();
    }
    expect(await ctx.db.select().from(fleetDevice)).toEqual(before.devices);
    expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before.sessions);
    expect(await ctx.db.select().from(fleetPairingRequest)).toEqual(before.pairings);
  },
);

it("renewal retains D union, this-request C and K without approval expansion or reset", async () => {
  const ready = await reconcileFleetKeys(ctx.db);
  await transitionFleetSharingMode(ctx.db, {
    enabled: true,
    expectedRevision: ready.revision,
  });
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const now = new Date();
  const broad = await pairDevice(ctx.db, owner.id, now, [
    "shared-source-v1",
    "combat-v2",
  ]);
  const narrow = await pairDevice(ctx.db, owner.id, now, ["shared-source-v1"], broad);
  expect(
    (
      await acknowledgeFleetCapabilities(ctx.db, {
        sessionId: narrow.sessionId,
        revision: 1,
        now,
        capabilities: ["shared-source-v1"],
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await renewFleetDeviceSession(ctx.db, {
        sessionId: narrow.sessionId,
        revision: 2,
        now: new Date(now.getTime() + 500),
      })
    ).ok,
  ).toBe(true);
  expect(
    await readFleetDeviceState(ctx.db, {
      sessionId: narrow.sessionId,
      revision: 3,
      now: new Date(now.getTime() + 1000),
    }),
  ).toMatchObject({
    ok: true,
    value: {
      approvedCapabilities: ["shared-source-v1", "combat-v2"],
      sessionApprovedCapabilities: ["shared-source-v1"],
      acknowledgedCapabilities: ["shared-source-v1"],
      participation: { enabled: false, generation: 0 },
    },
  });
});

it("standalone catalogue preserves unsigned digest extraction and full names/cardinality", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const p = await pairDevice(ctx.db, owner.id, new Date());
  const rows = Array.from({ length: 300 }, (_, i) => ({
    id: 70000 + i,
    name: "é".repeat(200),
    ownerHash: `owner-${i}`,
    accountId: owner.id,
  }));
  await ctx.db.insert(character).values(rows);
  const revision = createHash("sha256")
    .update(rows.map((c) => `${c.id}:${c.name}`).join("\n"))
    .digest()
    .readUInt32BE(0);
  expect(revision).toBeGreaterThan(2147483647);
  const result = await readDeviceCatalogueForSession(ctx.db, {
    sessionId: p.sessionId,
    revision: 1,
  });
  if (!result.ok) throw new Error(result.code);
  const json = JSON.parse(result.json);
  expect(json.revision).toBe(revision);
  expect(json.characters).toEqual(
    rows.map((c) => ({ character_id: c.id, character_name: c.name })),
  );
  expect(Buffer.byteLength(result.json)).toBeGreaterThan(65536);
});

it("standalone oversized complete catalogue refuses without consuming cadence", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const p = await pairDevice(ctx.db, owner.id, new Date());
  await ctx.db.insert(character).values(
    Array.from({ length: 3000 }, (_, i) => ({
      id: 72000 + i,
      name: "é".repeat(200),
      ownerHash: `owner-${i}`,
      accountId: owner.id,
    })),
  );
  const before = await ctx.db.select().from(fleetDeviceSession);
  expect(
    await readDeviceCatalogueForSession(ctx.db, { sessionId: p.sessionId, revision: 1 }),
  ).toEqual({ ok: false, code: "service_unavailable" });
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
});

it("beginPairing refuses an unrepresentable expiry before allocating the request", async () => {
  await expect(
    beginPairing(ctx.db, {
      publicKeySpki: fleetKeyPair().publicKeySpki,
      now: new Date("9999-12-31T23:59:00.000Z"),
    }),
  ).rejects.toThrow("service_unavailable");
  expect(await ctx.db.select().from(fleetPairingRequest)).toEqual([]);
});

it("pairing refuses a complete oversized catalogue before consuming or issuing any device/session", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const keys = fleetKeyPair();
  const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: keys.publicKeySpki });
  await approvePairing(ctx.db, pairingId, owner.id);
  // Valid complete names/cardinality, but not within the pre-session 64KiB budget.
  await ctx.db.insert(character).values(
    Array.from({ length: 300 }, (_, i) => ({
      id: 70000 + i,
      name: "é".repeat(200),
      ownerHash: `owner-${i}`,
      accountId: owner.id,
    })),
  );
  const before = await ctx.db.select().from(fleetPairingRequest);
  await expect(
    completePairing(ctx.db, {
      pairingId,
      completionSignature: sign(
        null,
        pairingChallengePreimage(pairingId),
        keys.privateKey,
      ).toString("base64url"),
    }),
  ).rejects.toThrow("service_unavailable");
  expect(await ctx.db.select().from(fleetPairingRequest)).toEqual(before);
  expect(await ctx.db.select().from(fleetDevice)).toEqual([]);
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual([]);
});

it("catalogue output refusal leaves the shared revision and read cadence untouched", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const p = await pairDevice(ctx.db, owner.id, new Date());
  await seedCharacter(ctx.db, testConfig(), {
    id: 1234,
    name: "bad\u0001name",
    accountId: owner.id,
  });
  const before = await ctx.db.select().from(fleetDeviceSession);
  expect(
    await readDeviceCatalogueForSession(ctx.db, { sessionId: p.sessionId, revision: 1 }),
  ).toEqual({ ok: false, code: "service_unavailable" });
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
});

it("renewal refuses unrepresentable checked expiry without changing session authority", async () => {
  const owner = await seedAccount(ctx.db, { tier: "member" });
  const p = await pairDevice(ctx.db, owner.id, new Date());
  await ctx.db
    .update(fleetDeviceSession)
    .set({ expiresAt: new Date("9999-12-31T23:59:59.999Z") })
    .where(eq(fleetDeviceSession.deviceId, p.device.id));
  const before = await ctx.db.select().from(fleetDeviceSession);
  expect(
    await renewFleetDeviceSession(ctx.db, {
      sessionId: p.sessionId,
      revision: 1,
      now: new Date("9999-12-31T23:50:00.000Z"),
    }),
  ).toEqual({ ok: false, code: "service_unavailable" });
  expect(await ctx.db.select().from(fleetDeviceSession)).toEqual(before);
});

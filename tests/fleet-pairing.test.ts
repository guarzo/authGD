import {
  createPublicKey,
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import {
  account,
  auditLog,
  fleetDevice,
  fleetDeviceSession,
  fleetPairingRequest,
  fleetPublisherLease,
  fleetTelemetryRow,
} from "@/db/schema";
import { canonicalDevicePublicKeyB64 } from "@/lib/fleet-signature";
import {
  DeviceBoundToAnotherAccountError,
  DeviceNotFoundError,
  InvalidCompletionProofError,
  InvalidDevicePublicKeyError,
  NonMemberApprovalError,
  PairingAlreadyApprovedError,
  PairingAlreadyConsumedError,
  PairingExpiredError,
  PairingNotApprovedError,
  PairingNotFoundError,
  RevokedDeviceKeyError,
  approvePairing,
  beginPairing,
  completePairing,
  pairingChallengePreimage,
  revokeFleetDevice,
  revokeFleetRelayForAccount,
} from "@/services/fleet-pairing";
import { setupTestDb } from "./helpers/db";
import { seedAccount, seedCharacter } from "./helpers/seed";
import { testConfig } from "./helpers/config";
import fixture from "./fixtures/fleet-pairing-v1.json";

const cfg = testConfig();
const NOW = new Date("2026-09-04T12:00:00.000Z");

let ctx: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  ctx = await setupTestDb();
});
afterAll(() => ctx.cleanup());

function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  return { spki, privateKey };
}

function signCompletion(
  privateKey: ReturnType<typeof newKeyPair>["privateKey"],
  pairingId: string,
) {
  return ed25519Sign(null, pairingChallengePreimage(pairingId), privateKey).toString(
    "base64url",
  );
}

async function auditRowsFor(db: Db, target: string) {
  return db.select().from(auditLog).where(eq(auditLog.target, target));
}

describe("fleet-pairing-v1 golden vector (tests/fixtures/fleet-pairing-v1.json)", () => {
  it("reproduces the exact UTF-8 preimage and verifies the fixture's public-key/signature pair", () => {
    expect(fixture.preimage_utf8).toBe(`fleet-pairing-v1\n${fixture.pairing_id}`);
    expect(pairingChallengePreimage(fixture.pairing_id).toString("utf8")).toBe(
      fixture.preimage_utf8,
    );

    const key = createPublicKey({
      key: Buffer.from(fixture.public_key_spki_b64, "base64"),
      format: "der",
      type: "spki",
    });
    expect(key.asymmetricKeyType).toBe("ed25519");
    const signature = Buffer.from(fixture.signature_b64url, "base64url");
    expect(
      ed25519Verify(null, pairingChallengePreimage(fixture.pairing_id), key, signature),
    ).toBe(true);
  });
});

describe("beginPairing candidate key validation", () => {
  it("rejects a candidate key that is not valid DER at all", async () => {
    await expect(
      beginPairing(ctx.db, { publicKeySpki: new Uint8Array([1, 2, 3, 4, 5]), now: NOW }),
    ).rejects.toThrow(InvalidDevicePublicKeyError);
  });

  it("rejects a candidate key that parses as SPKI DER but is the wrong algorithm", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaSpki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    await expect(
      beginPairing(ctx.db, { publicKeySpki: rsaSpki, now: NOW }),
    ).rejects.toThrow(InvalidDevicePublicKeyError);
  });

  it("never creates a pairing request row for a rejected candidate key", async () => {
    const garbage = new Uint8Array([9, 9, 9, 9]);
    await expect(
      beginPairing(ctx.db, { publicKeySpki: garbage, now: NOW }),
    ).rejects.toThrow(InvalidDevicePublicKeyError);

    const rows = await ctx.db
      .select()
      .from(fleetPairingRequest)
      .where(
        eq(fleetPairingRequest.publicKeySpkiB64, canonicalDevicePublicKeyB64(garbage)),
      );
    expect(rows).toHaveLength(0);
  });
});

describe("beginPairing / approvePairing / completePairing", () => {
  it("completes the full pending -> approved -> completed lifecycle exactly once", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, { id: 92300001, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();

    const { pairingId, approvalUrl } = await beginPairing(ctx.db, {
      publicKeySpki: spki,
      now: NOW,
    });
    expect(approvalUrl).toBe(`/fleet/pair/${pairingId}`);

    await approvePairing(ctx.db, pairingId, acc.id, NOW);

    const { sessionId, catalogue } = await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });
    expect(sessionId.length).toBeGreaterThanOrEqual(32);
    expect(catalogue.characters).toEqual([
      { characterId: ch.id, characterName: ch.name },
    ]);

    // Exactly once: a second completion attempt with a fresh, otherwise-valid
    // signature is refused.
    await expect(
      completePairing(ctx.db, {
        pairingId,
        completionSignature: signCompletion(privateKey, pairingId),
        now: NOW,
      }),
    ).rejects.toThrow(PairingAlreadyConsumedError);
  });

  it("rejects approving an unknown pairing request", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await expect(
      approvePairing(ctx.db, "00000000-0000-0000-0000-000000000000", acc.id, NOW),
    ).rejects.toThrow(PairingNotFoundError);
  });

  it("rejects approval by a non-Member account", async () => {
    const { spki } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });

    const associate = await seedAccount(ctx.db, { tier: "associate" });
    await expect(approvePairing(ctx.db, pairingId, associate.id, NOW)).rejects.toThrow(
      NonMemberApprovalError,
    );

    await expect(
      approvePairing(ctx.db, pairingId, "00000000-0000-0000-0000-000000000000", NOW),
    ).rejects.toThrow(NonMemberApprovalError);
  });

  it("rejects re-approving an already-approved request", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { spki } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });

    await approvePairing(ctx.db, pairingId, acc.id, NOW);
    await expect(approvePairing(ctx.db, pairingId, acc.id, NOW)).rejects.toThrow(
      PairingAlreadyApprovedError,
    );
  });

  it("rejects approving an expired pairing request", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { spki } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });

    const later = new Date(NOW.getTime() + 11 * 60 * 1000); // past the 10-minute TTL
    await expect(approvePairing(ctx.db, pairingId, acc.id, later)).rejects.toThrow(
      PairingExpiredError,
    );
  });

  it("rejects approving an already-consumed request", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300002, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });

    await approvePairing(ctx.db, pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });

    await expect(approvePairing(ctx.db, pairingId, acc.id, NOW)).rejects.toThrow(
      PairingAlreadyConsumedError,
    );
  });

  it("rejects completing a request that has not been approved yet", async () => {
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });

    await expect(
      completePairing(ctx.db, {
        pairingId,
        completionSignature: signCompletion(privateKey, pairingId),
        now: NOW,
      }),
    ).rejects.toThrow(PairingNotApprovedError);
  });

  it("rejects completing an unknown pairing request", async () => {
    await expect(
      completePairing(ctx.db, {
        pairingId: "00000000-0000-0000-0000-000000000000",
        completionSignature: "a".repeat(86),
        now: NOW,
      }),
    ).rejects.toThrow(PairingNotFoundError);
  });

  it("rejects completing an expired pairing request", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);

    const later = new Date(NOW.getTime() + 11 * 60 * 1000);
    await expect(
      completePairing(ctx.db, {
        pairingId,
        completionSignature: signCompletion(privateKey, pairingId),
        now: later,
      }),
    ).rejects.toThrow(PairingExpiredError);
  });

  it("rejects an invalid completion proof (wrong key signs the challenge)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { spki } = newKeyPair();
    const { privateKey: wrongPrivateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);

    await expect(
      completePairing(ctx.db, {
        pairingId,
        completionSignature: signCompletion(wrongPrivateKey, pairingId),
        now: NOW,
      }),
    ).rejects.toThrow(InvalidCompletionProofError);
  });

  it("rejects a malformed completion signature", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { spki } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);

    await expect(
      completePairing(ctx.db, {
        pairingId,
        completionSignature: "not-a-valid-signature",
        now: NOW,
      }),
    ).rejects.toThrow(InvalidCompletionProofError);
  });

  it("issues a device session that expires 30 minutes after completion", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300003, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });

    const [device] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    const [session] = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, device.id));
    expect(session.expiresAt).toEqual(new Date(NOW.getTime() + 30 * 60 * 1000));
  });

  it("catalogue includes only the approving account's linked characters", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const other = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300010, accountId: acc.id, name: "Mine" });
    await seedCharacter(ctx.db, cfg, {
      id: 92300011,
      accountId: other.id,
      name: "NotMine",
    });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);

    const { catalogue } = await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });
    expect(catalogue.characters).toEqual([
      { characterId: 92300010, characterName: "Mine" },
    ]);
  });

  it("canonicalizes base64 and base64url spellings of the identical key to one device identity", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const rawSpki = publicKey.export({ type: "spki", format: "der" });
    const viaBase64 = new Uint8Array(
      Buffer.from(Buffer.from(rawSpki).toString("base64"), "base64"),
    );
    const viaBase64Url = new Uint8Array(
      Buffer.from(Buffer.from(rawSpki).toString("base64url"), "base64url"),
    );
    expect(viaBase64).toEqual(viaBase64Url);

    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300020, accountId: acc.id });

    const first = await beginPairing(ctx.db, { publicKeySpki: viaBase64, now: NOW });
    await approvePairing(ctx.db, first.pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId: first.pairingId,
      completionSignature: signCompletion(privateKey, first.pairingId),
      now: NOW,
    });

    const second = await beginPairing(ctx.db, { publicKeySpki: viaBase64Url, now: NOW });
    await approvePairing(ctx.db, second.pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId: second.pairingId,
      completionSignature: signCompletion(privateKey, second.pairingId),
      now: NOW,
    });

    const devices = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    expect(devices).toHaveLength(1);
  });

  it("a revoked device's key can never pair again", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300030, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });

    const [device] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);

    await expect(beginPairing(ctx.db, { publicKeySpki: spki, now: NOW })).rejects.toThrow(
      RevokedDeviceKeyError,
    );
  });

  it("refuses completion when an active device key is presented by a pairing request approved by a different account, leaving the existing device/session/account binding unchanged", async () => {
    const accA = await seedAccount(ctx.db, { tier: "member" });
    const accB = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300070, accountId: accA.id });
    await seedCharacter(ctx.db, cfg, { id: 92300071, accountId: accB.id });
    const { spki, privateKey } = newKeyPair();

    // First pairing binds the key to accA.
    const first = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, first.pairingId, accA.id, NOW);
    const { sessionId: originalSessionId } = await completePairing(ctx.db, {
      pairingId: first.pairingId,
      completionSignature: signCompletion(privateKey, first.pairingId),
      now: NOW,
    });
    const [deviceBefore] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.publicKeySpkiB64, canonicalDevicePublicKeyB64(spki)));

    // A second pairing request for the SAME key, approved by a DIFFERENT
    // account, is a stable refusal at completion.
    const second = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, second.pairingId, accB.id, NOW);
    await expect(
      completePairing(ctx.db, {
        pairingId: second.pairingId,
        completionSignature: signCompletion(privateKey, second.pairingId),
        now: NOW,
      }),
    ).rejects.toThrow(DeviceBoundToAnotherAccountError);

    // The existing device's account binding is untouched.
    const [deviceAfter] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.id, deviceBefore.id));
    expect(deviceAfter.accountId).toBe(accA.id);
    expect(deviceAfter.revokedAt).toBeNull();

    // No new session was created, and the original session survives untouched.
    const sessions = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, deviceBefore.id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).not.toBe(originalSessionId); // stored value is hashed, never raw

    // The refused pairing request itself was never consumed.
    const [secondRow] = await ctx.db
      .select()
      .from(fleetPairingRequest)
      .where(eq(fleetPairingRequest.id, second.pairingId));
    expect(secondRow.consumedAt).toBeNull();

    // Only one device row exists for this key throughout.
    const devices = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.publicKeySpkiB64, canonicalDevicePublicKeyB64(spki)));
    expect(devices).toHaveLength(1);
  });

  it("re-pairing the same already-bound account with its own active key stays idempotent", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300072, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();

    const first = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, first.pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId: first.pairingId,
      completionSignature: signCompletion(privateKey, first.pairingId),
      now: NOW,
    });

    // Same account re-approves a fresh pairing request for the SAME key:
    // no refusal, and no second device row.
    const second = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, second.pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId: second.pairingId,
      completionSignature: signCompletion(privateKey, second.pairingId),
      now: NOW,
    });

    const devices = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    expect(devices).toHaveLength(1);
    expect(devices[0].revokedAt).toBeNull();

    // Each completion issues its own session; both belong to the one device.
    const sessions = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, devices[0].id));
    expect(sessions).toHaveLength(2);
  });

  it("refuses completion without mutation when the approving account loses Member tier before completion", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300082, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);

    // Membership lost in the window between approval and completion.
    await ctx.db.update(account).set({ tier: "associate" }).where(eq(account.id, acc.id));

    await expect(
      completePairing(ctx.db, {
        pairingId,
        completionSignature: signCompletion(privateKey, pairingId),
        now: NOW,
      }),
    ).rejects.toThrow(NonMemberApprovalError);

    const [row] = await ctx.db
      .select()
      .from(fleetPairingRequest)
      .where(eq(fleetPairingRequest.id, pairingId));
    expect(row.consumedAt).toBeNull();
    expect(row.approvedDeviceId).toBeNull();
    expect(
      await ctx.db.select().from(fleetDevice).where(eq(fleetDevice.accountId, acc.id)),
    ).toHaveLength(0);
  });

  it("refuses completion when the device is revoked after approval but before completion", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300080, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();

    // First pairing creates the device.
    const first = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, first.pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId: first.pairingId,
      completionSignature: signCompletion(privateKey, first.pairingId),
      now: NOW,
    });
    const [device] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));

    // Second pairing request for the SAME key/account, approved...
    const second = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, second.pairingId, acc.id, NOW);

    // ...but the device is revoked in the window between approval and
    // completion, so completion must refuse rather than silently reviving it.
    await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);

    await expect(
      completePairing(ctx.db, {
        pairingId: second.pairingId,
        completionSignature: signCompletion(privateKey, second.pairingId),
        now: NOW,
      }),
    ).rejects.toThrow(RevokedDeviceKeyError);

    const [secondRow] = await ctx.db
      .select()
      .from(fleetPairingRequest)
      .where(eq(fleetPairingRequest.id, second.pairingId));
    expect(secondRow.consumedAt).toBeNull();
  });
});

describe("revokeFleetDevice", () => {
  it("deletes the device's sessions but keeps the device row (soft revoke)", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300040, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });

    const [device] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));

    await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);

    const [revoked] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.id, device.id));
    expect(revoked.revokedAt).toEqual(NOW);

    const sessions = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, device.id));
    expect(sessions).toHaveLength(0);
  });

  it("rejects revoking an unknown device", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await expect(
      revokeFleetDevice(ctx.db, "00000000-0000-0000-0000-000000000000", acc.id, NOW),
    ).rejects.toThrow(DeviceNotFoundError);
  });

  it("deletes seeded publisher leases and telemetry rows, not just sessions", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, { id: 92300041, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });

    const [device] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    const [session] = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, device.id));

    await ctx.db.insert(fleetPublisherLease).values({
      characterId: ch.id,
      deviceId: device.id,
      sessionId: session.id,
      fleetId: 5200001,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    await ctx.db.insert(fleetTelemetryRow).values({
      characterId: ch.id,
      fleetId: 5200001,
      deviceId: device.id,
      sessionId: session.id,
      dps: 100,
      ewar: [],
      receivedAt: NOW,
      staleAt: new Date(NOW.getTime() + 3_000),
      hardExpiresAt: new Date(NOW.getTime() + 10_000),
    });

    await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);

    expect(
      await ctx.db
        .select()
        .from(fleetPublisherLease)
        .where(eq(fleetPublisherLease.deviceId, device.id)),
    ).toHaveLength(0);
    expect(
      await ctx.db
        .select()
        .from(fleetTelemetryRow)
        .where(eq(fleetTelemetryRow.deviceId, device.id)),
    ).toHaveLength(0);
  });
});

describe("revokeFleetRelayForAccount", () => {
  it("revokes every device on the account and deletes their sessions, without logging audit", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300050, accountId: acc.id });

    const keyA = newKeyPair();
    const keyB = newKeyPair();
    const beginA = await beginPairing(ctx.db, { publicKeySpki: keyA.spki, now: NOW });
    await approvePairing(ctx.db, beginA.pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId: beginA.pairingId,
      completionSignature: signCompletion(keyA.privateKey, beginA.pairingId),
      now: NOW,
    });
    const beginB = await beginPairing(ctx.db, { publicKeySpki: keyB.spki, now: NOW });
    await approvePairing(ctx.db, beginB.pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId: beginB.pairingId,
      completionSignature: signCompletion(keyB.privateKey, beginB.pairingId),
      now: NOW,
    });

    const before = await ctx.db.select().from(auditLog);

    await revokeFleetRelayForAccount(ctx.db, acc.id, NOW);

    const devices = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    expect(devices).toHaveLength(2);
    for (const d of devices) {
      expect(d.revokedAt).toEqual(NOW);
      const sessions = await ctx.db
        .select()
        .from(fleetDeviceSession)
        .where(eq(fleetDeviceSession.deviceId, d.id));
      expect(sessions).toHaveLength(0);
    }

    const after = await ctx.db.select().from(auditLog);
    expect(after).toHaveLength(before.length);
  });
});

describe("audit logging", () => {
  it("logs only pairing approval and device revocation, never begin or complete", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300060, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();

    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    expect(await auditRowsFor(ctx.db, pairingId)).toHaveLength(0);

    await approvePairing(ctx.db, pairingId, acc.id, NOW);
    const approvalRows = await auditRowsFor(ctx.db, pairingId);
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]).toMatchObject({
      actor: acc.id,
      action: "fleet_device.pairing_approved",
      target: pairingId,
    });

    await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });
    expect(await auditRowsFor(ctx.db, pairingId)).toHaveLength(1); // unchanged

    const [device] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);
    const revokeRows = await auditRowsFor(ctx.db, device.id);
    expect(revokeRows).toHaveLength(1);
    expect(revokeRows[0]).toMatchObject({
      actor: acc.id,
      action: "fleet_device.revoked",
      target: device.id,
    });
  });
});

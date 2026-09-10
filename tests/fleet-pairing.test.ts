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
  RelayContentionError,
  RevokedDeviceKeyError,
  approvePairing,
  beginPairing,
  completePairing,
  pairingChallengePreimage,
  renewFleetDeviceSession,
  revokeFleetDevice,
  revokeFleetRelayForAccount,
  listFleetDevicesForAccount,
} from "@/services/fleet-pairing";
import { setupTestDb } from "./helpers/db";
import { withInjectedPgFault } from "./helpers/pg-fault";
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

  it("refuses approval early when the pairing request's key is already bound to an ACTIVE device on a different account, before any browser sees a false 'Approved' state", async () => {
    const accA = await seedAccount(ctx.db, { tier: "member" });
    const accB = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300073, accountId: accA.id });
    const { spki, privateKey } = newKeyPair();

    const first = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, first.pairingId, accA.id, NOW);
    await completePairing(ctx.db, {
      pairingId: first.pairingId,
      completionSignature: signCompletion(privateKey, first.pairingId),
      now: NOW,
    });

    // A second pairing request for the SAME (now actively-bound) key is
    // refused at APPROVAL, not left to fail later at completion.
    const second = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await expect(approvePairing(ctx.db, second.pairingId, accB.id, NOW)).rejects.toThrow(
      DeviceBoundToAnotherAccountError,
    );

    // Refused before any mutation: the request is still pending, not approved.
    const [secondRow] = await ctx.db
      .select()
      .from(fleetPairingRequest)
      .where(eq(fleetPairingRequest.id, second.pairingId));
    expect(secondRow.approvedAt).toBeNull();
    expect(secondRow.approvedAccountId).toBeNull();

    // A same-account re-approval of a fresh request for its OWN key is
    // unaffected -- the comparison is against THIS account, not "any".
    const third = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await expect(
      approvePairing(ctx.db, third.pairingId, accA.id, NOW),
    ).resolves.toBeUndefined();
  });

  it("refuses completion when the approving account no longer matches the device's account by completion time (approved before a concurrent pairing bound the key elsewhere), leaving the existing device/session/account binding unchanged", async () => {
    const accA = await seedAccount(ctx.db, { tier: "member" });
    const accB = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300070, accountId: accA.id });
    await seedCharacter(ctx.db, cfg, { id: 92300071, accountId: accB.id });
    const { spki, privateKey } = newKeyPair();

    // Two pairing requests for the SAME key, both approved while the key is
    // still unbound to anyone (approvePairing's early check cannot yet see a
    // conflict, since no device row exists until the FIRST one completes) --
    // exactly the race completePairing's own recheck exists to close.
    const first = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    const second = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, first.pairingId, accA.id, NOW);
    await approvePairing(ctx.db, second.pairingId, accB.id, NOW);

    const { sessionId: originalSessionId } = await completePairing(ctx.db, {
      pairingId: first.pairingId,
      completionSignature: signCompletion(privateKey, first.pairingId),
      now: NOW,
    });
    const [deviceBefore] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.publicKeySpkiB64, canonicalDevicePublicKeyB64(spki)));

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

  it.each([true, false])(
    "legacy completion refuses revocation even if approval was written before revoke=%s",
    async (approvedBeforeRevoke) => {
      const acc = await seedAccount(ctx.db, { tier: "member" });
      await seedCharacter(ctx.db, cfg, {
        id: approvedBeforeRevoke ? 92300080 : 92300081,
        accountId: acc.id,
      });
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

      expect(device.revokedAt).toBeNull();
      expect(
        await ctx.db
          .select()
          .from(fleetDeviceSession)
          .where(eq(fleetDeviceSession.deviceId, device.id)),
      ).toHaveLength(1);
      // The request predates revocation. Pending/off approval may still write
      // approvedAt from a stale page; this test preserves that service contract
      // while pinning completion as the no-resurrection boundary in both orders.
      const second = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
      if (approvedBeforeRevoke)
        await approvePairing(ctx.db, second.pairingId, acc.id, NOW);
      await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);
      if (!approvedBeforeRevoke)
        await approvePairing(ctx.db, second.pairingId, acc.id, NOW);

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
      expect(secondRow).toMatchObject({
        approvedAt: NOW,
        approvedAccountId: acc.id,
        consumedAt: null,
        approvedDeviceId: null,
        requestedCapabilities: [],
      });
      expect(
        await ctx.db.select().from(fleetDevice).where(eq(fleetDevice.accountId, acc.id)),
      ).toEqual([{ ...device, revokedAt: NOW }]);
      expect(
        await ctx.db
          .select()
          .from(fleetDeviceSession)
          .where(eq(fleetDeviceSession.deviceId, device.id)),
      ).toEqual([]);
    },
  );
});

describe("listFleetDevicesForAccount", () => {
  it("returns an empty list for an account with no paired devices", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    expect(await listFleetDevicesForAccount(ctx.db, acc.id)).toEqual([]);
  });

  it("lists a paired device with its paired-at time and its session's expiry", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
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

    const list = await listFleetDevicesForAccount(ctx.db, acc.id);

    expect(list).toEqual([
      { id: device.id, pairedAt: device.createdAt, sessionExpiresAt: session.expiresAt },
    ]);
  });

  it("never lists a revoked device, even though its row survives the revoke", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
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

    expect(await listFleetDevicesForAccount(ctx.db, acc.id)).toEqual([]);
  });

  it("never lists another account's device", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const other = await seedAccount(ctx.db, { tier: "member" });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, other.id, NOW);
    await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });

    expect(await listFleetDevicesForAccount(ctx.db, acc.id)).toEqual([]);
  });

  it("reports the LATEST of a device's several accumulated sessions, not merely the first or the last inserted", async () => {
    // A device can accumulate more than one session row across its lifetime
    // (completePairing reuses an existing, un-revoked device across a
    // re-pairing rather than deleting its prior session first) — this test's
    // own reason this function reads the union rather than assuming one row.
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { spki, privateKey } = newKeyPair();
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

    // A second pairing cycle for the SAME device key, completed later —
    // idempotent reuse of the existing device row, per completePairing's own
    // doc — inserts a SECOND, later-expiring session alongside the first.
    const later = new Date(NOW.getTime() + 60_000);
    const second = await beginPairing(ctx.db, { publicKeySpki: spki, now: later });
    await approvePairing(ctx.db, second.pairingId, acc.id, later);
    await completePairing(ctx.db, {
      pairingId: second.pairingId,
      completionSignature: signCompletion(privateKey, second.pairingId),
      now: later,
    });

    const sessions = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, device.id));
    expect(sessions).toHaveLength(2);
    const latestExpiry = sessions
      .map((s) => s.expiresAt.getTime())
      .reduce((a, b) => Math.max(a, b));

    const [listed] = await listFleetDevicesForAccount(ctx.db, acc.id);
    expect(listed.sessionExpiresAt?.getTime()).toBe(latestExpiry);
  });

  it("orders devices oldest-paired-first", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const first = newKeyPair();
    const secondKey = newKeyPair();
    const firstPairing = await beginPairing(ctx.db, {
      publicKeySpki: first.spki,
      now: NOW,
    });
    await approvePairing(ctx.db, firstPairing.pairingId, acc.id, NOW);
    await completePairing(ctx.db, {
      pairingId: firstPairing.pairingId,
      completionSignature: signCompletion(first.privateKey, firstPairing.pairingId),
      now: NOW,
    });
    const later = new Date(NOW.getTime() + 60_000);
    const secondPairing = await beginPairing(ctx.db, {
      publicKeySpki: secondKey.spki,
      now: later,
    });
    await approvePairing(ctx.db, secondPairing.pairingId, acc.id, later);
    await completePairing(ctx.db, {
      pairingId: secondPairing.pairingId,
      completionSignature: signCompletion(secondKey.privateKey, secondPairing.pairingId),
      now: later,
    });

    const list = await listFleetDevicesForAccount(ctx.db, acc.id);

    // `fleetDevice.createdAt` is DB-generated (`defaultNow()`), not the
    // `now` argument threaded through pairing — so this asserts relative
    // insertion order, not exact instants.
    expect(list).toHaveLength(2);
    expect(list[0].pairedAt.getTime()).toBeLessThan(list[1].pairedAt.getTime());
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

  it("throws RelayContentionError, not a raw driver error, when its transaction hits a synthetic deadlock", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    await seedCharacter(ctx.db, cfg, { id: 92300042, accountId: acc.id });
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

    await expect(
      withInjectedPgFault(ctx.pool, { matchSql: /^\s*select/i, code: "40P01" }, () =>
        revokeFleetDevice(ctx.db, device.id, acc.id, NOW),
      ),
    ).rejects.toThrow(RelayContentionError);

    // Nothing was left half-mutated: the transaction rolled back.
    const [unchanged] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.id, device.id));
    expect(unchanged.revokedAt).toBeNull();
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
  it("logs pairing approval, pairing completion (targeting the device, not the pairing request) and device revocation, but never begin", async () => {
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
    // Completion's own audit row targets the DEVICE, not the pairing
    // request — the pairing request's own target-keyed history stays
    // exactly what approval left it (this is the retained approval audit,
    // unchanged by this fix).
    expect(await auditRowsFor(ctx.db, pairingId)).toHaveLength(1);

    const [device] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    const completionRows = await auditRowsFor(ctx.db, device.id);
    expect(completionRows).toHaveLength(1);
    expect(completionRows[0]).toMatchObject({
      actor: acc.id,
      action: "fleet_device.pairing_completed",
      target: device.id,
    });

    await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);
    const deviceRows = await auditRowsFor(ctx.db, device.id);
    expect(deviceRows).toHaveLength(2); // completion, then revocation
    const revokeRow = deviceRows.find((r) => r.action === "fleet_device.revoked");
    expect(revokeRow).toMatchObject({
      actor: acc.id,
      action: "fleet_device.revoked",
      target: device.id,
    });
  });
});

describe("renewFleetDeviceSession", () => {
  // Duplicated from fleet-pairing.ts's own private DEVICE_SESSION_TTL_MS,
  // the same "not exported, both copies independently agree" convention
  // fleet-relay.ts's MAX_REVISION comment documents.
  const DEVICE_SESSION_TTL_MS = 30 * 60 * 1000;

  it("extends the SAME session's expiresAt by a full window from now, and leaves its live telemetry/lease rows (same session id) completely untouched", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const ch = await seedCharacter(ctx.db, cfg, { id: 92300180, accountId: acc.id });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);
    const { sessionId } = await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });
    const [deviceRow] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    const [sessionBefore] = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, deviceRow.id));

    // A live lease + telemetry row bound to THIS session -- renewal extending
    // the session in place, rather than replacing it, must never cascade
    // these away (the whole point of "extend, don't rotate").
    await ctx.db.insert(fleetPublisherLease).values({
      characterId: ch.id,
      deviceId: deviceRow.id,
      sessionId: sessionBefore.id,
      fleetId: 5200010,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });
    await ctx.db.insert(fleetTelemetryRow).values({
      characterId: ch.id,
      fleetId: 5200010,
      deviceId: deviceRow.id,
      sessionId: sessionBefore.id,
      dps: 250,
      ewar: [],
      receivedAt: NOW,
      staleAt: new Date(NOW.getTime() + 3_000),
      hardExpiresAt: new Date(NOW.getTime() + 10_000),
    });

    const renewAt = new Date(NOW.getTime() + 25 * 60 * 1000); // near the old cliff
    const result = await renewFleetDeviceSession(ctx.db, {
      sessionId,
      revision: 1,
      now: renewAt,
    });
    expect(result).toEqual({
      ok: true,
      expiresAt: new Date(renewAt.getTime() + DEVICE_SESSION_TTL_MS),
    });

    const [sessionAfter] = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, deviceRow.id));
    expect(sessionAfter.id).toBe(sessionBefore.id); // same session, not rotated
    expect(sessionAfter.expiresAt).toEqual(
      new Date(renewAt.getTime() + DEVICE_SESSION_TTL_MS),
    );
    expect(sessionAfter.lastRevision).toBe(1);
    expect(sessionAfter.lastReadAt).toEqual(renewAt);

    // Still exactly the same lease/telemetry rows, same session id -- no
    // cascade-driven flicker.
    const [lease] = await ctx.db
      .select()
      .from(fleetPublisherLease)
      .where(eq(fleetPublisherLease.characterId, ch.id));
    const [telemetry] = await ctx.db
      .select()
      .from(fleetTelemetryRow)
      .where(eq(fleetTelemetryRow.characterId, ch.id));
    expect(lease.sessionId).toBe(sessionBefore.id);
    expect(telemetry.sessionId).toBe(sessionBefore.id);
  });

  it("rejects a replayed (non-increasing) revision, and shares its read cadence bucket with readFleetProjection", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);
    const { sessionId } = await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });

    const first = await renewFleetDeviceSession(ctx.db, {
      sessionId,
      revision: 1,
      now: NOW,
    });
    expect(first.ok).toBe(true);

    const replay = await renewFleetDeviceSession(ctx.db, {
      sessionId,
      revision: 1,
      now: new Date(NOW.getTime() + 600),
    });
    expect(replay).toEqual({ ok: false, code: "revision_replayed" });

    // Too soon (within the shared 500ms read-cadence bucket) even with a
    // strictly greater revision.
    const tooSoon = await renewFleetDeviceSession(ctx.db, {
      sessionId,
      revision: 2,
      now: new Date(NOW.getTime() + 100),
    });
    expect(tooSoon).toEqual({ ok: false, code: "rate_limited" });

    const later = await renewFleetDeviceSession(ctx.db, {
      sessionId,
      revision: 2,
      now: new Date(NOW.getTime() + 600),
    });
    expect(later.ok).toBe(true);
  });

  it("rejects with invalid_session for an unknown session and for a revoked device's session", async () => {
    const unknown = await renewFleetDeviceSession(ctx.db, {
      sessionId: "not-a-real-session-id",
      revision: 1,
      now: NOW,
    });
    expect(unknown).toEqual({ ok: false, code: "invalid_session" });

    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);
    const { sessionId } = await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });
    const [device] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    await revokeFleetDevice(ctx.db, device.id, acc.id, NOW);

    const afterRevoke = await renewFleetDeviceSession(ctx.db, {
      sessionId,
      revision: 1,
      now: NOW,
    });
    expect(afterRevoke).toEqual({ ok: false, code: "invalid_session" });
  });

  it("rejects with not_eligible, mutating nothing, once the account has dropped below Member tier", async () => {
    const acc = await seedAccount(ctx.db, { tier: "member" });
    const { spki, privateKey } = newKeyPair();
    const { pairingId } = await beginPairing(ctx.db, { publicKeySpki: spki, now: NOW });
    await approvePairing(ctx.db, pairingId, acc.id, NOW);
    const { sessionId } = await completePairing(ctx.db, {
      pairingId,
      completionSignature: signCompletion(privateKey, pairingId),
      now: NOW,
    });

    await ctx.db.update(account).set({ tier: "associate" }).where(eq(account.id, acc.id));

    const result = await renewFleetDeviceSession(ctx.db, {
      sessionId,
      revision: 1,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, code: "not_eligible" });

    const [device] = await ctx.db
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.accountId, acc.id));
    const [sessionAfter] = await ctx.db
      .select()
      .from(fleetDeviceSession)
      .where(eq(fleetDeviceSession.deviceId, device.id));
    expect(sessionAfter.lastRevision).toBe(0);
    expect(sessionAfter.lastReadAt).toBeNull();
  });
});

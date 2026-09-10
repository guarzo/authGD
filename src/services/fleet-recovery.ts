import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, count, eq, gt, sql } from "drizzle-orm";
import type { Dbx } from "@/db";
import type { FleetReply, RecoveryResult } from "@/core/fleet-sharing";
import { getConfig } from "@/config";
import {
  account,
  fleetDevice,
  fleetDeviceKeyIdentity,
  fleetDeviceSession,
  fleetRecoveryChallenge,
} from "@/db/schema";
import {
  canonicalBase64url,
  recoveryInitiationFresh,
  verifyRecoveryInitiation,
  verifyRecoveryProof,
} from "@/lib/fleet-recovery-proof";
import { normalizeDevicePublicKeyB64 } from "@/lib/fleet-signature";
import { logAudit } from "@/services/audit";
import {
  deleteFleetRelayStateForDevice,
  DEVICE_SESSION_TTL_MS,
} from "@/services/fleet-pairing";
import {
  boundFleetRecoveryWaits,
  fleetDatabaseNow,
  lockFleetDeviceKey,
} from "@/services/fleet-key-identity";
import { lockFleetSharingMode } from "@/services/fleet-sharing-mode";
import { isRetryableRelayError, RelayRefusal } from "@/services/fleet-relay";

const RECOVERY_TTL_MS = 120000;
const MAX_CHALLENGES = 1024;
const MAX_CHALLENGES_PER_KEY = 4;
const CLEANUP_BATCH = 100;
const digest = (raw: string) => createHash("sha256").update(raw).digest("base64url");
const origin = () => new URL(getConfig().appBaseUrl).origin;

/** Nonce secrecy is not authorization. A random server UUID plus this fixed
 * preimage reproduces an idempotent response without storing plaintext nonce. */
function recoveryNonce(challengeId: string, requestId: string, key: string): string {
  return digest(
    [
      "fleet-recovery-nonce-v1",
      origin(),
      challengeId,
      requestId,
      createHash("sha256").update(Buffer.from(key, "base64")).digest("hex"),
    ].join("\n"),
  );
}

/** Independent of mode. Cleanup never waits on completion or frees consumed
 * rows early: retention closes replay after the initiation freshness deadline. */
export async function purgeExpiredFleetRecovery(dbx: Dbx, now: Date): Promise<number> {
  const result = await dbx.execute(sql`
    delete from fleet_recovery_challenge where id in (
      select id from fleet_recovery_challenge where expires_at <= ${now}
      order by expires_at, id limit ${CLEANUP_BATCH} for update skip locked
    )`);
  return result.rowCount ?? 0;
}

export async function beginFleetRecovery(
  dbx: Dbx,
  args: {
    publicKeySpki: Uint8Array;
    requestId: string;
    issuedAt: string;
    initiationSignature: string;
    now?: Date;
  },
): Promise<{ challengeId: string; nonce: string; expiresAt: Date; requestId: string }> {
  const canonicalKey = normalizeDevicePublicKeyB64(args.publicKeySpki);
  // Verify before any registry lookup, identity lock or quota work. Arbitrary
  // public keys (even legitimately signed unknown keys) reserve no capacity.
  if (
    !canonicalKey ||
    !recoveryInitiationFresh(args.issuedAt, args.now ?? new Date()) ||
    !verifyRecoveryInitiation(
      {
        canonicalOrigin: origin(),
        requestId: args.requestId,
        issuedAt: args.issuedAt,
        publicKeySpkiB64: canonicalKey,
      },
      args.initiationSignature,
    )
  )
    throw new RelayRefusal("unauthorized");
  return dbx.transaction(async (tx) => {
    await boundFleetRecoveryWaits(tx);
    const mode = await lockFleetSharingMode(tx);
    if (!mode.enabled || mode.keyIdentityPhase !== "ready")
      throw new RelayRefusal("feature_disabled");
    await lockFleetDeviceKey(tx, canonicalKey);
    const [identity] = await tx
      .select()
      .from(fleetDeviceKeyIdentity)
      .where(eq(fleetDeviceKeyIdentity.canonicalSpkiB64, canonicalKey));
    if (!identity || (!identity.conflicted && !identity.deviceId))
      throw new RelayRefusal("unauthorized");
    // Class 4 admission follows proof + registered identity + class 5 key. Never
    // acquired by completion; SKIP LOCKED cleanup cannot invert that ordering.
    await tx.execute(sql`select pg_advisory_xact_lock(4, 0)`);
    const [prior] = await tx
      .select()
      .from(fleetRecoveryChallenge)
      .where(
        and(
          eq(fleetRecoveryChallenge.publicKeySpkiB64, canonicalKey),
          eq(fleetRecoveryChallenge.requestId, args.requestId),
        ),
      );
    const now = await fleetDatabaseNow(tx, args.now);
    if (!recoveryInitiationFresh(args.issuedAt, now))
      throw new RelayRefusal("unauthorized");
    if (prior) {
      if (
        prior.requestIssuedAt?.toISOString() !== args.issuedAt ||
        prior.consumedAt !== null ||
        prior.expiresAt.getTime() <= now.getTime()
      )
        throw new RelayRefusal("unauthorized");
      return {
        challengeId: prior.id,
        nonce: recoveryNonce(prior.id, args.requestId, canonicalKey),
        expiresAt: prior.expiresAt,
        requestId: args.requestId,
      };
    }
    await purgeExpiredFleetRecovery(tx, now);
    const [global] = await tx.select({ n: count() }).from(fleetRecoveryChallenge);
    const [key] = await tx
      .select({ n: count() })
      .from(fleetRecoveryChallenge)
      .where(
        and(
          eq(fleetRecoveryChallenge.publicKeySpkiB64, canonicalKey),
          gt(fleetRecoveryChallenge.expiresAt, now),
        ),
      );
    if (global.n >= MAX_CHALLENGES || key.n >= MAX_CHALLENGES_PER_KEY)
      throw new RelayRefusal("rate_limited");
    // Cleanup/queries may wait too. No stale captured proof can insert after its
    // exclusive deadline, even if it passed initial validation before contention.
    const issuedNow = await fleetDatabaseNow(tx, args.now);
    if (!recoveryInitiationFresh(args.issuedAt, issuedNow))
      throw new RelayRefusal("unauthorized");
    const challengeId = randomUUID();
    const nonce = recoveryNonce(challengeId, args.requestId, canonicalKey);
    const expiresAt = new Date(issuedNow.getTime() + RECOVERY_TTL_MS);
    await tx.insert(fleetRecoveryChallenge).values({
      id: challengeId,
      publicKeySpkiB64: canonicalKey,
      requestId: args.requestId,
      requestIssuedAt: new Date(args.issuedAt),
      nonceDigest: digest(nonce),
      createdAt: issuedNow,
      expiresAt,
    });
    return { challengeId, nonce, expiresAt, requestId: args.requestId };
  });
}

type Completion = {
  challengeId: string;
  nonce: string;
  recoverySignature: string;
  now?: Date;
};
type Challenge = typeof fleetRecoveryChallenge.$inferSelect;
function provesChallenge(
  challenge: Challenge | undefined,
  args: Completion,
): challenge is Challenge {
  return (
    !!challenge &&
    challenge.requestId !== null &&
    challenge.requestIssuedAt !== null &&
    challenge.consumedAt === null &&
    canonicalBase64url(args.nonce, 43) &&
    digest(args.nonce) === challenge.nonceDigest &&
    verifyRecoveryProof(
      {
        canonicalOrigin: origin(),
        challengeId: challenge.id,
        nonce: args.nonce,
        publicKeySpkiB64: challenge.publicKeySpkiB64,
      },
      args.recoverySignature,
    )
  );
}

/** Mode -> canonical key -> challenge -> account -> device -> sessions -> ascending
 * characters. Invalid proof never mutates anything and never enters this lock
 * path. Valid proof consumes OUTSIDE issuance savepoint; outer failures cannot
 * promise durable consumption and remain generic transport errors. */
export async function completeFleetRecovery(
  dbx: Dbx,
  args: Completion,
): Promise<FleetReply<RecoveryResult>> {
  const unauthorized = { ok: false, code: "unauthorized" } as const;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      args.challengeId,
    )
  )
    return unauthorized;
  return dbx.transaction(async (tx): Promise<FleetReply<RecoveryResult>> => {
    await boundFleetRecoveryWaits(tx);
    const [snapshot] = await tx
      .select()
      .from(fleetRecoveryChallenge)
      .where(eq(fleetRecoveryChallenge.id, args.challengeId));
    if (!provesChallenge(snapshot, args)) return unauthorized;
    const mode = await lockFleetSharingMode(tx);
    if (!mode.enabled || mode.keyIdentityPhase !== "ready")
      return { ok: false, code: "feature_disabled" };
    await lockFleetDeviceKey(tx, snapshot.publicKeySpkiB64);
    const [challenge] = await tx
      .select()
      .from(fleetRecoveryChallenge)
      .where(eq(fleetRecoveryChallenge.id, args.challengeId))
      .for("update");
    const proofNow = await fleetDatabaseNow(tx, args.now);
    if (
      !provesChallenge(challenge, args) ||
      challenge.publicKeySpkiB64 !== snapshot.publicKeySpkiB64 ||
      challenge.expiresAt.getTime() <= proofNow.getTime()
    )
      return unauthorized;
    await tx
      .update(fleetRecoveryChallenge)
      .set({ consumedAt: proofNow })
      .where(eq(fleetRecoveryChallenge.id, challenge.id));
    try {
      return await tx.transaction(
        async (issuance): Promise<FleetReply<RecoveryResult>> => {
          const [identity] = await issuance
            .select()
            .from(fleetDeviceKeyIdentity)
            .where(
              eq(fleetDeviceKeyIdentity.canonicalSpkiB64, challenge.publicKeySpkiB64),
            );
          if (identity?.conflicted)
            return { ok: true, value: { result: "device_key_conflict" } };
          if (!identity?.deviceId) return unauthorized;
          const [selector] = await issuance
            .select({ accountId: fleetDevice.accountId })
            .from(fleetDevice)
            .where(eq(fleetDevice.id, identity.deviceId));
          if (!selector) return unauthorized;
          const [owner] = await issuance
            .select({ tier: account.tier })
            .from(account)
            .where(eq(account.id, selector.accountId))
            .for("update");
          const [device] = await issuance
            .select()
            .from(fleetDevice)
            .where(eq(fleetDevice.id, identity.deviceId))
            .for("update");
          const [current] = await issuance
            .select()
            .from(fleetDeviceKeyIdentity)
            .where(
              eq(fleetDeviceKeyIdentity.canonicalSpkiB64, challenge.publicKeySpkiB64),
            );
          const now = await fleetDatabaseNow(issuance, args.now);
          if (
            challenge.expiresAt.getTime() <= now.getTime() ||
            !device ||
            !current ||
            current.conflicted ||
            current.deviceId !== device.id ||
            device.accountId !== selector.accountId
          )
            return unauthorized;
          if (device.revokedAt !== null)
            return { ok: true, value: { result: "device_revoked" } };
          if (owner?.tier !== "member")
            return {
              ok: true,
              value: { result: "account_ineligible", retryAfterMs: 60000 },
            };
          await deleteFleetRelayStateForDevice(issuance, device.id);
          const issuedAt = await fleetDatabaseNow(issuance, args.now);
          if (challenge.expiresAt.getTime() <= issuedAt.getTime())
            throw new RelayRefusal("unauthorized");
          const sessionId = randomBytes(32).toString("base64url");
          const sessionExpiresAt = new Date(issuedAt.getTime() + DEVICE_SESSION_TTL_MS);
          await issuance.insert(fleetDeviceSession).values({
            id: digest(sessionId),
            deviceId: device.id,
            expiresAt: sessionExpiresAt,
            approvedCapabilities: device.approvedCapabilities,
          });
          await logAudit(issuance, {
            actor: device.accountId,
            action: "fleet_device.session_recovered",
            target: device.id,
          });
          return {
            ok: true,
            value: {
              result: "reconnected",
              deviceId: device.id,
              sessionId,
              sessionExpiresAt,
              approvedCapabilities: device.approvedCapabilities,
              participation: {
                enabled: device.participationEnabled,
                generation: device.participationGeneration,
              },
            },
          };
        },
      );
    } catch (err) {
      if (err instanceof RelayRefusal) return unauthorized;
      // A timeout is transport-retry, not a claimed durable proof outcome.
      if (isTimeout(err)) throw err;
      if (!isRetryableRelayError(err)) console.error("fleet recovery issuance failed");
      return { ok: true, value: { result: "retry_later", retryAfterMs: 1000 } };
    }
  });
}

function isTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ("code" in err && (err.code === "55P03" || err.code === "57014")) return true;
  return "cause" in err && isTimeout(err.cause);
}

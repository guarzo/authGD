import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as ed25519Verify,
} from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Dbx, DbTx } from "@/db";
import {
  account,
  fleetDevice,
  fleetDeviceSession,
  fleetPairingRequest,
  fleetPublisherLease,
  fleetTelemetryRow,
} from "@/db/schema";
import {
  canonicalDevicePublicKeyB64,
  decodeDevicePublicKeyB64,
  isEd25519SpkiPublicKey,
} from "@/lib/fleet-signature";
import { logAudit } from "@/services/audit";
import { buildDeviceCatalogue, type DeviceCatalogue } from "@/services/fleet-eligibility";
import {
  gateSignedSession,
  isRetryableRelayError,
  lockFleetCharactersAscending,
  RelayRefusal,
} from "@/services/fleet-relay";

export class PairingNotFoundError extends Error {}
export class PairingExpiredError extends Error {}
export class PairingAlreadyApprovedError extends Error {}
export class PairingAlreadyConsumedError extends Error {}
export class PairingNotApprovedError extends Error {}
/** Thrown by `approvePairing` for any account that is not a CURRENT,
 *  Member-tier account — deliberately one error for "no such account" and
 *  "wrong tier", since both mean the same thing to the caller: this account
 *  may not approve a pairing. `completePairing` throws the SAME error when
 *  its transactional recheck finds the previously-approving account no
 *  longer current/Member-tier by completion time — the underlying condition
 *  (this account may not vouch for a device pairing) is identical either
 *  way. */
export class NonMemberApprovalError extends Error {}
export class InvalidCompletionProofError extends Error {}
/** A candidate public key is not valid Ed25519 SPKI DER. Thrown by
 *  `beginPairing` before the key is canonicalized, persisted, or offered to
 *  a browser for approval — a malformed/garbage/wrong-algorithm key never
 *  reaches storage or creates a pairing request at all. */
export class InvalidDevicePublicKeyError extends Error {}
/** A candidate/stored public key belongs to a device whose `revokedAt` is
 *  set. Permanent by design: re-pairing requires a brand
 *  new locally generated key pair, never reuse of the revoked one. */
export class RevokedDeviceKeyError extends Error {}
/** An active (non-revoked) device key is bound permanently to whichever
 *  account first completed a pairing with it. Thrown by `completePairing`
 *  when the request being completed was approved by a DIFFERENT account
 *  than the one already bound to this key — a stable, permanent refusal
 *  (controller security ruling): the existing device's account, sessions,
 *  and relay state are left completely unchanged, and there is no way to
 *  move a bound key to another account short of revoking it and pairing a
 *  freshly generated one. */
export class DeviceBoundToAnotherAccountError extends Error {}
export class DeviceNotFoundError extends Error {}
/** Thrown when a device/session-lifecycle write (revoke, account-wide relay
 *  teardown) collides with a concurrent operation Postgres reports as a
 *  deadlock or serialization failure (`fleet-relay.ts`'s
 *  `isRetryableRelayError`) rather than a real business-rule refusal — the
 *  whole call should simply be retried, not treated as permanent. Every
 *  other error class in this file means "this exact request can never
 *  succeed as given"; this one means the opposite. */
export class RelayContentionError extends Error {}

/** How long an unapproved/unconsumed pairing request stays alive, mirroring
 *  `src/services/oauth-tx.ts`'s TTL for the same kind of short-lived,
 *  browser-round-trip flow. */
const PAIRING_REQUEST_TTL_MS = 10 * 60 * 1000;
/** A device session's lifetime, both freshly issued (`completePairing`) and
 *  renewed in place (`renewFleetDeviceSession`). */
const DEVICE_SESSION_TTL_MS = 30 * 60 * 1000;

const PAIRING_CHALLENGE_PREFIX = "fleet-pairing-v1";

/**
 * The exact bytes a device must sign to prove possession of the private key
 * behind its pairing request's candidate SPKI public key.
 *
 * Deterministic from `pairingId` alone — there is no server-issued nonce
 * that round-trips back to the device separately, because the device
 * already learns `pairingId` from its own `beginPairing` call and needs
 * nothing else to reconstruct this. Versioned by the leading tag line,
 * mirroring `fleet-signature.ts`'s `fleet-v<protocol>` convention: a future
 * change to this shape is a new prefix, never a silent reinterpretation of
 * this one. Exported so this repo's routes and the Wingman client build
 * the identical bytes rather than re-deriving the convention by reading this
 * file's internals.
 */
export function pairingChallengePreimage(pairingId: string): Buffer {
  return Buffer.from(`${PAIRING_CHALLENGE_PREFIX}\n${pairingId}`, "utf8");
}

function challengeDigestFor(pairingId: string): string {
  return createHash("sha256")
    .update(pairingChallengePreimage(pairingId))
    .digest("base64url");
}

/** Opaque bearer values (pairing challenge preimage aside — that one is
 *  signed, not presented back) are hashed with SHA-256 before storage, the
 *  same convention `src/services/session.ts`'s `sessionKey()` uses. */
function hashOpaqueValue(raw: string): string {
  return createHash("sha256").update(raw).digest("base64url");
}

// Ed25519 signatures are always 64 bytes; base64url without padding encodes
// that as exactly 86 characters — the same shape `fleet-signature.ts`'s
// SIGNATURE_RE checks for the relay request signature.
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

/**
 * Verifies `completionSignature` proves possession of the private key behind
 * `publicKeySpkiB64` (the pairing request's own stored, canonical public
 * key) over this pairing's challenge pre-image. Mirrors
 * `verifyFleetRequest`'s defensive shape (`src/lib/fleet-signature.ts`):
 * reject a malformed signature shape before touching `crypto` at all, reject
 * a non-Ed25519 key outright via the shared `isEd25519SpkiPublicKey` check,
 * and treat any parse/verify exception as an unproven signature rather than
 * letting it escape uncaught.
 */
function verifyCompletionProof(
  publicKeySpkiB64: string,
  pairingId: string,
  completionSignature: string,
): boolean {
  if (!SIGNATURE_RE.test(completionSignature)) return false;

  const spki = decodeDevicePublicKeyB64(publicKeySpkiB64);
  // No dedicated outcome for "right key material, wrong algorithm" — a
  // paired device can only ever record an Ed25519 SPKI key (beginPairing
  // validates this before persisting), so a mismatched key type is exactly
  // as unproven as a bad signature.
  if (!isEd25519SpkiPublicKey(spki)) return false;

  try {
    const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    const signature = Buffer.from(completionSignature, "base64url");
    return ed25519Verify(null, pairingChallengePreimage(pairingId), key, signature);
  } catch {
    // Malformed/non-DER key bytes throw rather than returning false.
    return false;
  }
}

/**
 * Registers a device's candidate Ed25519 public key and opens a one-time
 * pairing request for a browser-signed-in account to approve.
 *
 * Rejects a candidate that does not parse as valid Ed25519 SPKI DER with a
 * stable `InvalidDevicePublicKeyError` BEFORE anything else runs — before
 * canonicalizing, before the revoked-key lookup, and before a row exists for
 * any browser to approve. Persists ONLY the key's
 * `canonicalDevicePublicKeyB64()` form — never the
 * caller-supplied encoding — so base64/base64url and padded/unpadded
 * spellings of the identical key always resolve to the same stored
 * identity. A key already recorded on a soft-revoked device is permanently
 * barred: this returns a stable refusal rather than silently reviving it,
 * and the caller must generate a new local key pair instead.
 */
export async function beginPairing(
  dbx: Dbx,
  args: { publicKeySpki: Uint8Array; now: Date },
): Promise<{ pairingId: string; approvalUrl: string }> {
  if (!isEd25519SpkiPublicKey(args.publicKeySpki)) {
    throw new InvalidDevicePublicKeyError(
      "candidate device public key is not valid Ed25519 SPKI DER",
    );
  }

  const canonicalKey = canonicalDevicePublicKeyB64(args.publicKeySpki);

  const [existingDevice] = await dbx
    .select({ revokedAt: fleetDevice.revokedAt })
    .from(fleetDevice)
    .where(eq(fleetDevice.publicKeySpkiB64, canonicalKey));
  if (existingDevice?.revokedAt != null) {
    throw new RevokedDeviceKeyError(
      "this device key was revoked and can never be reused; generate a new key pair",
    );
  }

  const pairingId = randomUUID();
  await dbx.insert(fleetPairingRequest).values({
    id: pairingId,
    publicKeySpkiB64: canonicalKey,
    challengeDigest: challengeDigestFor(pairingId),
    expiresAt: new Date(args.now.getTime() + PAIRING_REQUEST_TTL_MS),
  });

  return { pairingId, approvalUrl: `/fleet/pair/${pairingId}` };
}

/**
 * The browser-side approval step: a signed-in authGD account vouches for one
 * pending pairing request. Requires a CURRENT account at `tier === "member"`
 * — deliberately ignoring `status`/cryo, unlike `requirePayoutOperator`
 * (src/services/payouts.ts): a device pairing is vouched for by a human's
 * own current standing, not gated the same way an operator action is.
 *
 * A request may be approved exactly once: already-approved, already-consumed
 * (completed), and expired requests all refuse with a distinct, specific
 * error rather than collapsing into one generic failure.
 *
 * Also refuses EARLY — at approval, not only at `completePairing` — when the
 * request's own candidate key is already bound to an ACTIVE device owned by
 * a DIFFERENT account than the one approving now: `completePairing` already
 * refuses this permanently (`DeviceBoundToAnotherAccountError`, this file's
 * "bound to its first account" ruling), but deferring the news until
 * completion means the approving account sees a false "Approved" state on
 * `/fleet/pair/[id]` for a pairing that can never actually finish. Checked
 * here, not in `beginPairing`: `POST /pairing-requests` is unauthenticated by
 * design (Global Constraint), so there is no approving account yet for that
 * call to compare against — only once a browser account is in hand, at
 * approval, does "a different account" become answerable at all. A
 * same-account re-pair (the idempotent "device lost its session, still holds
 * its key" path) is unaffected: the comparison is against THIS account, so
 * it can only ever refuse a genuinely different one.
 */
export async function approvePairing(
  dbx: Dbx,
  pairingId: string,
  accountId: string,
  now: Date,
): Promise<void> {
  const [acc] = await dbx
    .select({ tier: account.tier })
    .from(account)
    .where(eq(account.id, accountId));
  if (!acc || acc.tier !== "member") {
    throw new NonMemberApprovalError(
      "only a current Member-tier account may approve a device pairing request",
    );
  }

  await dbx.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(fleetPairingRequest)
      .where(eq(fleetPairingRequest.id, pairingId))
      .for("update");
    if (!row) throw new PairingNotFoundError(`no fleet pairing request ${pairingId}`);
    if (row.consumedAt !== null) {
      throw new PairingAlreadyConsumedError(
        `fleet pairing request ${pairingId} was already completed`,
      );
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new PairingExpiredError(`fleet pairing request ${pairingId} has expired`);
    }
    if (row.approvedAt !== null) {
      throw new PairingAlreadyApprovedError(
        `fleet pairing request ${pairingId} was already approved`,
      );
    }

    const [existingDevice] = await tx
      .select({ accountId: fleetDevice.accountId, revokedAt: fleetDevice.revokedAt })
      .from(fleetDevice)
      .where(eq(fleetDevice.publicKeySpkiB64, row.publicKeySpkiB64));
    if (
      existingDevice &&
      existingDevice.revokedAt === null &&
      existingDevice.accountId !== accountId
    ) {
      throw new DeviceBoundToAnotherAccountError(
        "this device key is already bound to a different account and cannot be re-paired to another account",
      );
    }

    await tx
      .update(fleetPairingRequest)
      .set({ approvedAt: now, approvedAccountId: accountId })
      .where(eq(fleetPairingRequest.id, pairingId));

    await logAudit(tx, {
      actor: accountId,
      action: "fleet_device.pairing_approved",
      target: pairingId,
    });
  });
}

/**
 * The desktop-side completion step: proves possession of the pairing
 * request's public key, consumes the request exactly once, and creates the
 * device/session — all in one transaction. Returns only `sessionId` (the
 * raw opaque value; only its SHA-256 digest is ever persisted, matching
 * `src/services/session.ts`'s convention) and the approving account's
 * `DeviceCatalogue`.
 *
 * Rechecks, transactionally and with row locks, that the request's
 * approving account is STILL a current Member-tier account (membership can
 * change between `approvePairing` and this call) and mutates nothing if it
 * is not.
 *
 * A device key that is not yet on file is inserted fresh, bound to this
 * completion's approving account. One that already is on file — the same
 * local key pairing again for the SAME account (e.g. the app simply
 * reconnecting) — is reused rather than re-inserted, since the key's
 * uniqueness constraint would reject a second row outright; this reuse is
 * idempotent exactly because the existing binding is already correct. An
 * active key already bound to a DIFFERENT account is a permanent, stable
 * refusal (`DeviceBoundToAnotherAccountError`, controller security ruling):
 * an authGD account can never claim another account's already-paired
 * device by approving a fresh pairing request for the same key, and the
 * existing device's account/sessions/relay state are left untouched. A
 * revoked key's device row is never reused either way — permanently barred;
 * re-pairing needs a brand new local key pair.
 */
export async function completePairing(
  dbx: Dbx,
  args: { pairingId: string; completionSignature: string; now: Date },
): Promise<{ sessionId: string; catalogue: DeviceCatalogue }> {
  return dbx.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(fleetPairingRequest)
      .where(eq(fleetPairingRequest.id, args.pairingId))
      .for("update");
    if (!row) {
      throw new PairingNotFoundError(`no fleet pairing request ${args.pairingId}`);
    }
    if (row.consumedAt !== null) {
      throw new PairingAlreadyConsumedError(
        `fleet pairing request ${args.pairingId} was already completed`,
      );
    }
    if (row.expiresAt.getTime() <= args.now.getTime()) {
      throw new PairingExpiredError(
        `fleet pairing request ${args.pairingId} has expired`,
      );
    }
    if (row.approvedAt === null || row.approvedAccountId === null) {
      throw new PairingNotApprovedError(
        `fleet pairing request ${args.pairingId} has not been approved yet`,
      );
    }
    const approvedAccountId = row.approvedAccountId;

    // Controller security ruling: recheck the approving account is STILL a
    // current Member-tier account at completion time, not just at approval
    // time — locked (`for("update")`) inside this same transaction so a
    // concurrent tier change cannot race past it. No write has happened yet
    // on this path, so a refusal here mutates nothing.
    const [approvingAccount] = await tx
      .select({ tier: account.tier })
      .from(account)
      .where(eq(account.id, approvedAccountId))
      .for("update");
    if (!approvingAccount || approvingAccount.tier !== "member") {
      throw new NonMemberApprovalError(
        "the approving account is no longer a current Member-tier account",
      );
    }

    // Defensive: the stored digest should always match what beginPairing
    // wrote for this exact id. A mismatch means this row predates a protocol
    // change or was otherwise corrupted, either way not safe to trust.
    if (row.challengeDigest !== challengeDigestFor(row.id)) {
      throw new InvalidCompletionProofError(
        "pairing request challenge digest does not match its own id",
      );
    }

    const [existingDevice] = await tx
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.publicKeySpkiB64, row.publicKeySpkiB64))
      .for("update");
    if (existingDevice?.revokedAt != null) {
      throw new RevokedDeviceKeyError(
        "this device key was revoked and can never be reused; generate a new key pair",
      );
    }
    // Controller security ruling: an active key is bound permanently to its
    // first account. Checked BEFORE consuming the request or verifying the
    // signature — this is a refusal on binding, not on proof, and it must
    // leave every bit of the existing device's state untouched, including
    // the pairing request itself (never marked consumed here).
    if (existingDevice && existingDevice.accountId !== approvedAccountId) {
      throw new DeviceBoundToAnotherAccountError(
        "this device key is already bound to a different account and cannot be re-paired to another account",
      );
    }

    if (
      !verifyCompletionProof(
        row.publicKeySpkiB64,
        args.pairingId,
        args.completionSignature,
      )
    ) {
      throw new InvalidCompletionProofError(
        "completion signature does not prove possession of the pairing request's key",
      );
    }

    await tx
      .update(fleetPairingRequest)
      .set({ consumedAt: args.now })
      .where(eq(fleetPairingRequest.id, args.pairingId));

    let deviceId: string;
    if (existingDevice) {
      // Already bound to this exact account (checked above) — reuse is
      // idempotent, no account reassignment needed.
      deviceId = existingDevice.id;
    } else {
      const [inserted] = await tx
        .insert(fleetDevice)
        .values({ accountId: approvedAccountId, publicKeySpkiB64: row.publicKeySpkiB64 })
        .returning({ id: fleetDevice.id });
      deviceId = inserted.id;
    }

    await tx
      .update(fleetPairingRequest)
      .set({ approvedDeviceId: deviceId })
      .where(eq(fleetPairingRequest.id, args.pairingId));

    const rawSessionId = randomBytes(32).toString("base64url");
    await tx.insert(fleetDeviceSession).values({
      id: hashOpaqueValue(rawSessionId),
      deviceId,
      expiresAt: new Date(args.now.getTime() + DEVICE_SESSION_TTL_MS),
    });

    const catalogue = await buildDeviceCatalogue(tx, approvedAccountId);

    return { sessionId: rawSessionId, catalogue };
  });
}

/** Deletes every dependent relay row for one device: its sessions, publisher
 *  leases, and current telemetry rows. Shared by `revokeFleetDevice` and
 *  `revokeFleetRelayForAccount` so relay cleanup lives in exactly one place,
 *  never scattered as raw deletes across call sites.
 *
 *  LOCK ORDER (see `fleet-relay.ts`'s own doc): the caller already holds the
 *  device row's FOR UPDATE lock (level 1) before this runs. This function
 *  locks the device's session rows next (level 2), then every character id
 *  those sessions'/leases' rows touch, ascending, via
 *  `lockFleetCharactersAscending` (level 3) — BEFORE deleting anything.
 *  Deleting the session rows FIRST would let Postgres's own FK CASCADE
 *  (`fleet_publisher_lease.session_id` / `fleet_telemetry_row.session_id`
 *  both cascade on `fleet_device_session`) delete the character rows in
 *  whatever order the cascade's own internal scan picks — not necessarily
 *  ascending — which is exactly what let a revoke and a concurrent publish
 *  deadlock against each other before this locked the same characters the
 *  same way publish does. So the character rows are explicitly deleted
 *  here FIRST (already locked, so this is immediate), and the session rows
 *  are deleted LAST, once there is nothing left for their cascade to reach. */
async function deleteFleetRelayStateForDevice(tx: DbTx, deviceId: string): Promise<void> {
  const sessions = await tx
    .select({ id: fleetDeviceSession.id })
    .from(fleetDeviceSession)
    .where(eq(fleetDeviceSession.deviceId, deviceId))
    .for("update");

  const [leaseCharacterIds, telemetryCharacterIds] = await Promise.all([
    tx
      .select({ characterId: fleetPublisherLease.characterId })
      .from(fleetPublisherLease)
      .where(eq(fleetPublisherLease.deviceId, deviceId)),
    tx
      .select({ characterId: fleetTelemetryRow.characterId })
      .from(fleetTelemetryRow)
      .where(eq(fleetTelemetryRow.deviceId, deviceId)),
  ]);
  const characterIds = [
    ...leaseCharacterIds.map((r) => r.characterId),
    ...telemetryCharacterIds.map((r) => r.characterId),
  ];
  if (characterIds.length > 0) {
    await lockFleetCharactersAscending(tx, characterIds);
  }

  await tx.delete(fleetTelemetryRow).where(eq(fleetTelemetryRow.deviceId, deviceId));
  await tx.delete(fleetPublisherLease).where(eq(fleetPublisherLease.deviceId, deviceId));
  if (sessions.length > 0) {
    await tx.delete(fleetDeviceSession).where(eq(fleetDeviceSession.deviceId, deviceId));
  }
}

/**
 * Soft-revokes one device and tears down everything that trusted its
 * sessions — its device sessions, publisher leases, and current telemetry
 * rows — all inside one transaction. The device row itself survives
 * (`revokedAt` stamped, never deleted) so `fleet_pairing_request.
 * approvedDeviceId` keeps meaning, and its public key can never be paired
 * again.
 */
export async function revokeFleetDevice(
  dbx: Dbx,
  deviceId: string,
  actorAccountId: string,
  now: Date,
): Promise<void> {
  try {
    await dbx.transaction(async (tx) => {
      const [device] = await tx
        .select({ id: fleetDevice.id })
        .from(fleetDevice)
        .where(eq(fleetDevice.id, deviceId))
        .for("update");
      if (!device) throw new DeviceNotFoundError(`no fleet device ${deviceId}`);

      await tx
        .update(fleetDevice)
        .set({ revokedAt: now })
        .where(eq(fleetDevice.id, deviceId));
      await deleteFleetRelayStateForDevice(tx, deviceId);

      await logAudit(tx, {
        actor: actorAccountId,
        action: "fleet_device.revoked",
        target: deviceId,
      });
    });
  } catch (err) {
    if (err instanceof DeviceNotFoundError) throw err;
    if (isRetryableRelayError(err)) {
      throw new RelayContentionError(
        "revoking this device collided with a concurrent relay operation; retry",
      );
    }
    throw err;
  }
}

/**
 * Every fleet device an account has ever paired, revoked and torn down the
 * same way `revokeFleetDevice` does for one device — the single, narrowly
 * named entry point for a future tier/scope/character lifecycle hook
 * (losing Member tier, unlinking the character that paired a device,
 * account deletion) to cut off fleet relay access, rather than each such
 * call site hand-rolling its own relay cleanup.
 *
 * Deliberately does not call `logAudit`: the lifecycle event that invokes
 * this owns its own audit entry under its own action vocabulary (e.g.
 * `tier.changed`), and logging here too would duplicate that row for the
 * same underlying event.
 */
export async function revokeFleetRelayForAccount(
  dbx: Dbx,
  accountId: string,
  now: Date,
): Promise<void> {
  try {
    await dbx.transaction(async (tx) => {
      // Locked (`for("update")`) before any dependent delete: without it, a
      // concurrent `completePairing` reusing one of these device rows (the
      // same account re-pairing its own key) could insert a fresh session
      // between this select and the delete below, and that session would
      // silently outlive the revoke it should have been swept up by.
      const devices = await tx
        .select({ id: fleetDevice.id })
        .from(fleetDevice)
        .where(and(eq(fleetDevice.accountId, accountId), isNull(fleetDevice.revokedAt)))
        .for("update");
      for (const d of devices) {
        await tx
          .update(fleetDevice)
          .set({ revokedAt: now })
          .where(eq(fleetDevice.id, d.id));
        await deleteFleetRelayStateForDevice(tx, d.id);
      }
    });
  } catch (err) {
    if (isRetryableRelayError(err)) {
      throw new RelayContentionError(
        "revoking this account's relay state collided with a concurrent relay operation; retry",
      );
    }
    throw err;
  }
}

/**
 * Renews a device's OWN currently-valid signed session in place — no new
 * browser approval, and (deliberately) no new session id either. This is
 * how a still-authenticated device avoids the 30-minute session cliff
 * `completePairing`'s TTL would otherwise impose on it every time it has
 * been running (or merely idle) that long: it signs a renewal request with
 * its existing session, exactly like any other fleet-v1 request, and gets
 * the SAME session extended by another full `DEVICE_SESSION_TTL_MS` from
 * `now` — the identical window a fresh pairing completion would grant, so a
 * device that renews regularly never sees a shorter session than one that
 * just paired.
 *
 * Extends the EXISTING row rather than issuing a fresh session id (a
 * "rotate" design) for one concrete reason: `fleet_publisher_lease.
 * session_id` and `fleet_telemetry_row.session_id` both CASCADE on
 * `fleet_device_session` (schema.ts), so a device can hold a live publisher
 * lease/telemetry row at the exact moment it renews. Deleting the old
 * session row and inserting a new one would cascade-delete that row too,
 * withdrawing the device's own currently-broadcast DPS/EWAR the instant it
 * renews — a self-inflicted gap with no corresponding real-world event.
 * Extending in place has no such side effect and loses nothing bearer-token
 * rotation would have bought: every signed request (this one included)
 * re-proves possession of the device's Ed25519 private key, so a leaked
 * session id alone, without that key, already cannot forge a renewal (or
 * anything else). Because no new session is created, there is no revision
 * reset to reason about either: `lastRevision` keeps counting up exactly as
 * it did before the call, through the SAME shared gate
 * (`fleet-relay.ts`'s `gateSignedSession`) every other signed request
 * against this session already goes through — this call's own `revision`
 * must itself be strictly greater than whatever this session's counter last
 * reached, and a replayed renewal is refused the identical way a replayed
 * publish or read would be.
 *
 * Shares the READ cadence bucket (`lastReadAt`) with `readFleetProjection`/
 * `readDeviceCatalogueForSession` — a device cannot dodge the 500ms cadence
 * bound by alternating renewal calls with catalogue/snapshot reads — but
 * keeps its OWN `invalid_session` refusal code (not `read`'s `forbidden`):
 * renewal is a session-lifecycle operation in the same sense publish is,
 * not an eligibility-filtered read, so "your session/device is not valid"
 * is named the same way publish names it.
 *
 * Rechecks device AND member eligibility on every call, not just at pairing
 * time: the device must still be un-revoked (`gateSignedSession`'s own
 * check, via its device lock) and the device's account must still be a
 * CURRENT Member-tier account (this function's own check, the exact rule
 * `approvePairing` enforces) — either failing refuses with `not_eligible`
 * and mutates nothing, since the failure is detected before any write.
 */
export async function renewFleetDeviceSession(
  dbx: Dbx,
  args: { sessionId: string; revision: number; now: Date },
): Promise<{ ok: true; expiresAt: Date } | { ok: false; code: string }> {
  try {
    const expiresAt = await dbx.transaction(async (tx) => {
      const { session, device } = await gateSignedSession(tx, {
        sessionId: args.sessionId,
        revision: args.revision,
        now: args.now,
        invalidSessionCode: "invalid_session",
        cadence: "read",
      });

      const [acc] = await tx
        .select({ tier: account.tier })
        .from(account)
        .where(eq(account.id, device.accountId));
      if (!acc || acc.tier !== "member") {
        throw new RelayRefusal("not_eligible");
      }

      const newExpiresAt = new Date(args.now.getTime() + DEVICE_SESSION_TTL_MS);
      await tx
        .update(fleetDeviceSession)
        .set({
          lastRevision: args.revision,
          lastReadAt: args.now,
          expiresAt: newExpiresAt,
        })
        .where(eq(fleetDeviceSession.id, session.id));
      return newExpiresAt;
    });
    return { ok: true, expiresAt };
  } catch (err) {
    if (err instanceof RelayRefusal) return { ok: false, code: err.code };
    if (isRetryableRelayError(err)) return { ok: false, code: "try_again" };
    throw err;
  }
}

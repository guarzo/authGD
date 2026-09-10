import { eq, gt, sql } from "drizzle-orm";
import type { DbTx, Dbx } from "@/db";
import { fleetDevice, fleetDeviceKeyIdentity, fleetSharingGate } from "@/db/schema";
import { normalizeDevicePublicKeyB64 } from "@/lib/fleet-signature";
import { logAudit } from "@/services/audit";
import {
  readFleetKeyIdentityState,
  type FleetKeyIdentityState,
} from "@/services/fleet-sharing-mode";

export class FleetIdentityMaintenanceError extends Error {}
export class FleetDeviceKeyUnavailableError extends Error {}

export function assertPairingIdentityAvailable(mode: FleetKeyIdentityState): void {
  if (
    mode.keyIdentityPhase === "reconciling" ||
    (mode.enabled && mode.keyIdentityPhase !== "ready")
  )
    throw new FleetIdentityMaintenanceError();
}

/** Mode -> class 5 canonical key -> request -> account -> device. Hash collisions
 * only serialize: the full normalized key remains the identity selector. */
export async function lockFleetDeviceKey(tx: DbTx, canonicalKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(5, hashtext(${canonicalKey}))`);
}

export async function fleetDatabaseNow(tx: DbTx, now?: Date): Promise<Date> {
  if (now) return now;
  const result = await tx.execute<{ now: string }>(sql`select clock_timestamp() as now`);
  // Drizzle's raw execute path preserves the driver's timestamp string, unlike
  // schema timestamp projections which apply a Date decoder.
  return new Date(result.rows[0].now);
}

export async function boundFleetRecoveryWaits(tx: DbTx): Promise<void> {
  await tx.execute(sql`set local lock_timeout = '2s'`);
  await tx.execute(sql`set local statement_timeout = '5s'`);
}

/** Never lock this FK-bearing index row across an account lock: account deletion
 * cascades into device and SET NULL here. Authoritative consumers re-read after
 * account/device waits. A missing device is not a fresh registration slot. */
export async function resolveFleetDeviceKey(
  dbx: Dbx,
  rawKey: string,
  mode: FleetKeyIdentityState,
) {
  assertPairingIdentityAvailable(mode);
  if (mode.keyIdentityPhase === "pending") {
    const [device] = await dbx
      .select()
      .from(fleetDevice)
      .where(eq(fleetDevice.publicKeySpkiB64, rawKey));
    return { canonicalKey: rawKey, device, unavailable: false };
  }
  const canonicalKey =
    rawKey.length <= 120
      ? normalizeDevicePublicKeyB64(Buffer.from(rawKey, "base64"))
      : null;
  if (!canonicalKey) throw new FleetDeviceKeyUnavailableError();
  const [identity] = await dbx
    .select()
    .from(fleetDeviceKeyIdentity)
    .where(eq(fleetDeviceKeyIdentity.canonicalSpkiB64, canonicalKey));
  const [device] = identity?.deviceId
    ? await dbx.select().from(fleetDevice).where(eq(fleetDevice.id, identity.deviceId))
    : [];
  return {
    canonicalKey,
    device,
    unavailable: !!identity && (identity.conflicted || !device),
  };
}

/** PRIVATE OPERATOR SERVICE, no route/CLI/startup caller. Before invoking, the
 * operator MUST verify old-writer drain AND stop/drain deletion-capable web,
 * worker and CLI writers. Keep them quiescent through interruptions until ready.
 * Account/identity locks do NOT acquire mode late: mode alone cannot enforce this
 * prerequisite. No session drain, grants, registrations or participation writes. */
export async function startFleetKeyIdentityReconciliation(
  dbx: Dbx,
  args: {
    expectedRevision: number;
    oldWritersDrained: true;
    deletionWritersQuiescent: true;
  },
): Promise<FleetKeyIdentityState> {
  if (args.oldWritersDrained !== true || args.deletionWritersQuiescent !== true)
    throw new Error("quiescence_required");
  return dbx.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(3, 0)`);
    const prior = await readFleetKeyIdentityState(tx);
    if (prior.revision !== args.expectedRevision) throw new Error("conflict");
    if (prior.enabled || prior.keyIdentityPhase !== "pending")
      throw new Error("reconciliation_unavailable");
    const next = {
      ...prior,
      revision: prior.revision + 1,
      keyIdentityPhase: "reconciling" as const,
      keyIdentityCursor: null,
    };
    await tx
      .insert(fleetSharingGate)
      .values({ id: 1, ...next })
      .onConflictDoUpdate({ target: fleetSharingGate.id, set: next });
    await logAudit(tx, {
      actor: "system",
      action: "fleet_sharing.key_identity_started",
      target: "all",
    });
    return next;
  });
}

/** At most 100 UUID-ordered rows per atomic batch. Bound in SQL BEFORE loading or
 * decoding persisted text. Malformed rows roll back this batch; never skip them
 * or mark readiness. Same-device revisits are idempotent; conflict is sticky. */
export async function reconcileFleetKeyIdentityBatch(
  dbx: Dbx,
  args: { expectedRevision: number },
): Promise<FleetKeyIdentityState> {
  return dbx.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(3, 0)`);
    const prior = await readFleetKeyIdentityState(tx);
    if (prior.revision !== args.expectedRevision) throw new Error("conflict");
    if (prior.enabled || prior.keyIdentityPhase !== "reconciling")
      throw new Error("reconciliation_unavailable");
    const rows = await tx
      .select({
        id: fleetDevice.id,
        key: sql<
          string | null
        >`case when octet_length(${fleetDevice.publicKeySpkiB64}) <= 120 then ${fleetDevice.publicKeySpkiB64} else null end`,
      })
      .from(fleetDevice)
      .where(
        prior.keyIdentityCursor ? gt(fleetDevice.id, prior.keyIdentityCursor) : undefined,
      )
      .orderBy(fleetDevice.id)
      .limit(100);
    for (const row of rows) {
      const key =
        row.key && /^[A-Za-z0-9+/]+={0,2}$/.test(row.key)
          ? normalizeDevicePublicKeyB64(Buffer.from(row.key, "base64"))
          : null;
      if (!key) throw new Error("invalid_persisted_device_key");
      const [existing] = await tx
        .select()
        .from(fleetDeviceKeyIdentity)
        .where(eq(fleetDeviceKeyIdentity.canonicalSpkiB64, key));
      if (!existing)
        await tx
          .insert(fleetDeviceKeyIdentity)
          .values({ canonicalSpkiB64: key, deviceId: row.id });
      else if (!existing.conflicted && existing.deviceId !== row.id)
        await tx
          .update(fleetDeviceKeyIdentity)
          .set({ conflicted: true, deviceId: null })
          .where(eq(fleetDeviceKeyIdentity.canonicalSpkiB64, key));
    }
    const next = {
      ...prior,
      keyIdentityCursor: rows.at(-1)?.id ?? prior.keyIdentityCursor,
      keyIdentityPhase: rows.length < 100 ? ("ready" as const) : ("reconciling" as const),
      revision: prior.revision + (rows.length < 100 ? 1 : 0),
    };
    await tx.update(fleetSharingGate).set(next).where(eq(fleetSharingGate.id, 1));
    if (next.keyIdentityPhase === "ready")
      await logAudit(tx, {
        actor: "system",
        action: "fleet_sharing.key_identity_ready",
        target: "all",
      });
    return next;
  });
}

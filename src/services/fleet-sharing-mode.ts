import { eq, sql } from "drizzle-orm";
import type { DbTx, Dbx } from "@/db";
import {
  fleetDevice,
  fleetDeviceSession,
  fleetEligibility,
  fleetPublisherLease,
  fleetSharingGate,
  fleetTelemetryRow,
} from "@/db/schema";
import { logAudit } from "@/services/audit";
import { lockFleetCharactersAscending } from "@/services/fleet-relay";

export type FleetSharingMode = {
  enabled: boolean;
  revision: number;
  transitionedAt: Date | null;
};
export class FleetSharingDisabledError extends Error {
  constructor() {
    super("feature_disabled");
  }
}

/** Operator-only and never called on deploy or by a public route. Caller verifies
 * compatible web/worker deployment first. Task 1 drains current legacy state;
 * source invalidation MUST be integrated before this is release-ready.
 * Lock order: exclusive mode → ALL devices by id → ALL sessions by id → union
 * of relay characters ascending. Old readers do not know the mode lock, so the
 * session/device drain (not the flag alone) is the compatibility boundary. */
export async function transitionFleetSharingMode(
  dbx: Dbx,
  args: { enabled: boolean; expectedRevision: number; now?: Date },
): Promise<FleetSharingMode> {
  return dbx.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(3, 0)`);
    const prior = await readFleetSharingMode(tx);
    if (prior.revision !== args.expectedRevision) throw new Error("conflict");
    await tx
      .select({ id: fleetDevice.id })
      .from(fleetDevice)
      .orderBy(fleetDevice.id)
      .for("update");
    await tx
      .select({ id: fleetDeviceSession.id })
      .from(fleetDeviceSession)
      .orderBy(fleetDeviceSession.id)
      .for("update");
    const leases = await tx
      .select({ characterId: fleetPublisherLease.characterId })
      .from(fleetPublisherLease);
    const rows = await tx
      .select({ characterId: fleetTelemetryRow.characterId })
      .from(fleetTelemetryRow);
    await lockFleetCharactersAscending(
      tx,
      [...leases, ...rows].map((r) => r.characterId),
    );
    await tx.delete(fleetTelemetryRow);
    await tx.delete(fleetPublisherLease);
    await tx.delete(fleetDeviceSession);
    await tx.delete(fleetEligibility);
    const next = {
      enabled: args.enabled,
      revision: prior.revision + 1,
      transitionedAt: args.now ?? new Date(),
    };
    await tx
      .insert(fleetSharingGate)
      .values({ id: 1, ...next })
      .onConflictDoUpdate({ target: fleetSharingGate.id, set: next });
    await logAudit(tx, {
      actor: "system",
      action: "fleet_sharing.mode_transitioned",
      target: "all",
      details: { enabled: next.enabled, revision: next.revision },
    });
    return next;
  });
}

export async function readFleetSharingMode(dbx: Dbx): Promise<FleetSharingMode> {
  const [gate] = await dbx
    .select({
      enabled: fleetSharingGate.enabled,
      revision: fleetSharingGate.revision,
      transitionedAt: fleetSharingGate.transitionedAt,
    })
    .from(fleetSharingGate)
    .where(eq(fleetSharingGate.id, 1));
  return gate ?? { enabled: false, revision: 0, transitionedAt: null };
}

/** Mode lock precedes pairing/account/device/session locks. Shared admission cannot
 * race a cutover, even when the singleton row does not exist yet. Class 3 is
 * separate from identity (1) and relay-character (2) advisory locks. */
export async function lockFleetSharingMode(tx: DbTx): Promise<FleetSharingMode> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(3, 0)`);
  return readFleetSharingMode(tx);
}

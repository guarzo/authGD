import { eq, sql } from "drizzle-orm";
import type { DbTx, Dbx } from "@/db";
import {
  fleetDevice,
  fleetDeviceSession,
  fleetEligibility,
  fleetPublisherLease,
  fleetSourceAuthority,
  fleetSharingGate,
  fleetTelemetryRow,
} from "@/db/schema";
import { logAudit } from "@/services/audit";
import { lockFleetCharactersAscending } from "@/services/fleet-relay";
import { invalidateFleetSources, lockFleetLifecycle } from "@/services/fleet-lifecycle";

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
 * compatible web/worker deployment first. The operator CLI remains blocked until
 * source control and shared admission are release-ready.
 * Lock order: exclusive mode → ALL authority/source slots → devices → sessions → union
 * of relay characters ascending. Old readers do not know the mode lock, so the
 * session/device drain (not the flag alone) is the compatibility boundary. */
export async function transitionFleetSharingMode(
  dbx: Dbx,
  args: { enabled: boolean; expectedRevision: number; now?: Date },
): Promise<FleetSharingMode> {
  return dbx.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(3, 0)`);
    const prior = await readFleetKeyIdentityState(tx);
    if (prior.revision !== args.expectedRevision) throw new Error("conflict");
    // Fail BEFORE any drain/write. Reconciliation is explicit, never a side
    // effect of enabling; readiness is permanent across ordinary mode toggles.
    if (args.enabled && prior.keyIdentityPhase !== "ready")
      throw new FleetSharingDisabledError();
    if (args.enabled) {
      // Operator runs bounded independent cleanup until the expired backlog is
      // gone. Enabling does not disguise an unbounded purge as a mode toggle.
      const expired = await tx.execute(
        sql`select id from fleet_recovery_challenge where expires_at <= ${args.now ? sql`${args.now}` : sql`clock_timestamp()`} limit 1`,
      );
      if (expired.rows.length) throw new Error("recovery_cleanup_required");
    }
    const lifecycle = await lockFleetLifecycle(tx, { all: true });
    await invalidateFleetSources(tx, lifecycle, "mode_transition", "system", args.now);
    // Clear even an orphaned proof slot: EX mode excludes all source writers.
    await tx
      .update(fleetSourceAuthority)
      .set({
        sourceId: null,
        sourceGeneration: null,
        authorityGeneration: sql`${fleetSourceAuthority.authorityGeneration} + 1`,
        linkedCharacters: [],
        verifiedAt: null,
        expiresAt: null,
      })
      .where(sql`${fleetSourceAuthority.sourceId} is not null`);
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

export type FleetKeyIdentityState = FleetSharingMode & {
  keyIdentityPhase: "pending" | "reconciling" | "ready";
  keyIdentityCursor: string | null;
};

export async function readFleetKeyIdentityState(
  dbx: Dbx,
): Promise<FleetKeyIdentityState> {
  const [gate] = await dbx
    .select()
    .from(fleetSharingGate)
    .where(eq(fleetSharingGate.id, 1));
  return (
    gate ?? {
      enabled: false,
      revision: 0,
      transitionedAt: null,
      keyIdentityPhase: "pending",
      keyIdentityCursor: null,
    }
  );
}

/** Mode precedes canonical key, pairing/account/device/session locks. Shared
 * admission cannot race cutover even without a singleton row. Class 3 is separate
 * from account identity (1), relay-character (2), admission (4) and key (5). */
export async function lockFleetSharingMode(tx: DbTx): Promise<FleetKeyIdentityState> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(3, 0)`);
  return readFleetKeyIdentityState(tx);
}

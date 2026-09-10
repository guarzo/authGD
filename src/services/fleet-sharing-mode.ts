import { count, eq, getTableName, sql } from "drizzle-orm";
import type { DbTx, Dbx } from "@/db";
import {
  fleetDevice,
  fleetDeviceKeyIdentity,
  fleetDeviceSession,
  fleetEligibility,
  fleetPairingRequest,
  fleetRecoveryChallenge,
  fleetSourceIntent,
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
 * compatible web/worker deployment and old-replica drain first. The CLI exposes
 * disable; general nonempty enable/reconciliation remains separately blocked.
 * Lock order: exclusive mode → ALL authority/source slots → devices → sessions → union
 * of relay characters ascending. Old readers do not know the mode lock, so the
 * session/device drain (not the flag alone) is the compatibility boundary. */
export async function transitionFleetSharingMode(
  dbx: Dbx,
  args: { enabled: boolean; expectedRevision: number; now?: Date },
): Promise<FleetSharingMode> {
  return dbx.transaction(async (tx) => {
    await boundFleetModeOperatorWaits(tx);
    await requireFleetModeReadCommitted(tx, "mode_read_committed_required");
    await tx.execute(sql`select pg_advisory_xact_lock(3, 0)`);
    const prior = await readFleetKeyIdentityState(tx);
    if (prior.revision !== args.expectedRevision)
      throw new FleetModeOperatorError("conflict");
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

export class FleetModeOperatorError extends Error {}

export async function boundFleetModeOperatorWaits(tx: DbTx) {
  await tx.execute(sql`set local lock_timeout = '2s'`);
  await tx.execute(sql`set local statement_timeout = '5s'`);
}

async function requireFleetModeReadCommitted(tx: DbTx, refusal: string) {
  // A repeatable snapshot can be fixed by the advisory SELECT before it waits.
  // Reject it BEFORE locking, or a pairing committed during the wait can escape
  // bootstrap's inventory check or the mode transition's session drain.
  const isolation = await tx.execute<{ level: string }>(
    sql`select current_setting('transaction_isolation') as level`,
  );
  if (isolation.rows[0].level !== "read committed")
    throw new FleetModeOperatorError(refusal);
}

// One inventory drives both locking and counts. Include expired/consumed rows,
// empty authority fences and deleted/conflicted key bindings. The boss-readiness
// cooldown is not enrollment; accounts, SSO grants and browser sessions stay out.
const FIRST_USE_TABLES = [
  fleetDevice,
  fleetPairingRequest,
  fleetDeviceKeyIdentity,
  fleetDeviceSession,
  fleetSourceIntent,
  fleetSourceAuthority,
  fleetRecoveryChallenge,
  fleetPublisherLease,
  fleetTelemetryRow,
  fleetEligibility,
];

/** Empty-index initialization, NOT reconciliation. No fabricated quiescence,
 * registration rewrite or consent. Mode locks serialize compatible admissions;
 * table locks also exclude legacy writers, FK cascades and mode-free cleanup.
 * Take a fresh READ COMMITTED snapshot only AFTER all locks, including for an
 * absent gate. A timeout/deadlock fails the whole transaction, never retries.
 * Dry-run uses a read-only snapshot, not a promise about a later apply. */
export async function bootstrapFleetSharingMode(
  dbx: Dbx,
  args: { expectedRevision: number; dryRun?: boolean },
) {
  return dbx.transaction(async (tx) => {
    if (args.dryRun)
      await tx.execute(sql`set transaction isolation level repeatable read, read only`);
    await boundFleetModeOperatorWaits(tx);
    if (!args.dryRun) {
      await requireFleetModeReadCommitted(tx, "first_use_read_committed_required");
      await tx.execute(sql`select pg_advisory_xact_lock(3, 0)`);
      await tx.execute(
        sql`lock table ${sql.join([fleetSharingGate, ...FIRST_USE_TABLES], sql`, `)} in share row exclusive mode`,
      );
    }
    const current = await readFleetKeyIdentityState(tx);
    const firstUseCounts: Record<string, number> = {};
    for (const table of FIRST_USE_TABLES) {
      const [row] = await tx.select({ n: count() }).from(table);
      firstUseCounts[getTableName(table)] = row.n;
    }
    const refusal =
      current.revision !== args.expectedRevision
        ? "conflict"
        : current.enabled ||
            current.revision !== 0 ||
            current.transitionedAt !== null ||
            current.keyIdentityPhase !== "pending" ||
            current.keyIdentityCursor !== null
          ? "first_use_initial_state_required"
          : Object.values(firstUseCounts).some((n) => n !== 0)
            ? "first_use_empty_state_required"
            : null;
    if (args.dryRun)
      return {
        dryRun: true as const,
        current,
        firstUseCounts,
        refusal,
        releaseReady: refusal === null,
      };
    if (refusal) throw new FleetModeOperatorError(refusal);
    const ready = {
      enabled: true,
      revision: 1,
      keyIdentityPhase: "ready" as const,
      transitionedAt: sql`clock_timestamp()`,
    };
    const [next] = await tx
      .insert(fleetSharingGate)
      .values({ id: 1, ...ready })
      .onConflictDoUpdate({ target: fleetSharingGate.id, set: ready })
      .returning();
    await logAudit(tx, {
      actor: "system",
      action: "fleet_sharing.key_identity_ready",
      target: "all",
    });
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

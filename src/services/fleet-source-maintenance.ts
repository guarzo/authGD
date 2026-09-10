import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import {
  fleetSourceAuthority,
  fleetSourceIntent,
  fleetPublisherLease,
  fleetTelemetryRow,
} from "@/db/schema";
import { maintainFleetSource } from "@/services/fleet-source-observation";
import { purgeExpiredFleetSourceIntents } from "@/services/fleet-lifecycle";
import { fleetDatabaseNow } from "@/services/fleet-key-identity";
import { lockFleetCharactersAscending } from "@/services/fleet-relay";

export async function reserveDueFleetSources(
  db: Db,
  clock?: () => Date,
): Promise<number> {
  const now = clock?.() ?? new Date();
  const candidates = await db
    .select({ id: fleetSourceIntent.id })
    .from(fleetSourceIntent)
    .where(
      and(
        ne(fleetSourceIntent.state, "ended"),
        lte(fleetSourceIntent.nextFetchAt, now),
        or(
          isNull(fleetSourceIntent.enqueueUntil),
          lte(fleetSourceIntent.enqueueUntil, now),
        ),
        or(
          isNull(fleetSourceIntent.fetchClaimExpiresAt),
          lte(fleetSourceIntent.fetchClaimExpiresAt, now),
        ),
      ),
    )
    .orderBy(fleetSourceIntent.nextFetchAt, fleetSourceIntent.id)
    .limit(100);
  let count = 0;
  for (const s of candidates) count += await maintainFleetSource(db, s.id, true, clock);
  return count;
}
/** Independent of readers, success and admission mode. Per pass: at most 100
 * source candidates, 100 ended fences, and 100 relay identities. No old unbounded
 * prune helper is hidden behind this bound. Startup repeats bounded passes. */
export async function cleanupFleetSources(db: Db, clock?: () => Date): Promise<number> {
  const now = clock?.() ?? new Date();
  const candidates = await db
    .select({ id: fleetSourceIntent.id })
    .from(fleetSourceIntent)
    .leftJoin(
      fleetSourceAuthority,
      and(
        eq(fleetSourceAuthority.sourceId, fleetSourceIntent.id),
        eq(fleetSourceAuthority.sourceGeneration, fleetSourceIntent.generation),
      ),
    )
    .where(
      and(
        ne(fleetSourceIntent.state, "ended"),
        or(
          and(
            isNull(fleetSourceIntent.activatedAt),
            lte(fleetSourceIntent.intentExpiresAt, now),
          ),
          lte(fleetSourceIntent.fetchClaimExpiresAt, now),
          lte(fleetSourceAuthority.expiresAt, now),
        ),
      ),
    )
    .orderBy(fleetSourceIntent.id)
    .limit(100);
  for (const source of candidates) await maintainFleetSource(db, source.id, false, clock);
  const tombstones = await purgeExpiredFleetSourceIntents(db, clock?.());
  const relay = await db.transaction(async (tx) => {
    const before = await fleetDatabaseNow(tx, clock?.());
    const rows = await tx.execute<{ character_id: string }>(
      sql`select character_id from (select character_id from fleet_telemetry_row where hard_expires_at <= ${before} union select character_id from fleet_publisher_lease where lease_expires_at <= ${before}) expired order by character_id limit 100`,
    );
    const ids = rows.rows.map((r) => Number(r.character_id));
    if (!ids.length) return 0;
    await lockFleetCharactersAscending(tx, ids);
    const after = await fleetDatabaseNow(tx, clock?.());
    await tx
      .delete(fleetTelemetryRow)
      .where(
        and(
          inArray(fleetTelemetryRow.characterId, ids),
          lte(fleetTelemetryRow.hardExpiresAt, after),
        ),
      );
    await tx
      .delete(fleetPublisherLease)
      .where(
        and(
          inArray(fleetPublisherLease.characterId, ids),
          lte(fleetPublisherLease.leaseExpiresAt, after),
        ),
      );
    return ids.length;
  });
  return candidates.length + tombstones + relay;
}

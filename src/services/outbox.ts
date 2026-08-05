import { inArray, isNull, min } from "drizzle-orm";
import type { Dbx } from "@/db";
import type { OutboxPayload } from "@/core/dispatch-plan";
import { outbox } from "@/db/schema";

/** The one declaration lives in `@/core/dispatch-plan`; re-exported here so
 * this module's own consumers don't need to know it moved. */
export type { OutboxPayload };

export async function enqueueSync(dbx: Dbx, payload: OutboxPayload): Promise<void> {
  await dbx.insert(outbox).values({ payload });
}

/**
 * Claims undispatched rows with FOR UPDATE SKIP LOCKED so concurrent
 * dispatchers never double-process a row. Call this and markDispatched inside
 * the SAME transaction — the row locks are what make the claim exclusive, and
 * they only live as long as the transaction.
 */
export async function takeUndispatched(
  dbx: Dbx,
  limit = 100,
): Promise<Array<{ id: number; payload: OutboxPayload }>> {
  const rows = await dbx
    .select()
    .from(outbox)
    .where(isNull(outbox.dispatchedAt))
    .orderBy(outbox.id)
    .limit(limit)
    .for("update", { skipLocked: true });
  return rows.map((r) => ({ id: r.id, payload: r.payload }));
}

export type UndispatchedRow = { payload: OutboxPayload; oldest: Date };

/**
 * One row per DISTINCT undispatched payload, for a read-only status view.
 * Unlike `takeUndispatched` this takes no lock and is not paired with
 * `markDispatched` — the admin sync page only needs to know whether work is
 * queued, never to claim it, and a `FOR UPDATE` read here would contend with
 * the dispatcher's own claim on the same rows.
 *
 * Grouped by payload rather than one row per outbox row: `{kind:"all"}` and
 * `{kind:"membership-recheck"}` repeat every scheduler tick the worker is
 * down, so an ungrouped SELECT grows without bound for exactly as long as the
 * worker is down — which is when an admin loads this page. The consumer
 * (`getSyncStatus`) only ever turns these into a Set of job types plus an
 * age, never individual rows, so the group loses nothing it used.
 */
export async function undispatchedSummary(dbx: Dbx): Promise<UndispatchedRow[]> {
  const rows = await dbx
    .select({ payload: outbox.payload, oldest: min(outbox.createdAt) })
    .from(outbox)
    .where(isNull(outbox.dispatchedAt))
    .groupBy(outbox.payload);
  return rows.flatMap((r) => {
    // `min()` over a timestamptz column comes back as `Date | null` from both
    // drizzle's typing and node-postgres's OID 1184 parser — the null is the
    // only gap, and it stands for an empty group, which GROUP BY cannot
    // produce. Skipping rather than asserting past it keeps `oldest: Date` an
    // honest promise to the caller without a `!` the type system can't check.
    if (r.oldest === null) return [];
    return [{ payload: r.payload, oldest: r.oldest }];
  });
}

export async function markDispatched(dbx: Dbx, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await dbx
    .update(outbox)
    .set({ dispatchedAt: new Date() })
    .where(inArray(outbox.id, ids));
}

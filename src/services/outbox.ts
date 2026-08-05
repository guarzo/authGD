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

export type UndispatchedRow = {
  payload: OutboxPayload;
  /** Oldest `createdAt` in the group. Null only in a case the database cannot
   * actually produce (see `undispatchedSummary`) — kept nullable so that case
   * costs the caller an age it can render without, rather than the row. */
  oldest: Date | null;
};

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
  // `min()` over a timestamptz column comes back as `Date | null` from both
  // drizzle's typing and node-postgres's OID 1184 parser. The null stands for
  // an empty group, which GROUP BY cannot produce — but it is passed through
  // rather than filtered out, because the caller derives "is anything queued
  // for this job type" from the PRESENCE of a row and only the age from
  // `oldest`. Dropping the row would turn an impossible null into a job type
  // that silently looks idle while work sits in the outbox, which is the exact
  // failure the queued marker exists to make visible; carrying it forward
  // costs at most the "3d ago" suffix.
  return dbx
    .select({ payload: outbox.payload, oldest: min(outbox.createdAt) })
    .from(outbox)
    .where(isNull(outbox.dispatchedAt))
    .groupBy(outbox.payload);
}

export async function markDispatched(dbx: Dbx, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await dbx
    .update(outbox)
    .set({ dispatchedAt: new Date() })
    .where(inArray(outbox.id, ids));
}

import { inArray, isNull } from "drizzle-orm";
import type { Dbx } from "@/db";
import { outbox } from "@/db/schema";

/** Derived from the schema's payload column so the two can never drift. */
export type OutboxPayload = typeof outbox.$inferSelect.payload;

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

/**
 * The payloads of every undispatched row, for a read-only status view. Unlike
 * `takeUndispatched` this takes no lock and is not paired with
 * `markDispatched` — the admin sync page only needs to know whether work is
 * queued, never to claim it, and a `FOR UPDATE` read here would contend with
 * the dispatcher's own claim on the same rows.
 */
export async function undispatchedPayloads(dbx: Dbx): Promise<OutboxPayload[]> {
  const rows = await dbx
    .select({ payload: outbox.payload })
    .from(outbox)
    .where(isNull(outbox.dispatchedAt));
  return rows.map((r) => r.payload);
}

export async function markDispatched(dbx: Dbx, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await dbx
    .update(outbox)
    .set({ dispatchedAt: new Date() })
    .where(inArray(outbox.id, ids));
}

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

export async function markDispatched(dbx: Dbx, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await dbx
    .update(outbox)
    .set({ dispatchedAt: new Date() })
    .where(inArray(outbox.id, ids));
}

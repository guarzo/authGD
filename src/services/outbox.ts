import { inArray, isNull } from "drizzle-orm";
import type { Dbx } from "@/db";
import { outbox } from "@/db/schema";

export type OutboxPayload =
  | { kind: "account"; accountId: string }
  | { kind: "discord-user"; discordUserId: string } // Plan 2: strip managed roles from an unlinked Discord user
  | { kind: "all" };

export async function enqueueSync(dbx: Dbx, payload: OutboxPayload): Promise<void> {
  await dbx.insert(outbox).values({ payload });
}

export async function takeUndispatched(
  dbx: Dbx,
  limit = 100,
): Promise<Array<{ id: number; payload: OutboxPayload }>> {
  const rows = await dbx
    .select()
    .from(outbox)
    .where(isNull(outbox.dispatchedAt))
    .orderBy(outbox.id)
    .limit(limit);
  return rows.map((r) => ({ id: r.id, payload: r.payload }));
}

export async function markDispatched(dbx: Dbx, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await dbx
    .update(outbox)
    .set({ dispatchedAt: new Date() })
    .where(inArray(outbox.id, ids));
}

import { desc, sql } from "drizzle-orm";
import type { Dbx } from "@/db";
import { syncRun } from "@/db/schema";

/** Cheapest possible proof that a backend is reachable and answering. */
export async function checkLiveness(dbx: Dbx): Promise<boolean> {
  try {
    await dbx.execute(sql`select 1`);
    return true;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Newest run by serial primary key, NOT by max(started_at): the only index is
 * (job_type, id desc), so max(started_at) would seq-scan a table growing ~122
 * rows/day. started_at defaults to insert time, so id order and insertion order
 * can only disagree by the width of a race — far below a 90-minute threshold.
 */
export async function newestSyncRun(
  dbx: Dbx,
): Promise<{ jobType: string; startedAt: Date } | null> {
  const rows = await dbx
    .select({ jobType: syncRun.jobType, startedAt: syncRun.startedAt })
    .from(syncRun)
    .orderBy(desc(syncRun.id))
    .limit(1);
  return rows[0] ?? null;
}

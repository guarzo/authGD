import { eq } from "drizzle-orm";
import type { Db, Dbx } from "@/db";
import { syncRun } from "@/db/schema";

export type JobResult = {
  status: "ok" | "partial" | "failed";
  errorSummary?: string;
  counts?: Record<string, number>;
  /** When true, runJob throws JobRetryError after recording so pg-boss retries. */
  retry?: boolean;
};

export class JobRetryError extends Error {}

export async function startSyncRun(dbx: Dbx, jobType: string): Promise<number> {
  const [row] = await dbx.insert(syncRun).values({ jobType }).returning();
  return row.id;
}

export async function finishSyncRun(
  dbx: Dbx,
  id: number,
  result: Omit<JobResult, "retry">,
): Promise<void> {
  await dbx
    .update(syncRun)
    .set({
      finishedAt: new Date(),
      status: result.status,
      errorSummary: result.errorSummary ?? null,
      counts: result.counts ?? null,
    })
    .where(eq(syncRun.id, id));
}

/**
 * Uniform job wrapper: one sync_run row per execution. Transient trouble is
 * reported via result.retry (recorded, then thrown as JobRetryError so pg-boss
 * retries the idempotent job); permanent/config failures return status
 * "failed" WITHOUT retry so they don't retry-loop.
 */
export async function runJob(
  db: Db,
  jobType: string,
  fn: () => Promise<JobResult>,
): Promise<JobResult> {
  const id = await startSyncRun(db, jobType);
  let result: JobResult;
  try {
    result = await fn();
  } catch (err) {
    await finishSyncRun(db, id, {
      status: "failed",
      errorSummary: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  await finishSyncRun(db, id, result);
  if (result.retry) {
    throw new JobRetryError(`${jobType}: ${result.errorSummary ?? "transient failures"}`);
  }
  return result;
}

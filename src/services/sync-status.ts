import { desc, eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import { syncRun } from "@/db/schema";

const KNOWN_ORDER = [
  "membership",
  "membership-recheck",
  "contacts",
  "wanderer",
  "discord-roles",
  "token-health",
  "purge",
];

export async function getSyncStatus(
  dbx: Dbx,
  runsPerJob = 5,
): Promise<Array<{ jobType: string; runs: Array<typeof syncRun.$inferSelect> }>> {
  // One limited query per job type (~8 total): a single global row window
  // would drop rare jobs (weekly membership-recheck) behind the ~122
  // hourly/half-hourly runs recorded per day.
  const types = await dbx.selectDistinct({ jobType: syncRun.jobType }).from(syncRun);
  const present = types.map((t) => t.jobType);
  const known = KNOWN_ORDER.filter((j) => present.includes(j));
  const unknown = present.filter((j) => !KNOWN_ORDER.includes(j)).sort();
  return Promise.all(
    [...known, ...unknown].map(async (jobType) => ({
      jobType,
      runs: await dbx
        .select()
        .from(syncRun)
        .where(eq(syncRun.jobType, jobType))
        .orderBy(desc(syncRun.id))
        .limit(runsPerJob),
    })),
  );
}

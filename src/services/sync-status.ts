import { desc, eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import { JOB_CRON } from "@/core/schedules";
import { jobsFor } from "@/core/dispatch-plan";
import { syncRun } from "@/db/schema";
import { undispatchedPayloads } from "@/services/outbox";

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
): Promise<
  Array<{ jobType: string; runs: Array<typeof syncRun.$inferSelect>; queued: boolean }>
> {
  // One limited query per job type (~8 total): a single global row window
  // would drop rare jobs (weekly membership-recheck) behind the ~122
  // hourly/half-hourly runs recorded per day.
  const types = await dbx.selectDistinct({ jobType: syncRun.jobType }).from(syncRun);
  const present = new Set(types.map((t) => t.jobType));
  // Every scheduled job gets a row even with no runs at all. "discord-roles
  // has never synced" as a MISSING row is the hardest failure for an eye to
  // catch; as a row saying "never" it is the most obvious one.
  const all = new Set([...present, ...Object.keys(JOB_CRON)]);
  const known = KNOWN_ORDER.filter((j) => all.has(j));
  const unknown = [...all].filter((j) => !KNOWN_ORDER.includes(j)).sort();

  // One extra query for the whole page, not one per job type: every
  // undispatched row's payload is expanded through the SAME mapping the
  // dispatcher itself sends through (`jobsFor`, `@/core/dispatch-plan`), so
  // this can never claim a job is queued that the worker would not actually
  // enqueue. "Queued" means work targets that job type, not "you queued it" —
  // a member-triggered account/discord-user row counts the same as an admin's.
  const payloads = await undispatchedPayloads(dbx);
  const queuedTypes = new Set<string>(
    payloads.flatMap((payload) => jobsFor(payload).map((j) => j.jobType)),
  );

  return Promise.all(
    [...known, ...unknown].map(async (jobType) => ({
      jobType,
      // A seeded job with no rows needs no query to tell us it has none.
      runs: present.has(jobType)
        ? await dbx
            .select()
            .from(syncRun)
            .where(eq(syncRun.jobType, jobType))
            .orderBy(desc(syncRun.id))
            .limit(runsPerJob)
        : [],
      queued: queuedTypes.has(jobType),
    })),
  );
}

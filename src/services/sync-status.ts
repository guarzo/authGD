import { desc, eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import { JOB_CRON } from "@/core/schedules";
import { jobsFor } from "@/core/dispatch-plan";
import { syncRun } from "@/db/schema";
import { undispatchedSummary } from "@/services/outbox";

const KNOWN_ORDER = [
  "membership",
  "membership-recheck",
  "contacts",
  "wanderer",
  "discord-roles",
  "token-health",
  "purge",
  "location",
];

export type SyncStatusGroup = {
  jobType: string;
  runs: Array<typeof syncRun.$inferSelect>;
  queued: boolean;
  /** Oldest undispatched-row `createdAt` targeting this jobType, or null when
   * nothing is queued for it — or, in a case the database cannot actually
   * produce, when the row is queued but its age did not survive the read.
   * `queued` is the authority on whether work is waiting; this only dates it.
   * Per job type, not global: an "all" payload sits in the outbox once but
   * ages the same instant for every job type it fans out to, so this is the
   * min across every payload that maps here, not a single page-wide
   * timestamp. */
  queuedSince: Date | null;
};

export async function getSyncStatus(
  dbx: Dbx,
  runsPerJob = 5,
): Promise<Array<SyncStatusGroup>> {
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

  // One extra query for the whole page, not one per job type: every distinct
  // undispatched payload is expanded through the SAME mapping the dispatcher
  // itself sends through (`jobsFor`, `@/core/dispatch-plan`), so this can
  // never claim a job is queued that the worker would not actually enqueue.
  // "Queued" means work targets that job type, not "you queued it" — a
  // member-triggered account/discord-user row counts the same as an admin's.
  const summary = await undispatchedSummary(dbx);
  const queuedTypes = new Set<string>();
  const queuedSinceByType = new Map<string, Date>();
  for (const { payload, oldest } of summary) {
    for (const { jobType } of jobsFor(payload)) {
      // Presence and age are tracked apart on purpose: a row whose `oldest`
      // came back null still proves work is queued for this job type, and
      // `queued` must not depend on whether the age survived.
      queuedTypes.add(jobType);
      if (oldest === null) continue;
      const current = queuedSinceByType.get(jobType);
      if (!current || oldest < current) queuedSinceByType.set(jobType, oldest);
    }
  }

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
      queuedSince: queuedSinceByType.get(jobType) ?? null,
    })),
  );
}

import type PgBoss from "pg-boss";

export const QUEUES = {
  membership: "membership",
  membershipRecheck: "membership-recheck",
  contacts: "contacts",
  wanderer: "wanderer",
  discordRoles: "discord-roles",
  tokenHealth: "token-health",
  purge: "purge",
  deadLetter: "ops-dead-letter",
} as const;

/** ~5 tries over ~30 min: 60 s base delay with exponential backoff. */
const RETRY = { retryLimit: 5, retryDelay: 60, retryBackoff: true };

const JOB_QUEUES = [
  QUEUES.membership,
  QUEUES.membershipRecheck,
  QUEUES.contacts,
  QUEUES.wanderer,
  QUEUES.discordRoles,
  QUEUES.tokenHealth,
  QUEUES.purge,
] as const;

export async function createQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(QUEUES.deadLetter);
  for (const name of JOB_QUEUES) {
    // policy "short": singletonKey uniqueness only exists under this policy
    // (pg-boss job_i1 partial index) — standard queues ignore singletonKey.
    // Final-retry failures dead-letter into ops-dead-letter → ops webhook.
    await boss.createQueue(name, {
      name,
      policy: "short",
      ...RETRY,
      deadLetter: QUEUES.deadLetter,
    });
  }
}

/**
 * Spec schedules. pg-boss allows ONE schedule per queue, which is why the
 * weekly affiliation_invalid recheck is its own queue. Hourly jobs are
 * staggered to avoid stampeding shared integrations.
 */
export async function scheduleJobs(boss: PgBoss): Promise<void> {
  // Schedules share the dispatcher's global singleton keys so a scheduled
  // tick and an on-demand global trigger coalesce instead of double-queueing.
  await boss.schedule(
    QUEUES.membership,
    "*/30 * * * *",
    { jobType: QUEUES.membership },
    { singletonKey: "membership:all" },
  );
  await boss.schedule(
    QUEUES.membershipRecheck,
    "0 4 * * 0",
    { jobType: QUEUES.membershipRecheck },
    { singletonKey: "membership-recheck:all" },
  );
  await boss.schedule(
    QUEUES.contacts,
    "5 * * * *",
    { jobType: QUEUES.contacts },
    { singletonKey: "contacts:all" },
  );
  await boss.schedule(
    QUEUES.wanderer,
    "10 * * * *",
    { jobType: QUEUES.wanderer },
    { singletonKey: "wanderer:all" },
  );
  await boss.schedule(
    QUEUES.discordRoles,
    "15 * * * *",
    { jobType: QUEUES.discordRoles },
    { singletonKey: "roles:all" },
  );
  await boss.schedule(
    QUEUES.tokenHealth,
    "0 3 * * *",
    { jobType: QUEUES.tokenHealth },
    { singletonKey: "token-health:all" },
  );
  await boss.schedule(
    QUEUES.purge,
    "30 3 * * *",
    { jobType: QUEUES.purge },
    { singletonKey: "purge:all" },
  );
}

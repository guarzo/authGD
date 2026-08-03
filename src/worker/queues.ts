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
  // Dead-letter queue: retry options apply to jobs SENT to it directly.
  // Auto-dead-lettered jobs inherit the ORIGINAL job's retry_limit (pg-boss
  // copies it in the dlq_jobs insert — src/plans.js), so failed ops alerts
  // retry ~5 times via inheritance from the job queues below.
  const dlqOptions = { name: QUEUES.deadLetter, ...RETRY };
  await boss.createQueue(QUEUES.deadLetter, dlqOptions);
  await boss.updateQueue(QUEUES.deadLetter, dlqOptions);
  // updateQueue COALESCEs every field, so it can overwrite stale values but
  // NEVER clear one. The one value we need absent — a dead-letter target on
  // the DLQ itself, which would bounce alerts elsewhere — is therefore
  // inspected explicitly, failing startup with the manual fix.
  const dlq = await boss.getQueue(QUEUES.deadLetter);
  if (dlq?.deadLetter) {
    throw new Error(
      `queue ${QUEUES.deadLetter} has a dead-letter target (${dlq.deadLetter}) ` +
        `that pg-boss cannot clear via updateQueue; remove it manually: ` +
        `UPDATE pgboss.queue SET dead_letter = NULL WHERE name = '${QUEUES.deadLetter}'`,
    );
  }
  for (const name of JOB_QUEUES) {
    // policy "short": singletonKey uniqueness only exists under this policy
    // (pg-boss job_i1 partial index) — standard queues ignore singletonKey.
    // Final-retry failures dead-letter into ops-dead-letter → ops webhook.
    const options = {
      name,
      policy: "short" as const,
      ...RETRY,
      deadLetter: QUEUES.deadLetter,
    };
    // createQueue is ON CONFLICT DO NOTHING: an existing queue keeps stale
    // settings, so updateQueue repairs configuration on every startup. The
    // repair guarantee is limited to fields we SET — job queues pass every
    // managed field with a non-null value, so all of them are repaired; only
    // clearing a value is impossible (see the DLQ inspection above).
    await boss.createQueue(name, options);
    await boss.updateQueue(name, options);
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

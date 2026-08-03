import type PgBoss from "pg-boss";
import { JOB_CRON } from "@/core/schedules";

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
 *
 * The cron expressions themselves live in `@/core/schedules` because the admin
 * sync page renders their cadence: registering from the same constant is what
 * makes that display a fact rather than a second copy that can rot.
 */
export async function scheduleJobs(boss: PgBoss): Promise<void> {
  // Schedules share the dispatcher's global singleton keys so a scheduled
  // tick and an on-demand global trigger coalesce instead of double-queueing.
  const singletonKeys: Record<string, string> = {
    [QUEUES.membership]: "membership:all",
    [QUEUES.membershipRecheck]: "membership-recheck:all",
    [QUEUES.contacts]: "contacts:all",
    [QUEUES.wanderer]: "wanderer:all",
    [QUEUES.discordRoles]: "roles:all",
    [QUEUES.tokenHealth]: "token-health:all",
    [QUEUES.purge]: "purge:all",
  };
  for (const name of JOB_QUEUES) {
    const cron = JOB_CRON[name];
    // A queue with no cron entry would silently never tick. Fail startup
    // instead: the boot watchdog turns that into an alert an admin can see.
    if (!cron) throw new Error(`queue ${name} has no schedule in JOB_CRON`);
    await boss.schedule(
      name,
      cron,
      { jobType: name },
      { singletonKey: singletonKeys[name] },
    );
  }
}

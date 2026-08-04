import type { Db } from "@/db";
import { markDispatched, takeUndispatched, type OutboxPayload } from "@/services/outbox";
import { globalSingletonKey, QUEUES } from "@/worker/queues";

export type QueueSend = (
  queue: string,
  data: Record<string, unknown>,
  options: { singletonKey: string },
) => Promise<unknown>;

/**
 * Queues a "job" payload is allowed to name. Built from QUEUES minus the
 * dead-letter queue, which is ops plumbing and not a job anyone re-runs. This
 * is the allow-list that stops a bad `jobType` from becoming an arbitrary
 * queue name at send time.
 *
 * Exported for the set-equality test in tests/dispatcher.test.ts: the admin
 * page renders a re-run button per `JOB_CRON` key, and a key with no queue
 * here would render a button whose outbox row this module silently drops.
 */
export const RERUNNABLE: ReadonlySet<string> = new Set(
  Object.values(QUEUES).filter((q) => q !== QUEUES.deadLetter),
);

/**
 * Maps one outbox payload to its pg-boss sends. Membership and Discord roles
 * are account-scopable; the desired contact/ACL sets are GLOBAL (every member
 * pushes every other member), so account changes fan out to global
 * reconciliations, coalesced by fixed singleton keys from `globalSingletonKey`
 * — the same function `scheduleJobs` keys its cron ticks with. Every payload
 * carries jobType so the dead-letter handler can name the failed job.
 *
 * `rowId` is only for the drop log. Without it a dropped row and a delivered
 * one look identical afterwards (`markDispatched` stamps both), so the admin
 * sees "wanderer queued", refreshes, sees nothing, and presses again.
 */
export function planDispatch(
  payload: OutboxPayload,
  rowId?: number,
): Array<{ queue: string; data: Record<string, unknown>; singletonKey: string }> {
  // `payload` is jsonb NOT NULL, which does NOT exclude the JSON value `null`:
  // `'null'::jsonb IS NULL` is false, so the column accepts it and the declared
  // type is a compile-time claim the database never checked. Reading `.kind`
  // off it throws a TypeError, and a throw here is the exact failure the drop
  // arm below exists to prevent — see its comment. `takeUndispatched` orders by
  // id ascending, so one such row sits at the head of every claim and wedges
  // all sync dispatch behind it, permanently.
  const raw: unknown = payload;
  if (raw === null || typeof raw !== "object" || !("kind" in raw)) {
    console.error("outbox payload is not an object with a kind; dropping row", {
      rowId,
      payload,
    });
    return [];
  }

  switch (payload.kind) {
    case "account":
      return [
        {
          queue: QUEUES.membership,
          data: { jobType: QUEUES.membership, accountId: payload.accountId },
          singletonKey: `membership:${payload.accountId}`,
        },
        {
          queue: QUEUES.contacts,
          data: { jobType: QUEUES.contacts },
          singletonKey: globalSingletonKey(QUEUES.contacts),
        },
        {
          queue: QUEUES.wanderer,
          data: { jobType: QUEUES.wanderer },
          singletonKey: globalSingletonKey(QUEUES.wanderer),
        },
        {
          queue: QUEUES.discordRoles,
          data: { jobType: QUEUES.discordRoles, accountId: payload.accountId },
          singletonKey: `roles:${payload.accountId}`,
        },
      ];
    case "discord-user":
      return [
        {
          queue: QUEUES.discordRoles,
          data: { jobType: QUEUES.discordRoles, discordUserId: payload.discordUserId },
          singletonKey: `roles:user:${payload.discordUserId}`,
        },
      ];
    case "membership-recheck":
      return [
        {
          queue: QUEUES.membershipRecheck,
          data: { jobType: QUEUES.membershipRecheck },
          singletonKey: globalSingletonKey(QUEUES.membershipRecheck),
        },
      ];
    case "all":
      return [
        {
          queue: QUEUES.membership,
          data: { jobType: QUEUES.membership },
          singletonKey: globalSingletonKey(QUEUES.membership),
        },
        {
          queue: QUEUES.contacts,
          data: { jobType: QUEUES.contacts },
          singletonKey: globalSingletonKey(QUEUES.contacts),
        },
        {
          queue: QUEUES.wanderer,
          data: { jobType: QUEUES.wanderer },
          singletonKey: globalSingletonKey(QUEUES.wanderer),
        },
        {
          queue: QUEUES.discordRoles,
          data: { jobType: QUEUES.discordRoles },
          singletonKey: globalSingletonKey(QUEUES.discordRoles),
        },
      ];
    case "job": {
      // Re-run one named job. An unrecognized jobType breaks out to the drop
      // arm below rather than being sent, so a bad row can never enqueue to a
      // queue pg-boss has not been told about.
      if (!RERUNNABLE.has(payload.jobType)) break;
      return [
        {
          queue: payload.jobType,
          data: { jobType: payload.jobType },
          singletonKey: globalSingletonKey(payload.jobType),
        },
      ];
    }
  }
  // An unrecognized kind (an older worker reading a row written by a newer web
  // tier, or a hand-written row) must NOT throw: planDispatch runs inside
  // dispatchOutbox's transaction, so a throw rolls the claim back for every row
  // in the batch and the 2s retry loop then wedges all sync dispatch behind
  // that one row. Drop it instead — it gets marked dispatched, and the log
  // names both the row and what was lost.
  console.error("outbox payload not dispatchable; dropping row", { rowId, payload });
  return [];
}

/**
 * Claims undispatched rows and enqueues their jobs in ONE transaction (the
 * takeUndispatched/markDispatched contract): a failed send rolls the claim
 * back so rows are re-attempted next tick. FOR UPDATE SKIP LOCKED makes
 * concurrent dispatchers safe without advisory locks.
 *
 * At-least-once contract: sends happen inside the transaction that also
 * marks rows dispatched, but the two are not atomic with each other beyond
 * the transaction boundary — if the transaction fails to commit AFTER the
 * sends have gone out (e.g. a commit-time failure), those jobs are already
 * enqueued while their outbox rows remain undispatched. The next tick will
 * re-claim and re-send the same rows; pg-boss's singleton keys coalesce the
 * resulting duplicates, so this is safe but not exactly-once.
 */
export async function dispatchOutbox(db: Db, send: QueueSend): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await takeUndispatched(tx);
    if (rows.length === 0) return 0;
    for (const row of rows) {
      for (const job of planDispatch(row.payload, row.id)) {
        await send(job.queue, job.data, { singletonKey: job.singletonKey });
      }
    }
    await markDispatched(
      tx,
      rows.map((r) => r.id),
    );
    return rows.length;
  });
}

export function startDispatcher(
  db: Db,
  send: QueueSend,
  intervalMs = 2000,
): () => Promise<void> {
  let running = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    inFlight = dispatchOutbox(db, send)
      .catch((err) => console.error("outbox dispatch failed", err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return async () => {
    clearInterval(timer);
    await inFlight;
  };
}

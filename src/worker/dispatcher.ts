import type { Db } from "@/db";
import { markDispatched, takeUndispatched, type OutboxPayload } from "@/services/outbox";
import { QUEUES } from "@/worker/queues";

export type QueueSend = (
  queue: string,
  data: Record<string, unknown>,
  options: { singletonKey: string },
) => Promise<unknown>;

/**
 * Maps one outbox payload to its pg-boss sends. Membership and Discord roles
 * are account-scopable; the desired contact/ACL sets are GLOBAL (every member
 * pushes every other member), so account changes fan out to global
 * reconciliations, coalesced by fixed singleton keys. Every payload carries
 * jobType so the dead-letter handler can name the failed job.
 */
export function planDispatch(
  payload: OutboxPayload,
): Array<{ queue: string; data: Record<string, unknown>; singletonKey: string }> {
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
          singletonKey: "contacts:all",
        },
        {
          queue: QUEUES.wanderer,
          data: { jobType: QUEUES.wanderer },
          singletonKey: "wanderer:all",
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
          singletonKey: "membership-recheck:all",
        },
      ];
    case "all":
      return [
        {
          queue: QUEUES.membership,
          data: { jobType: QUEUES.membership },
          singletonKey: "membership:all",
        },
        {
          queue: QUEUES.contacts,
          data: { jobType: QUEUES.contacts },
          singletonKey: "contacts:all",
        },
        {
          queue: QUEUES.wanderer,
          data: { jobType: QUEUES.wanderer },
          singletonKey: "wanderer:all",
        },
        {
          queue: QUEUES.discordRoles,
          data: { jobType: QUEUES.discordRoles },
          singletonKey: "roles:all",
        },
      ];
  }
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
      for (const job of planDispatch(row.payload)) {
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

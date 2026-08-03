import { and, isNotNull, lt, or } from "drizzle-orm";
import type { Db } from "@/db";
import { oauthTransaction, outbox, session } from "@/db/schema";
import { runJob, type JobResult } from "@/services/sync-run";

const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Carry-over hygiene: expired sessions, spent OAuth transactions, and old
 * DISPATCHED outbox rows (undispatched rows are never purged). */
export async function runPurgeJob(deps: { db: Db }): Promise<JobResult> {
  const { db } = deps;
  return runJob(db, "purge", async () => {
    const now = new Date();
    const sessions = await db
      .delete(session)
      .where(lt(session.expiresAt, now))
      .returning({ id: session.id });
    const oauth = await db
      .delete(oauthTransaction)
      .where(
        or(
          isNotNull(oauthTransaction.consumedAt),
          lt(oauthTransaction.expiresAt, now),
        ),
      )
      .returning({ id: oauthTransaction.id });
    const outboxRows = await db
      .delete(outbox)
      .where(
        and(
          isNotNull(outbox.dispatchedAt),
          lt(outbox.createdAt, new Date(Date.now() - OUTBOX_RETENTION_MS)),
        ),
      )
      .returning({ id: outbox.id });
    return {
      status: "ok",
      counts: {
        sessions: sessions.length,
        oauthTransactions: oauth.length,
        outbox: outboxRows.length,
      },
    };
  });
}

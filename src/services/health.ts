import { desc, sql } from "drizzle-orm";
import type { Dbx } from "@/db";
import { syncRun } from "@/db/schema";

/** Cheapest possible proof that a backend is reachable and answering. */
export async function checkLiveness(dbx: Dbx): Promise<boolean> {
  try {
    await dbx.execute(sql`select 1`);
    return true;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Newest run by serial primary key, NOT by max(started_at): the only index is
 * (job_type, id desc), so max(started_at) would seq-scan a table growing ~122
 * rows/day. started_at defaults to insert time, so id order and insertion order
 * can only disagree by the width of a race — far below a 90-minute threshold.
 */
export async function newestSyncRun(
  dbx: Dbx,
): Promise<{ jobType: string; startedAt: Date } | null> {
  const rows = await dbx
    .select({ jobType: syncRun.jobType, startedAt: syncRun.startedAt })
    .from(syncRun)
    .orderBy(desc(syncRun.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The most recent instant pg-boss's own maintenance loop touched this
 * database, or null when there is no evidence of one ever having run here.
 *
 * Deliberately not derived from `sync_run`: that table only gains a row when
 * a JOB fires, so it cannot tell "the worker process is dead" from "the
 * worker is alive and none of its jobs happened to be due" — see
 * `HEARTBEAT_STALE_AFTER_MS` in `@/core/health`. `pgboss.version.maintained_on`
 * is written by every worker process's `boss.start()` supervisor loop on a
 * fixed ~120s cadence with no job involved at all, so it is unconditional
 * proof the *process*, not any particular queue, is alive.
 *
 * A single row lives in `pgboss.version` in the steady state, but the exact
 * cardinality is pg-boss's own implementation detail, not this app's — `max`
 * reads correctly whether there is one row or several.
 *
 * The `pgboss` schema is created by pg-boss itself the first time a worker
 * calls `boss.start()` against this database, not by this app's own Drizzle
 * migrations, so a database no worker has ever touched yet has no such
 * schema at all — undefined_table, Postgres code 42P01. That is the same
 * "no evidence either way" case as an empty table, not a fault, so it falls
 * open to null there and only logs (and still returns null) for anything
 * else, matching `checkLiveness`'s own posture toward a database that is
 * unreachable rather than merely young.
 */
export async function workerHeartbeat(dbx: Dbx): Promise<Date | null> {
  try {
    // Drizzle's node-postgres driver deliberately leaves timestamptz columns
    // as pg's own raw text output (`val => val` in its getTypeParser
    // override) on a raw `.execute()` — its schema-typed `.select()` is the
    // only path that maps them to `Date` — so this reads back a string like
    // `2026-08-05 21:54:25.784+00`, not a `Date`, and has to parse it itself.
    const result = await dbx.execute<{ maintained_on: string | null }>(
      sql`select max(maintained_on) as maintained_on from pgboss.version`,
    );
    const raw = result.rows[0]?.maintained_on;
    return raw ? new Date(raw) : null;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "42P01") return null;
    console.error(err instanceof Error ? err.message : err);
    return null;
  }
}

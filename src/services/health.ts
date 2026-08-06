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
 * `at`'s null carries two genuinely different meanings, which is why this is
 * a tagged union rather than plain `Date | null`:
 *   - `status: "never"` — no evidence a worker has ever run here (no pgboss
 *     schema yet, or the table exists but is empty). This is a real state,
 *     not a fault.
 *   - `status: "error"` — the read itself failed (permissions, connectivity,
 *     a value that came back but didn't parse as a timestamp, ...). This
 *     says nothing about whether the worker is alive; collapsing it into
 *     "never" told an admin "no heartbeat recorded" about a worker that
 *     could be perfectly healthy, purely because *this* query couldn't
 *     answer.
 *
 * `"error"`'s `message` is a raw driver/Postgres string (e.g. "permission
 * denied for schema pgboss") — useful in `console.error` and in a log
 * aggregator, which is its only reader today. Not vetted for a browser: if a
 * future caller renders it on `/admin/sync` to answer "why did the check
 * fail", that caller is the one responsible for deciding whether an
 * unfiltered DB error string is safe to show, not this function.
 */
export type WorkerHeartbeat =
  { status: "ok"; at: Date } | { status: "never" } | { status: "error"; message: string };

/**
 * The most recent instant pg-boss's own maintenance loop touched this
 * database, tagged with why there might be no timestamp — see
 * `WorkerHeartbeat` above.
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
 * "no evidence either way" case as an empty table, not a fault, so both fall
 * open to `"never"`. Anything else is caught and returned as `"error"` rather
 * than thrown, matching `checkLiveness`'s own posture toward a database that
 * is unreachable rather than merely young — this is a regression guard, not
 * an oversight: letting a transient DB fault on this auxiliary check reach
 * the page's error boundary would take down the whole `/admin/sync` page
 * over a line that exists to report on the *worker*, not the web process
 * rendering it.
 */
export async function workerHeartbeat(dbx: Dbx): Promise<WorkerHeartbeat> {
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
    if (!raw) return { status: "never" };
    const at = new Date(raw);
    // `"ok"` is a promise this carries a real instant — `evaluateFreshness`
    // and every caller trust `at` to feed `Date` arithmetic without checking
    // it first. An unparseable `raw` (pg-boss's own format changing, a
    // driver regression in the raw-text path this function's own comment
    // above depends on) would otherwise tag an Invalid Date "ok" and leave
    // `ageSec: NaN` to surface wherever `elapsedShort` renders it — a
    // malformed value read as "never happened" (WCAG territory, not just
    // pg-boss's), not "up to date". `"error"`, not `"never"`: `raw` being
    // NON-null means pg-boss's own maintenance loop wrote SOMETHING, so this
    // is the same "the check itself failed to produce an answer" case as the
    // catch below, not "no evidence a worker has ever run" — the evidence is
    // sitting right there, just not parseable.
    if (Number.isNaN(at.getTime())) {
      const message = `pgboss.version.maintained_on was not a parseable timestamp: ${raw}`;
      console.error(message);
      return { status: "error", message };
    }
    return { status: "ok", at };
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "42P01") {
      return { status: "never" };
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return { status: "error", message };
  }
}

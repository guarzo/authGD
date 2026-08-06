import { NextResponse } from "next/server";
import { evaluateFreshness } from "@/core/health";
import { getDb } from "@/db";
import { newestSyncRun } from "@/services/health";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Worker freshness. NEVER wire this into fly.toml: a stalled worker would pull
 * healthy web machines out of rotation and could stall a deploy that was never
 * unhealthy. It exists for the external uptime monitor.
 *
 * This deliberately answers a different question from the worker-liveness line
 * on /admin/sync, and the two will disagree — by design, for up to ~84 minutes.
 * Here, `evaluateFreshness` runs on its default `STALE_AFTER_MS` (90 min): the
 * newest `sync_run` row, i.e. "is work still coming out of the worker." The
 * admin page runs it on `HEARTBEAT_STALE_AFTER_MS` (6 min) against pg-boss's
 * own `maintained_on`, i.e. "is a worker process alive right now." A worker
 * that dies at 12:00 flips the admin page at ~12:06 and this endpoint at
 * ~13:30. That gap is the point — a human looking at the page wants the tight
 * signal, and a pager wants the one that cannot false-positive on a quiet
 * queue. Anyone reconciling the two should read `HEARTBEAT_STALE_AFTER_MS` in
 * `@/core/health`, which carries the full argument.
 */
export async function GET() {
  let newest: Awaited<ReturnType<typeof newestSyncRun>>;
  try {
    newest = await newestSyncRun(getDb());
  } catch (err) {
    // An unreachable database is a 503 with db:"error", never an undocumented
    // 500: the monitor must be able to tell a dead worker from a dead database.
    console.error(err instanceof Error ? err.message : err);
    return NextResponse.json(
      { ok: false, db: "error", newestRunAgeSec: null, newestJobType: null },
      { status: 503, headers: NO_STORE },
    );
  }
  const { fresh, ageSec } = evaluateFreshness(newest?.startedAt ?? null, new Date());
  return NextResponse.json(
    {
      ok: fresh,
      db: "ok",
      newestRunAgeSec: ageSec,
      newestJobType: newest?.jobType ?? null,
    },
    { status: fresh ? 200 : 503, headers: NO_STORE },
  );
}

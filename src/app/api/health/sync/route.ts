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

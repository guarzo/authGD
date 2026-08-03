import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getWorkerLiveness, type WorkerLiveness } from "@/services/worker-health";

export const dynamic = "force-dynamic";

type ReadyBody = {
  status: "ok" | "error";
  config: "ok" | "error";
  database: "ok" | "error" | "skipped";
  worker: WorkerLiveness | { status: "skipped" };
  invalid?: string[];
};

/**
 * Readiness for the whole deployment: config, database reachability, and
 * whether the WORKER is still doing work.
 *
 * Deliberately NOT wired to Fly's automatic restarts (see fly.toml). Restarting
 * a web machine cannot fix a dead worker or an unreachable database, and doing
 * so would turn one outage into a restart storm. This endpoint exists to be
 * polled by something outside the app that can page a human.
 *
 * The worker signal is the point of this endpoint. The `worker` process group
 * has no HTTP listener, so nothing can probe it directly; instead we read the
 * `sync_run` table it writes to on every job. See src/services/worker-health.ts
 * for exactly what that does and does not assert.
 *
 * Returns 503 if ANY check fails, so a dumb HTTP poller that only understands
 * status codes still catches all three. The body says which one.
 *
 * Unauthenticated, same as /healthz: env var names only, never values.
 */
export async function GET(): Promise<NextResponse> {
  const body: ReadyBody = {
    status: "ok",
    config: "ok",
    database: "skipped",
    worker: { status: "skipped" },
  };

  try {
    getConfig();
  } catch (err) {
    console.error("readyz: config invalid", err);
    body.status = "error";
    body.config = "error";
    if (err instanceof ZodError) {
      body.invalid = [
        ...new Set(err.issues.map((i) => i.path.join(".")).filter(Boolean)),
      ].sort();
    }
    // Both remaining checks need DATABASE_URL, which is one of the things that
    // may have just failed validation. Report config and stop.
    return NextResponse.json(body, { status: 503 });
  }

  try {
    const db = getDb();
    await db.execute(sql`select 1`);
    body.database = "ok";
    body.worker = await getWorkerLiveness(db);
    if (body.worker.status !== "ok") body.status = "error";
  } catch (err) {
    console.error("readyz: database unreachable", err);
    body.status = "error";
    body.database = "error";
  }

  return NextResponse.json(body, { status: body.status === "ok" ? 200 : 503 });
}

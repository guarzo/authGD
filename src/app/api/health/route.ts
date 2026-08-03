import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { checkLiveness } from "@/services/health";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Liveness only: this process serves, and Postgres answers. Safe to wire to
 * Fly's http_service checks. Worker health deliberately lives at
 * /api/health/sync so a stalled worker cannot pull web machines out of rotation.
 */
export async function GET() {
  const ok = await checkLiveness(getDb());
  return NextResponse.json(
    { ok, db: ok ? "ok" : "error" },
    { status: ok ? 200 : 503, headers: NO_STORE },
  );
}

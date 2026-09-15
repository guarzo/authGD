import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { resolveAdmin } from "@/lib/admin-guard";
import {
  collectRecruitmentEvidence,
  RecruitmentCollectionError,
} from "@/services/recruitment";

export const runtime = "nodejs";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const statuses = {
  not_authorized: 403,
  not_found: 404,
  identity_changed: 409,
  collection_failed: 503,
} as const;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const fail = (error: string, status: number) =>
    NextResponse.json({ error }, { status, headers });
  try {
    const cfg = getConfig();
    // This route is not a Server Action: enforce its browser CSRF boundary here.
    if (
      req.headers.get("origin") !== new URL(cfg.appBaseUrl).origin ||
      (req.headers.has("sec-fetch-site") &&
        req.headers.get("sec-fetch-site") !== "same-origin")
    ) {
      return fail("not_authorized", 403);
    }
    const db = getDb();
    const sessionId = req.cookies.get(cfg.sessionCookieName)?.value;
    const actor = await db.transaction(async (tx) => {
      // Session lookup can touch lastSeenAt; bound its lock wait as well as
      // the later collection service's database work, without holding I/O locks.
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`set local statement_timeout = '10s'`);
      return resolveAdmin(tx, sessionId);
    });
    if (!actor.ok || !sessionId) return fail("not_authorized", 403);
    const target = z.uuid().safeParse((await params).id);
    if (!target.success) return fail("invalid_account", 400);
    const snapshot = await collectRecruitmentEvidence(db, cfg, {
      actorAccountId: actor.ctx.accountId,
      sessionId,
      targetAccountId: target.data,
    });
    return NextResponse.json(snapshot, {
      headers: {
        ...headers,
        "Content-Disposition": `attachment; filename="recruitment-${target.data}.json"`,
      },
    });
  } catch (error) {
    if (error instanceof RecruitmentCollectionError)
      return fail(error.code, statuses[error.code]);
    // SQL and upstream exceptions may contain credentials or applicant data.
    return fail("collection_failed", 503);
  }
}

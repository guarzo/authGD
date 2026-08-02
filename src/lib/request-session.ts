import type { NextRequest } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getSessionAccount } from "@/services/session";

export async function getRequestAccount(
  req: NextRequest,
): Promise<{ accountId: string; sessionId: string } | null> {
  const cfg = getConfig();
  const sid = req.cookies.get(cfg.sessionCookieName)?.value;
  if (!sid) return null;
  const resolved = await getSessionAccount(getDb(), sid);
  if (!resolved) return null;
  return { accountId: resolved.accountId, sessionId: sid };
}

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { buildDiscordAuthorizeUrl } from "@/lib/discord/oauth";
import { getRequestAccount } from "@/lib/request-session";
import { createOauthTransaction } from "@/services/oauth-tx";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const sess = await getRequestAccount(req);
  if (!sess) return NextResponse.redirect(new URL("/login", cfg.appBaseUrl));
  const tx = await createOauthTransaction(getDb(), {
    intent: "link-discord",
    sessionId: sess.sessionId,
    accountId: sess.accountId,
  });
  return NextResponse.redirect(buildDiscordAuthorizeUrl(cfg, tx.state, tx.codeChallenge));
}

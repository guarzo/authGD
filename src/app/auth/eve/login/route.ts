import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { buildEveAuthorizeUrl } from "@/lib/esi/sso";
import { createOauthTransaction } from "@/services/oauth-tx";

export async function GET(_req: NextRequest) {
  const cfg = getConfig();
  const tx = await createOauthTransaction(getDb(), { intent: "login" });
  return NextResponse.redirect(buildEveAuthorizeUrl(cfg, tx.state, tx.codeChallenge));
}

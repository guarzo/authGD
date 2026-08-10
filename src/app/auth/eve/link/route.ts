import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { ACCESS_LISTS_SCOPE } from "@/lib/esi/client";
import { buildEveAuthorizeUrl } from "@/lib/esi/sso";
import { getRequestAccount } from "@/lib/request-session";
import { createOauthTransaction } from "@/services/oauth-tx";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const sess = await getRequestAccount(req);
  if (!sess) return NextResponse.redirect(new URL("/login", cfg.appBaseUrl));
  const tx = await createOauthTransaction(getDb(), {
    intent: "link-character",
    sessionId: sess.sessionId,
    accountId: sess.accountId,
  });
  // Opt-in only: esi-access.read_lists.v1 is deliberately NOT in
  // EVE_SSO_SCOPES, because adding it there would flip every character to
  // needs_reauth at the next token-health run. An exact literal, not a
  // free-form scope parameter — the query string is attacker-controllable and
  // must not be able to widen what we ask EVE for.
  const extraScopes =
    req.nextUrl.searchParams.get("grant") === "access-lists" ? [ACCESS_LISTS_SCOPE] : [];
  return NextResponse.redirect(
    buildEveAuthorizeUrl(cfg, tx.state, tx.codeChallenge, extraScopes),
  );
}

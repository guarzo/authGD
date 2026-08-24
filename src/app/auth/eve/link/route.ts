import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import {
  ACCESS_LISTS_SCOPE,
  NOTIFICATIONS_SCOPE,
  STRUCTURES_SCOPE,
} from "@/lib/esi/client";
import { buildEveAuthorizeUrl } from "@/lib/esi/sso";
import { getRequestAccount } from "@/lib/request-session";
import { createOauthTransaction } from "@/services/oauth-tx";

// Opt-in only: none of these are in EVE_SSO_SCOPES, because adding one there
// would flip every character to needs_reauth at the next token-health run.
// Exact literals keyed by an allowed grant name, never a free-form scope
// parameter — the query string is attacker-controllable and must not be able
// to widen what we ask EVE for.
const GRANTS: Record<string, readonly string[]> = {
  "access-lists": [ACCESS_LISTS_SCOPE],
  structures: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
};

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const sess = await getRequestAccount(req);
  if (!sess) return NextResponse.redirect(new URL("/login", cfg.appBaseUrl));
  const tx = await createOauthTransaction(getDb(), {
    intent: "link-character",
    sessionId: sess.sessionId,
    accountId: sess.accountId,
  });
  const extraScopes = [...(GRANTS[req.nextUrl.searchParams.get("grant") ?? ""] ?? [])];
  return NextResponse.redirect(
    buildEveAuthorizeUrl(cfg, tx.state, tx.codeChallenge, extraScopes),
  );
}

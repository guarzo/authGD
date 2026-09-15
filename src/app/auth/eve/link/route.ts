import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { character } from "@/db/schema";
import { accountErrorUrl } from "@/lib/error-redirects";
import {
  ACCESS_LISTS_SCOPE,
  FLEET_READ_SCOPE,
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
// to widen what we ask EVE for. A plain object literal also inherits
// Object.prototype's own members (toString, constructor, __proto__), so a
// bare `GRANTS[grant]` throws or returns a function for those three
// predictable strings; Object.hasOwn (same guard as core/schedules.ts's
// isJobType) is required before indexing, not optional hardening.
const GRANTS: Record<string, readonly string[]> = {
  "access-lists": [ACCESS_LISTS_SCOPE],
  structures: [STRUCTURES_SCOPE, NOTIFICATIONS_SCOPE],
  "fleet-read": [FLEET_READ_SCOPE],
};

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const sess = await getRequestAccount(req);
  if (!sess) return NextResponse.redirect(new URL("/login", cfg.appBaseUrl));
  const db = getDb();
  const grant = req.nextUrl.searchParams.get("grant") ?? "";
  const extraScopes = Object.hasOwn(GRANTS, grant) ? [...GRANTS[grant]] : [];
  const targets = req.nextUrl.searchParams.getAll("character");
  if (targets.length > 0) {
    const id = Number(targets[0]);
    const deny = () =>
      NextResponse.redirect(new URL(accountErrorUrl("link_failed"), cfg.appBaseUrl));
    if (
      targets.length !== 1 ||
      !/^\d+$/.test(targets[0]) ||
      !Number.isSafeInteger(id) ||
      id <= 0
    )
      return deny();
    const [owned] = await db
      .select({ scopes: character.scopes })
      .from(character)
      .where(and(eq(character.id, id), eq(character.accountId, sess.accountId)));
    if (!owned) return deny();
    // Reauthorising a known character must not drop its optional grants when
    // the shared baseline expands. Scopes come from the owned row, never URL input.
    // The EVE picker still chooses the character; this remains the normal link flow.
    extraScopes.push(...owned.scopes);
  }
  const tx = await createOauthTransaction(db, {
    intent: "link-character",
    sessionId: sess.sessionId,
    accountId: sess.accountId,
  });
  return NextResponse.redirect(
    buildEveAuthorizeUrl(cfg, tx.state, tx.codeChallenge, extraScopes),
  );
}

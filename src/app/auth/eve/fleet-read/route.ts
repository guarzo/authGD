import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { account, character } from "@/db/schema";
import { fleetSharingErrorUrl, loginErrorUrl } from "@/lib/error-redirects";
import { FLEET_READ_SCOPE } from "@/lib/esi/client";
import { buildEveAuthorizeUrl } from "@/lib/esi/sso";
import { getRequestAccount } from "@/lib/request-session";
import { createOauthTransaction } from "@/services/oauth-tx";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const to = (path: string) => NextResponse.redirect(new URL(path, cfg.appBaseUrl));
  try {
    const sess = await getRequestAccount(req);
    if (!sess) return to(loginErrorUrl("session_expired"));
    const values = req.nextUrl.searchParams.getAll("character");
    const characterId = Number(values[0]);
    if (
      values.length !== 1 ||
      !/^\d+$/.test(values[0]) ||
      !Number.isSafeInteger(characterId) ||
      characterId <= 0
    ) {
      return to(fleetSharingErrorUrl("identity_changed"));
    }
    const db = getDb();
    const [acc] = await db
      .select({ tier: account.tier })
      .from(account)
      .where(eq(account.id, sess.accountId));
    if (acc?.tier !== "member") return to(fleetSharingErrorUrl("not_eligible"));
    const [anchor] = await db
      .select({ scopes: character.scopes })
      .from(character)
      .where(and(eq(character.id, characterId), eq(character.accountId, sess.accountId)));
    if (!anchor) return to(fleetSharingErrorUrl("identity_changed"));

    // The picker cannot be targeted. Bind the expected identity in single-use
    // state, and recheck ownership/tier/scopes at completion, not under I/O locks.
    const tx = await createOauthTransaction(db, {
      intent: "grant-fleet-read",
      sessionId: sess.sessionId,
      accountId: sess.accountId,
      fleetReadCharacterId: characterId,
    });
    return NextResponse.redirect(
      buildEveAuthorizeUrl(cfg, tx.state, tx.codeChallenge, [
        ...anchor.scopes,
        FLEET_READ_SCOPE,
      ]),
    );
  } catch {
    // Database errors can carry statement parameters, including OAuth state.
    console.error("fleet read initiation failed");
    return to(fleetSharingErrorUrl("authorization_failed"));
  }
}

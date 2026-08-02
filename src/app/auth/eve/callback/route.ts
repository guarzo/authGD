import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { exchangeEveCode, verifyEveAccessToken } from "@/lib/esi/sso";
import { getRequestAccount } from "@/lib/request-session";
import {
  handleEveLogin,
  linkCharacter,
  type EveCallbackCharacter,
} from "@/services/accounts";
import { consumeOauthTransaction } from "@/services/oauth-tx";
import { createSession } from "@/services/session";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const db = getDb();
  // Provider denial (e.g. user clicked "cancel"): no code arrives, just error=
  if (req.nextUrl.searchParams.get("error")) {
    return NextResponse.redirect(new URL("/login?error=oauth_denied", cfg.appBaseUrl));
  }
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return new NextResponse("missing params", { status: 400 });

  // Only EVE intents are consumable here; a link-discord transaction is
  // rejected WITHOUT being consumed. All binding checks run before any EVE call.
  const tx = await consumeOauthTransaction(db, state, ["login", "link-character"]);
  if (!tx) return new NextResponse("invalid or expired state", { status: 400 });

  const sess = await getRequestAccount(req);
  if (
    tx.intent === "link-character" &&
    (!sess || sess.sessionId !== tx.sessionId || sess.accountId !== tx.accountId)
  ) {
    return new NextResponse("link transaction not valid for this session", {
      status: 403,
    });
  }

  const tokens = await exchangeEveCode(cfg, code, tx.pkceVerifier);
  const identity = await verifyEveAccessToken(tokens.accessToken);
  const ch: EveCallbackCharacter = {
    characterId: identity.characterId,
    characterName: identity.characterName,
    ownerHash: identity.ownerHash,
    scopes: identity.scopes,
    refreshToken: tokens.refreshToken,
  };

  if (tx.intent === "link-character") {
    const result = await db.transaction((dbtx) =>
      linkCharacter(dbtx, cfg, sess!.accountId, ch),
    );
    const dest = result.ok ? "/account" : "/account?error=already_linked";
    return NextResponse.redirect(new URL(dest, cfg.appBaseUrl));
  }

  const { accountId } = await db.transaction((dbtx) =>
    handleEveLogin(dbtx, cfg, ch),
  );
  const sid = await createSession(db, accountId);
  const res = NextResponse.redirect(new URL("/account", cfg.appBaseUrl));
  res.cookies.set(cfg.sessionCookieName, sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: cfg.appBaseUrl.startsWith("https"),
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}

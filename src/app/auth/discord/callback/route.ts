import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { exchangeDiscordCode, fetchDiscordUser } from "@/lib/discord/oauth";
import { getRequestAccount } from "@/lib/request-session";
import { DiscordLinkConflictError, linkDiscord } from "@/services/discord-link";
import { consumeOauthTransaction } from "@/services/oauth-tx";

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const db = getDb();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) return new NextResponse("missing params", { status: 400 });

  const tx = await consumeOauthTransaction(db, state, ["link-discord"]);
  if (!tx) {
    return new NextResponse("invalid or expired state", { status: 400 });
  }
  const sess = await getRequestAccount(req);
  if (!sess || sess.sessionId !== tx.sessionId || sess.accountId !== tx.accountId) {
    return new NextResponse("link transaction not valid for this session", {
      status: 403,
    });
  }
  const { accessToken } = await exchangeDiscordCode(cfg, code, tx.pkceVerifier);
  const user = await fetchDiscordUser(accessToken);
  let ok: boolean;
  try {
    const result = await db.transaction((dbtx) =>
      linkDiscord(dbtx, sess.accountId, user.id),
    );
    ok = result.ok;
  } catch (err) {
    if (err instanceof DiscordLinkConflictError) ok = false;
    else throw err;
  }
  const dest = ok ? "/account" : "/account?error=discord_already_linked";
  return NextResponse.redirect(new URL(dest, cfg.appBaseUrl));
}

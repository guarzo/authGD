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
  const to = (path: string) => NextResponse.redirect(new URL(path, cfg.appBaseUrl));

  // Provider denial (user declined the authorization): error param, no code
  if (req.nextUrl.searchParams.get("error")) return to("/account?error=discord_denied");

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  // Only reachable from the account page, so /account is right for every
  // failure here except a missing session.
  if (!code || !state) return to("/account?error=discord_failed");

  const tx = await consumeOauthTransaction(db, state, ["link-discord"]);
  if (!tx) return to("/account?error=discord_expired");

  const sess = await getRequestAccount(req);
  if (!sess || sess.sessionId !== tx.sessionId || sess.accountId !== tx.accountId) {
    // The transaction is consumed above, so neither destination can be replayed.
    return to(sess ? "/account?error=discord_expired" : "/login?error=session_expired");
  }

  // Route handlers are not covered by app/error.tsx, so an uncaught throw from
  // Discord or the database is a bare 500 with no way back to the account page.
  try {
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
    return to(ok ? "/account" : "/account?error=discord_already_linked");
  } catch (err) {
    // Message only, for the reason spelled out in the EVE callback: a Postgres
    // error object can carry the failing query and its parameters alongside the
    // message, and those rows hold token material.
    console.error("discord callback failed", err instanceof Error ? err.message : err);
    return to("/account?error=discord_failed");
  }
}

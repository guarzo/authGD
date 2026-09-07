import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { exchangeEveCode, verifyEveAccessToken } from "@/lib/esi/sso";
import {
  accountErrorUrl,
  fleetSharingErrorUrl,
  fleetSharingNoticeUrl,
  loginErrorUrl,
  type AccountErrorCode,
} from "@/lib/error-redirects";
import { getRequestAccount } from "@/lib/request-session";
import { sessionCookieAttrs } from "@/lib/session-cookie";
import {
  completeFleetReadGrant,
  handleEveLogin,
  linkCharacter,
  type EveCallbackCharacter,
  type MergeBlocker,
} from "@/services/accounts";
import { consumeOauthTransaction, hasFleetReadContext } from "@/services/oauth-tx";
import { createSession } from "@/services/session";
import { fleetLifecycleTransaction } from "@/services/fleet-lifecycle";

/**
 * A refused merge's reason, as the code whose copy explains it.
 *
 * The map lives here and not in error-redirects.ts because that module
 * deliberately imports nothing (see its header): a service type crossing into
 * it would make it the first inversion, for a lookup table. Typed as a total
 * Record, so adding a `MergeBlocker` with no copy to show for it is a
 * typecheck failure rather than a member seeing an unexplained page.
 */
const MERGE_BLOCKER_ERRORS: Record<MergeBlocker, AccountErrorCode> = {
  admin: "merge_admin",
  tier_locked: "merge_tier_locked",
  status: "merge_status",
  note: "merge_note",
  characters: "merge_characters",
  discord: "merge_discord",
  payouts: "merge_payouts",
};

export async function GET(req: NextRequest) {
  const cfg = getConfig();
  const db = getDb();
  const to = (path: string) => NextResponse.redirect(new URL(path, cfg.appBaseUrl));

  const denied = !!req.nextUrl.searchParams.get("error");
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (denied && !state) return to(loginErrorUrl("oauth_denied"));
  // Without state there is no transaction, so nothing tells us whether this was
  // a login or a character link. /login is the only destination we can be sure
  // is correct for either.
  if ((!code && !denied) || !state) return to(loginErrorUrl("oauth_failed"));

  // Preserve legacy cancellation behavior (including leaving its state alone).
  // Only a targeted grant carries enough context for a Fleet sharing notice.
  // Other providers' intents are rejected WITHOUT being consumed.
  const tx = await consumeOauthTransaction(
    db,
    state,
    denied ? ["grant-fleet-read"] : ["login", "link-character", "grant-fleet-read"],
  );
  if (!tx) return to(loginErrorUrl(denied ? "oauth_denied" : "oauth_expired"));

  if (tx.intent === "grant-fleet-read" && !hasFleetReadContext(tx)) {
    return to(fleetSharingErrorUrl("authorization_expired"));
  }
  const sess = await getRequestAccount(req);
  if (
    (tx.intent === "link-character" || tx.intent === "grant-fleet-read") &&
    (!sess || sess.sessionId !== tx.sessionId || sess.accountId !== tx.accountId)
  ) {
    // The transaction is already consumed above, so neither destination can be
    // replayed. Signed in but holding someone else's (or a stale) transaction
    // means retrying from the account page; no session at all means the session
    // is the thing that's missing.
    return to(
      tx.intent === "grant-fleet-read"
        ? fleetSharingErrorUrl("authorization_expired")
        : sess
          ? accountErrorUrl("link_expired")
          : loginErrorUrl("session_expired"),
    );
  }
  if (denied) return to(fleetSharingNoticeUrl("authorization_cancelled"));

  // Everything past here talks to EVE or the database, and route handlers are
  // not covered by app/error.tsx — an uncaught throw here is a bare 500 with no
  // way back. One catch covers the whole remote/DB stretch.
  try {
    const tokens = await exchangeEveCode(cfg, code!, tx.pkceVerifier);
    const identity = await verifyEveAccessToken(tokens.accessToken);
    const ch: EveCallbackCharacter = {
      characterId: identity.characterId,
      characterName: identity.characterName,
      ownerHash: identity.ownerHash,
      scopes: identity.scopes,
      refreshToken: tokens.refreshToken,
    };

    if (tx.intent === "grant-fleet-read") {
      // Explicit grant-only dispatch. A nullable target on link-character would
      // let old callback replicas ignore the binding and merge the wrong account.
      const result = await fleetLifecycleTransaction(db, (dbtx) =>
        completeFleetReadGrant(
          dbtx,
          cfg,
          tx.accountId!,
          tx.fleetReadCharacterId!,
          ch,
          tx.sessionId!,
        ),
      );
      return to(
        result.ok
          ? fleetSharingNoticeUrl("authorized")
          : fleetSharingErrorUrl(result.code),
      );
    }

    if (tx.intent === "link-character") {
      const result = await fleetLifecycleTransaction(db, (dbtx) =>
        linkCharacter(dbtx, cfg, sess!.accountId, ch),
      );
      if (result.ok) return to("/account");
      return to(
        accountErrorUrl(
          result.blocker ? MERGE_BLOCKER_ERRORS[result.blocker] : "already_linked",
        ),
      );
    }

    const { accountId } = await fleetLifecycleTransaction(db, (dbtx) =>
      handleEveLogin(dbtx, cfg, ch),
    );
    const sid = await createSession(db, accountId);
    const res = to("/account");
    res.cookies.set(cfg.sessionCookieName, sid, {
      ...sessionCookieAttrs(cfg),
      maxAge: 30 * 24 * 60 * 60,
    });
    return res;
  } catch (err) {
    if (tx.intent === "grant-fleet-read") {
      // Even an error message may contain a JWT subject or SQL parameters.
      // This flow reports only a stable classification, never provider details.
      console.error("fleet read callback failed");
      return to(fleetSharingErrorUrl("authorization_failed"));
    }
    // Message only, deliberately. EveSsoError carries just a message, an OAuth
    // error code and a status (src/lib/esi/sso.ts) — never the token response
    // body — but a Postgres error from the transaction below it can carry the
    // failing query and its parameters on sibling properties, and those rows
    // hold refresh tokens. `.message` reaches neither.
    console.error("eve callback failed", err instanceof Error ? err.message : err);
    return to(
      tx.intent === "link-character"
        ? accountErrorUrl("link_failed")
        : loginErrorUrl("oauth_failed"),
    );
  }
}

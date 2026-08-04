import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { sessionCookieAttrs } from "@/lib/session-cookie";
import { endSession } from "@/services/session";

/**
 * Sign-out, this device only: delete the session the caller's own cookie
 * names, then clear that cookie. POST-only, and only ever reached through a
 * `<form method="post">` in the shell — never an `<a href>`. The session
 * cookie is `sameSite: "lax"`, which the browser still attaches to a
 * cross-site *top-level* navigation, so a GET here would be triggerable from
 * any external page that simply links to it.
 *
 * A missing or already-dead session id is not an error: endSession is a no-op
 * on either, and the caller lands on /login regardless, which is the correct
 * end state for "I have no live session" either way.
 */
export async function POST(req: NextRequest) {
  const cfg = getConfig();
  const sid = req.cookies.get(cfg.sessionCookieName)?.value;
  if (sid) {
    await endSession(getDb(), sid);
  }
  const res = NextResponse.redirect(new URL("/login", cfg.appBaseUrl), { status: 303 });
  // Attributes come from the same helper the login callback sets the cookie
  // with — see the note there on why a mismatch clears nothing while looking
  // like it worked.
  res.cookies.set(cfg.sessionCookieName, "", {
    ...sessionCookieAttrs(cfg),
    maxAge: 0,
  });
  return res;
}

import type { Config } from "@/config";

/**
 * The attributes that make up the session cookie's *identity* to a browser.
 *
 * A `Set-Cookie` whose `path`, `sameSite`, or `secure` differs from the one
 * that set it names a *different* cookie. So clearing with mismatched
 * attributes is the worst kind of failure available here: the browser keeps
 * the real session cookie, the response looks like a successful sign-out, and
 * nothing errors. The login callback that sets the cookie and the sign-out
 * route that clears it both read the attributes from here so they cannot
 * drift apart in a later edit to only one of them.
 *
 * `maxAge` is deliberately not included — it is the one attribute that
 * legitimately differs between the two callers (a TTL vs `0`), and it is not
 * part of a cookie's identity.
 */
export function sessionCookieAttrs(cfg: Config) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: cfg.appBaseUrl.startsWith("https"),
    path: "/",
  } as const;
}

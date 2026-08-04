import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getConfig } from "@/config";
import { getDb, type Db } from "@/db";
import { account } from "@/db/schema";
import { accountErrorUrl, loginErrorUrl } from "@/lib/error-redirects";
import { getSessionAccount } from "@/services/session";

export type AdminContext = { accountId: string };

/** Distinguishes "not signed in" from "signed in but not an admin" so callers
 * can react differently — a de-roled admin is still logged in and should not
 * be bounced to a login screen. `no-session` and `session-expired` are split
 * for the same class of reason: only one of them is a session that ended. */
export type AdminDenial = "no-session" | "session-expired" | "not-admin";

export type AdminResolution =
  { ok: true; ctx: AdminContext } | { ok: false; reason: AdminDenial };

/** Testable core: session id → admin resolution. */
export async function resolveAdmin(
  db: Db,
  sessionId: string | undefined,
): Promise<AdminResolution> {
  if (!sessionId) return { ok: false, reason: "no-session" };
  const sess = await getSessionAccount(db, sessionId);
  // A cookie that no longer resolves is a real expiry. No cookie at all is
  // someone who has never signed in, and telling them a session ended names an
  // event that never happened. account/page.tsx draws the same line.
  if (!sess) return { ok: false, reason: "session-expired" };
  const [acc] = await db.select().from(account).where(eq(account.id, sess.accountId));
  if (!acc?.isAdmin) return { ok: false, reason: "not-admin" };
  return { ok: true, ctx: { accountId: sess.accountId } };
}

/**
 * Cookie-reading wrapper around resolveAdmin. Deliberately NOT exported: it
 * used to return `AdminContext | null`, and every admin page guarded itself
 * with `const ctx = await getAdminContext(); if (!ctx) redirect("/login")`.
 * An `AdminResolution` is always truthy, so that exact line still compiles
 * against the new signature and simply never redirects — an unguarded admin
 * page with no type error and no failing test. Keeping this private means a
 * page resurrecting the old pattern (a stale branch, a bad merge, a copied
 * file) fails to compile instead of failing open. Pages use requireAdminPage;
 * actions use requireAdminAction.
 */
async function getAdminContext(): Promise<AdminResolution> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  return resolveAdmin(getDb(), sid);
}

/**
 * The single place a denial turns into a destination. A `switch` rather than
 * an `if` chain on purpose: each case returns a `redirect`, which `next/
 * navigation` declares as returning `never`, so this compiles clean today —
 * and the moment another `AdminDenial` member is added it fails to compile
 * with `TS2534: A function returning 'never' cannot have a reachable end
 * point` instead of silently falling through to the login redirect and telling
 * a user their session expired when it hadn't. That silent fallthrough is the
 * exact bug this union was introduced to prevent, so the union is worth little
 * without an exhaustive branch on it. Splitting `session-expired` out of
 * `no-session` is the first time that guard has actually fired.
 *
 * Annotated `: never` explicitly, and each case `return`s rather than just
 * calling: TS only treats a call as terminating control flow when the callee
 * is a plain identifier with a declared `never` return, and eslint's
 * `no-fallthrough` is not type-aware, so a bare `redirect(...)` per case
 * type-checks but fails lint.
 */
function denyAdmin(reason: AdminDenial): never {
  switch (reason) {
    case "not-admin":
      // A de-roled admin is still signed in. Sending them to a login screen
      // would be a lie; /account states what changed. Not the same
      // destination as admin/accounts/actions.ts's `redirectNotAdmin`
      // (`/admin/accounts?error=not_admin`) — they converge here only via a
      // second hop: requireAdminPage re-guards `/admin/accounts` itself, so a
      // non-admin who lands there bounces onward to this same `/account`
      // redirect.
      return redirect(accountErrorUrl("not_admin"));
    case "session-expired":
      return redirect(loginErrorUrl("session_expired"));
    case "no-session":
      // Never signed in — most often someone who guessed /admin, or a crawler.
      // "Your session ended" would name an event that never happened, so this
      // one gets the plain login page.
      return redirect("/login");
  }
}

/**
 * For admin PAGES: redirects and never returns on failure, so pages just call
 * it.
 */
export async function requireAdminPage(): Promise<AdminContext> {
  const res = await getAdminContext();
  if (!res.ok) denyAdmin(res.reason);
  return res.ctx;
}

/**
 * For admin SERVER ACTIONS: layouts do not protect actions and do not re-run
 * on soft navigation, so every action gates itself with this.
 *
 * This used to `throw new Error("not authorized")`, which landed on the route
 * error boundary — copy that reads "Something broke… a fault on this end."
 * For the case that actually happens, that was simply wrong: another admin
 * clearing your admin bit between the row rendering and your click is a race
 * the app expects, not a server fault. admin/accounts/actions.ts:24 already
 * redirected rather than threw for exactly this reason; this now matches it.
 *
 * NOTE: with that change this function's body is identical to
 * requireAdminPage's. The two names are kept because their call sites read
 * differently and collapsing them would touch twelve unrelated files; if a
 * future change gives them no divergent behavior either, merge them.
 */
export async function requireAdminAction(): Promise<AdminContext> {
  const res = await getAdminContext();
  if (!res.ok) denyAdmin(res.reason);
  return res.ctx;
}

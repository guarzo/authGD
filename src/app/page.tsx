import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { getSessionAccount } from "@/services/session";

// Reads the session cookie and hits the DB; getConfig() also requires env vars
// that aren't present at build time, so this route must never be prerendered.
export const dynamic = "force-dynamic";

// The root path is a signpost, not a page: signed-in members land on their
// account, everyone else on the login screen. Validating the session here
// (rather than only checking for the cookie) keeps a stale cookie from
// bouncing the visitor through /account before it lands on /login.
export default async function Home() {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  const sess = sid ? await getSessionAccount(getDb(), sid) : null;
  redirect(sess ? "/account" : "/login");
}

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb, type Db } from "@/db";
import { account } from "@/db/schema";
import { getSessionAccount } from "@/services/session";

export type AdminContext = { accountId: string };

/** Testable core: session id → admin account id, or null. */
export async function resolveAdmin(
  db: Db,
  sessionId: string | undefined,
): Promise<AdminContext | null> {
  if (!sessionId) return null;
  const sess = await getSessionAccount(db, sessionId);
  if (!sess) return null;
  const [acc] = await db.select().from(account).where(eq(account.id, sess.accountId));
  if (!acc?.isAdmin) return null;
  return { accountId: sess.accountId };
}

/** For admin PAGES: caller redirects on null. */
export async function getAdminContext(): Promise<AdminContext | null> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  return resolveAdmin(getDb(), sid);
}

/**
 * For admin SERVER ACTIONS: throws on failure. Layouts do not protect actions
 * and do not re-run on soft navigation — every action gates itself with this.
 */
export async function requireAdminAction(): Promise<AdminContext> {
  const ctx = await getAdminContext();
  if (!ctx) throw new Error("not authorized");
  return ctx;
}

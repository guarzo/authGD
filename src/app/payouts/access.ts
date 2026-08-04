import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { account } from "@/db/schema";
import { canReadPayouts, requirePayoutOperator } from "@/services/payouts";
import { getSessionAccount } from "@/services/session";

export type PayoutAccess = {
  accountId: string;
  /** tier flygd AND status active — the requirePayoutOperator gate, mirrored
   *  here only to decide what to render; every mutation re-checks itself. */
  isOperator: boolean;
  isAdmin: boolean;
};

/**
 * Session → payout read access, or null when there is no session or the
 * account is not tier `flygd` (canReadPayouts is tier-only, any status —
 * a cryo flygd member still reads everything, per the design's "Access and
 * visibility" section). Pages redirect on null; they do not render a partial
 * page and hide pieces of it.
 */
export async function requirePayoutReader(): Promise<PayoutAccess | null> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  if (!sid) return null;
  const db = getDb();
  const sess = await getSessionAccount(db, sid);
  if (!sess) return null;
  if (!(await canReadPayouts(db, sess.accountId))) return null;

  const [acc] = await db.select().from(account).where(eq(account.id, sess.accountId));
  const isOperator = await requirePayoutOperator(db, sess.accountId)
    .then(() => true)
    .catch(() => false);
  return { accountId: sess.accountId, isOperator, isAdmin: acc?.isAdmin ?? false };
}

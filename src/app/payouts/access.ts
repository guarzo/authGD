import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { account } from "@/db/schema";
import {
  canReadPayouts,
  PayoutForbiddenError,
  requirePayoutOperator,
} from "@/services/payouts";
import { getSessionAccount } from "@/services/session";
import { getMainCharacterWithScope } from "@/services/tokens";
import { OPEN_WINDOW_SCOPE } from "@/lib/esi/client";

export type PayoutAccess = {
  accountId: string;
  /** tier flygd AND status active — the requirePayoutOperator gate, mirrored
   *  here only to decide what to render; every mutation re-checks itself. */
  isOperator: boolean;
  isAdmin: boolean;
  /** This operator's own main character has granted `OPEN_WINDOW_SCOPE`. Gated
   *  on the character's PERSISTED grant, never on `cfg.eveSso.scopes`: config
   *  says what authGD asks for, and an operator who authorized before the scope
   *  was added has a perfectly valid session and no open-window grant.
   *
   *  The control is hidden, not disabled, when false: a disabled button
   *  advertises a capability this operator does not have and gives them nothing
   *  to do about it. Copy amount and Mark paid stay scope-free, so an operator
   *  without the grant loses nothing phase 1 gave them. */
  canOpenInfo: boolean;
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
  let isOperator: boolean;
  try {
    await requirePayoutOperator(db, sess.accountId);
    isOperator = true;
  } catch (err) {
    // Only "not an active flygd account" means "reader, not operator" — any
    // other failure (DB error, etc.) must surface, not be silently read as
    // "just hide the operator controls".
    if (!(err instanceof PayoutForbiddenError)) throw err;
    isOperator = false;
  }

  // Task 10's helper IS the gate — do not hand-roll a second scopes read here.
  // It already resolves the account's main character and answers only on the
  // PERSISTED grant, so one source decides both what renders and what runs.
  // The token making the call belongs to the OPERATOR, not the recipient, which
  // is why the operator's own account id is the argument.
  //
  // It returns the row rather than a boolean because `openInfoAction` needs the
  // row (`getFreshAccessToken` wants id / refreshTokenEnc / tokenStatus) and
  // re-checks at call time regardless — a render-time boolean is a rendering
  // decision, never an authorization one. Here only its presence matters.
  const canOpenInfo =
    isOperator &&
    (await getMainCharacterWithScope(db, sess.accountId, OPEN_WINDOW_SCOPE)) !== null;

  return {
    accountId: sess.accountId,
    isOperator,
    isAdmin: acc?.isAdmin ?? false,
    canOpenInfo,
  };
}

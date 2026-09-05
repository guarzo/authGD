"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import {
  NonMemberApprovalError,
  PairingAlreadyApprovedError,
  PairingAlreadyConsumedError,
  PairingExpiredError,
  PairingNotFoundError,
  approvePairing,
} from "@/services/fleet-pairing";
import { getSessionAccount } from "@/services/session";

/**
 * Approves one pending pairing request. `page.tsx` already re-checked
 * Member tier before rendering the control this action is bound to, but
 * `approvePairing` re-checks it again itself (this file's own copy of the
 * "every mutation re-checks itself" rule `payouts/access.ts` states) — a
 * race where the account loses Member tier between render and this press is
 * caught here, not assumed away by the page having looked fine a moment ago.
 *
 * Every refusal `approvePairing` can throw for THIS pairing request
 * (not-found/expired/already-approved/already-consumed/non-Member) is
 * swallowed rather than escalated to `error.tsx`: none of them is something
 * this press typed, and the page's own next render re-reads the row directly
 * from the database, so it already shows whichever of those is now true.
 * `revalidatePath` is what makes that next render happen.
 */
export async function approvePairingAction(pairingId: string): Promise<void> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  if (!sid) redirect("/login");
  const sess = await getSessionAccount(getDb(), sid);
  if (!sess) redirect("/login");

  try {
    await approvePairing(getDb(), pairingId, sess.accountId, new Date());
  } catch (err) {
    if (
      err instanceof PairingNotFoundError ||
      err instanceof PairingExpiredError ||
      err instanceof PairingAlreadyApprovedError ||
      err instanceof PairingAlreadyConsumedError ||
      err instanceof NonMemberApprovalError
    ) {
      revalidatePath(`/fleet/pair/${pairingId}`);
      return;
    }
    throw err;
  }
  revalidatePath(`/fleet/pair/${pairingId}`);
}

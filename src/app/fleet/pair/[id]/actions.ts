"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { z } from "zod";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { FleetSharingDisabledError } from "@/services/fleet-sharing-mode";
import {
  DeviceBoundToAnotherAccountError,
  NonMemberApprovalError,
  PairingAlreadyApprovedError,
  PairingAlreadyConsumedError,
  PairingExpiredError,
  PairingNotFoundError,
  approvePairing,
} from "@/services/fleet-pairing";
import { getSessionAccount } from "@/services/session";

/**
 * `pairingId` is caller input on the wire, not trusted state — a bound
 * server-action argument round-trips through the client the same way a
 * `FormData` field does, so a forged submission can supply anything.
 * `fleet_pairing_request.id` is a Postgres `uuid` column, so an unparsed
 * malformed value would raise a raw `22P02` out of `approvePairing`'s own
 * query instead of reaching any of this action's own refusal handling.
 */
const pairingIdSchema = z.uuid();

/**
 * Approves one pending pairing request. `page.tsx` already re-checked
 * Member tier before rendering the control this action is bound to, but
 * `approvePairing` re-checks it again itself (this file's own copy of the
 * "every mutation re-checks itself" rule `payouts/access.ts` states) — a
 * race where the account loses Member tier between render and this press is
 * caught here, not assumed away by the page having looked fine a moment ago.
 *
 * Every refusal `approvePairing` can throw for THIS pairing request
 * (not-found/expired/already-approved/already-consumed/non-Member/bound to
 * another account) is swallowed rather than escalated to `error.tsx`: none
 * of them is something this press typed, and the page's own next render
 * re-derives its state directly from the database (including its own copy
 * of the bound-elsewhere check, `page.tsx`'s `derivePairingState`), so it
 * already shows whichever of those is now true — a terminal,
 * non-approvable state for `DeviceBoundToAnotherAccountError`, never the
 * same Approve control handed back for another doomed retry.
 * `revalidatePath` is what makes that next render happen.
 *
 * Validates `pairingId` itself with a Zod UUID check BEFORE calling
 * `approvePairing` at all, and returns SILENTLY on failure — unlike
 * `revokeFleetDeviceAction`'s equivalent check (`fleet-devices/actions.ts`),
 * which has a `?error=` notice channel to redirect through, this action has
 * none: every reachable refusal already resolves by re-rendering
 * `/fleet/pair/[id]`'s current state, and a `pairingId` that never parsed as
 * a UUID names no real page to revalidate either — so neither the service
 * nor `revalidatePath` runs for it.
 */
export async function approvePairingAction(pairingId: string): Promise<void> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  if (!sid) redirect("/login");
  const sess = await getSessionAccount(getDb(), sid);
  if (!sess) redirect("/login");

  const parsedId = pairingIdSchema.safeParse(pairingId);
  if (!parsedId.success) return;

  try {
    await approvePairing(getDb(), parsedId.data, sess.accountId);
  } catch (err) {
    if (
      err instanceof FleetSharingDisabledError ||
      err instanceof PairingNotFoundError ||
      err instanceof PairingExpiredError ||
      err instanceof PairingAlreadyApprovedError ||
      err instanceof PairingAlreadyConsumedError ||
      err instanceof NonMemberApprovalError ||
      err instanceof DeviceBoundToAnotherAccountError
    ) {
      revalidatePath(`/fleet/pair/${parsedId.data}`);
      return;
    }
    throw err;
  }
  revalidatePath(`/fleet/pair/${parsedId.data}`);
}

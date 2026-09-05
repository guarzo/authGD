"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { fleetDevice } from "@/db/schema";
import { fleetDevicesErrorUrl, loginErrorUrl } from "@/lib/error-redirects";
import { revokeFleetDevice } from "@/services/fleet-pairing";
import { getSessionAccount } from "@/services/session";

/**
 * Same session gate `account/actions.ts`'s own `requireAccount` uses,
 * duplicated rather than imported: that one is a private helper of its own
 * module, and importing across `app/` route directories for a five-line
 * cookie/session read would be a stranger dependency than repeating it —
 * see `error-redirects.ts`'s own "WHY `src/lib/` AND NOT `src/app/`" note
 * for the same reasoning applied to a sibling case.
 */
async function requireAccount(): Promise<string> {
  const cfg = getConfig();
  const sid = (await cookies()).get(cfg.sessionCookieName)?.value;
  const sess = sid ? await getSessionAccount(getDb(), sid) : null;
  if (!sess) redirect(loginErrorUrl("session_expired"));
  return sess.accountId;
}

/**
 * Member self-serve: revoke one of the caller's OWN paired fleet-sharing
 * devices. `revokeFleetDevice` (services/fleet-pairing.ts) carries no
 * ownership check of its own by design — it trusts its caller — so this is
 * the one and only place that check happens for this action. It is a plain,
 * non-locking pre-check rather than an `expectedAccountId` parameter
 * threaded through the service (the way `unlinkCharacter` takes one) because
 * `fleetDevice.accountId` is immutable for the life of a row (see
 * `revokeFleetDevice`'s own doc comment): there is no race between this
 * check and the revoke below for this column to lose, unlike
 * `unlinkAction`'s character-transfer race, which is exactly why that one
 * needs both a pre-check AND an authoritative in-transaction recheck and
 * this needs only the pre-check.
 *
 * A device that fails the pre-check (already revoked in another tab, or
 * never this account's device at all — unreachable from this page's own
 * rendered list, which only ever offers the caller's own non-revoked
 * devices, but not from a forged form submission) is a silent, no-confirmation
 * redirect back to a fresh render, the same "don't confirm a no-op, don't
 * throw for a stale race" posture `unlinkAction` takes for its own
 * `stale_character` case.
 */
export async function revokeFleetDeviceAction(deviceId: string): Promise<void> {
  const accountId = await requireAccount();
  const db = getDb();
  const owned = await db
    .select({ id: fleetDevice.id })
    .from(fleetDevice)
    .where(
      and(
        eq(fleetDevice.id, deviceId),
        eq(fleetDevice.accountId, accountId),
        isNull(fleetDevice.revokedAt),
      ),
    );
  if (owned.length === 0) redirect(fleetDevicesErrorUrl("stale_device"));

  await db.transaction((dbtx) =>
    revokeFleetDevice(dbtx, deviceId, accountId, new Date()),
  );
  revalidatePath("/account/fleet-devices");
  redirect(`/account/fleet-devices?done=revoke&at=${Date.now()}`);
}

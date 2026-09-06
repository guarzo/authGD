"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { z } from "zod";
import { getConfig } from "@/config";
import { getDb } from "@/db";
import { fleetDevice } from "@/db/schema";
import { fleetDevicesErrorUrl, loginErrorUrl } from "@/lib/error-redirects";
import { RelayContentionError, revokeFleetDevice } from "@/services/fleet-pairing";
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
 * Every device id reaching this action is caller input on the wire (a bound
 * server-action argument round-trips through the client, exactly like a
 * `FormData` field), not trusted state — a forged form submission can send
 * anything. `fleetDevice.id` is a Postgres `uuid` column, so an unparsed
 * malformed value would raise a raw, unhandled `22P02` out of the ownership
 * query below instead of ever reaching this function's own `stale_device`
 * redirect. Rejected the same way an unknown-but-well-shaped id already is —
 * this action is a non-oracle: it must not tell a forged request that its id
 * merely didn't parse, as opposed to naming a device that once existed.
 */
const deviceIdSchema = z.uuid();

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
 *
 * Calls `revokeFleetDevice(db, ...)` directly rather than wrapping it in a
 * SECOND, outer `db.transaction`: `revokeFleetDevice` already opens and owns
 * its own transaction, and Drizzle would nest this one as a savepoint —
 * which cannot recover the way an outer transaction can. Postgres aborts the
 * WHOLE transaction, savepoints included, for a serialization failure or
 * deadlock (`40001`/`40P01`), the exact condition `revokeFleetDevice` itself
 * converts to `RelayContentionError`; an outer transaction around that call
 * would itself already be dead by the time this caught it, with nothing left
 * to commit. `RelayContentionError` is caught here and redirected as a
 * retryable notice — the caller lost a race with concurrent relay activity
 * on the SAME device (a publish, another revoke), not a permanent refusal.
 * `DeviceNotFoundError` is NOT caught: `revokeFleetDevice` can only throw it
 * when its own row lock fails to find `deviceId`, and the ownership
 * pre-check above already proved this exact row exists moments earlier —
 * `fleetDevice` rows are never hard-deleted anywhere in this codebase, so
 * that finding can never un-happen between the two. Catching it here would
 * be dead code for a condition this call site cannot produce.
 */
export async function revokeFleetDeviceAction(deviceId: string): Promise<void> {
  const accountId = await requireAccount();
  const parsedId = deviceIdSchema.safeParse(deviceId);
  if (!parsedId.success) redirect(fleetDevicesErrorUrl("stale_device"));

  const db = getDb();
  const owned = await db
    .select({ id: fleetDevice.id })
    .from(fleetDevice)
    .where(
      and(
        eq(fleetDevice.id, parsedId.data),
        eq(fleetDevice.accountId, accountId),
        isNull(fleetDevice.revokedAt),
      ),
    );
  if (owned.length === 0) redirect(fleetDevicesErrorUrl("stale_device"));

  try {
    await revokeFleetDevice(db, parsedId.data, accountId, new Date());
  } catch (err) {
    if (err instanceof RelayContentionError) {
      redirect(fleetDevicesErrorUrl("relay_contention"));
    }
    throw err;
  }
  revalidatePath("/account/fleet-devices");
  redirect(`/account/fleet-devices?done=revoke&at=${Date.now()}`);
}

import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import type { Pool } from "pg";
import { fleetDevice } from "@/db/schema";
import { canonicalDevicePublicKeyB64 } from "@/lib/fleet-signature";
import {
  approvePairing,
  beginPairing,
  completePairing,
  pairingChallengePreimage,
} from "@/services/fleet-pairing";

/** Observe the actual PostgreSQL wait-for edge, not an arbitrary sleep. */
export async function waitUntilBlockedBy(
  pool: Pool,
  holderPid: number,
): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity waiter where waiter.wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(waiter.pid))`,
      [holderPid],
    );
    if (rows[0].n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

export function fleetKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKeySpki: new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
  };
}

/** Real browser approval + device key proof, also usable to deliberately upgrade
 * an existing key without changing its account binding. Never seeds grants. */
export async function pairDevice(
  db: Dbx,
  accountId: string,
  now: Date,
  requestedCapabilities: string[] = [],
  keys = fleetKeyPair(),
) {
  const { pairingId } = await beginPairing(db, {
    publicKeySpki: keys.publicKeySpki,
    now,
    requestedCapabilities,
  });
  await approvePairing(db, pairingId, accountId, now);
  const completionSignature = ed25519Sign(
    null,
    pairingChallengePreimage(pairingId),
    keys.privateKey,
  ).toString("base64url");
  const { sessionId } = await completePairing(db, {
    pairingId,
    completionSignature,
    now,
  });
  const [device] = await db
    .select()
    .from(fleetDevice)
    .where(
      eq(fleetDevice.publicKeySpkiB64, canonicalDevicePublicKeyB64(keys.publicKeySpki)),
    );
  return {
    sessionId,
    device,
    privateKey: keys.privateKey,
    publicKeySpki: keys.publicKeySpki,
  };
}

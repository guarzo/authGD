import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import { fleetDevice, fleetDeviceSession } from "@/db/schema";
import {
  SHARED_CAPABILITY,
  type FleetCode,
  type FleetReply,
  type Participation,
  type SignedFleetCall,
} from "@/core/fleet-sharing";
import { logAudit } from "@/services/audit";
import {
  lockFleetAccounts,
  withdrawFleetDeviceProjection,
} from "@/services/fleet-lifecycle";
import { lockFleetSharingMode } from "@/services/fleet-sharing-mode";
import {
  commitSessionCadence,
  gateSignedSession,
  isRetryableRelayError,
  RelayRefusal,
  sampleFleetSessionAdmission,
} from "@/services/fleet-relay";

/** No fleet/source selector. Explicit model acknowledgment and current Member
 * standing precede device-generation CAS. Off is NOT source Stop or recovery. */
export async function setFleetParticipation(
  dbx: Dbx,
  call: SignedFleetCall & { enabled: boolean; expectedGeneration: number },
): Promise<FleetReply<Participation>> {
  if (
    typeof call.enabled !== "boolean" ||
    !Number.isSafeInteger(call.expectedGeneration) ||
    call.expectedGeneration < 0 ||
    call.expectedGeneration >= 2_147_483_647
  )
    return { ok: false, code: "invalid_intent" };
  try {
    const value = await dbx.transaction(async (tx) => {
      const mode = await lockFleetSharingMode(tx);
      if (!mode.enabled || mode.keyIdentityPhase !== "ready")
        throw new RelayRefusal("feature_disabled");
      const key = createHash("sha256").update(call.sessionId).digest("base64url");
      const [probe] = await tx
        .select({ accountId: fleetDevice.accountId, deviceId: fleetDevice.id })
        .from(fleetDeviceSession)
        .innerJoin(fleetDevice, eq(fleetDevice.id, fleetDeviceSession.deviceId))
        .where(eq(fleetDeviceSession.id, key));
      if (!probe) throw new RelayRefusal("unauthorized");
      const owner = (await lockFleetAccounts(tx, [probe.accountId])).get(probe.accountId);
      const { device, session } = await gateSignedSession(tx, {
        ...call,
        cadence: "read",
        invalidSessionCode: "unauthorized",
      });
      if (device.id !== probe.deviceId || device.accountId !== probe.accountId)
        throw new RelayRefusal("unauthorized");
      if (owner?.tier !== "member") throw new RelayRefusal("forbidden");
      if (
        ![
          device.approvedCapabilities,
          session.approvedCapabilities,
          session.acknowledgedCapabilities,
        ].every((caps) => caps.includes(SHARED_CAPABILITY))
      )
        throw new RelayRefusal("capability_required");
      if (device.participationGeneration !== call.expectedGeneration)
        throw new RelayRefusal("conflict");
      if (!call.enabled) await withdrawFleetDeviceProjection(tx, device.id);
      const now = sampleFleetSessionAdmission(session, {
        ...call,
        cadence: "read",
        invalidSessionCode: "unauthorized",
      });
      const participation = {
        enabled: call.enabled,
        generation: device.participationGeneration + 1,
      };
      await tx
        .update(fleetDevice)
        .set({
          participationEnabled: participation.enabled,
          participationGeneration: participation.generation,
        })
        .where(eq(fleetDevice.id, device.id));
      await logAudit(tx, {
        actor: device.accountId,
        action: "fleet_device.participation_changed",
        target: device.id,
        details: participation,
      });
      await commitSessionCadence(tx, session.id, {
        revision: call.revision,
        now,
        cadence: "read",
      });
      return participation;
    });
    return { ok: true, value };
  } catch (err) {
    if (err instanceof RelayRefusal) return { ok: false, code: err.code as FleetCode };
    if (isRetryableRelayError(err)) return { ok: false, code: "service_unavailable" };
    throw err;
  }
}

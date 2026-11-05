import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import {
  API_VERSION,
  ParticipationResultSchema,
  FLEET_V2_BYTE_LIMITS,
} from "@/core/fleet-api-v2";
import { serializeFleetV2Json } from "@/lib/fleet-api-v2";
import { fleetDatabaseNow } from "@/services/fleet-key-identity";
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
): Promise<
  | (Extract<FleetReply<Participation>, { ok: true }> & { json: string })
  | Extract<FleetReply<Participation>, { ok: false }>
> {
  if (
    typeof call.enabled !== "boolean" ||
    !Number.isSafeInteger(call.expectedGeneration) ||
    call.expectedGeneration < 0 ||
    call.expectedGeneration >= 2_147_483_647
  )
    return { ok: false, code: "invalid_intent" };
  try {
    const result = await dbx.transaction(async (tx) => {
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
        databaseClock: true,
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
      const participation = {
        enabled: call.enabled,
        generation: device.participationGeneration + 1,
      };
      const output = serializeFleetV2Json(
        { protocol: API_VERSION, participation },
        ParticipationResultSchema,
        FLEET_V2_BYTE_LIMITS.participationPut.successBytes,
      );
      if (!output.ok) throw new RelayRefusal(output.code);
      if (!call.enabled) await withdrawFleetDeviceProjection(tx, device.id);
      const now = sampleFleetSessionAdmission(session, {
        ...call,
        now: await fleetDatabaseNow(tx, call.now),
        cadence: "read",
        invalidSessionCode: "unauthorized",
      });
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
      return { value: participation, json: output.json };
    });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof RelayRefusal) return { ok: false, code: err.code as FleetCode };
    if (isRetryableRelayError(err)) return { ok: false, code: "service_unavailable" };
    throw err;
  }
}

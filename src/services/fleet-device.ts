import { eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import { account, fleetDeviceSession } from "@/db/schema";
import {
  validFleetCapabilities,
  type DeviceView,
  type FleetCode,
  type FleetReply,
  type SignedFleetCall,
} from "@/core/fleet-sharing";
import { logAudit } from "@/services/audit";
import {
  commitSessionCadence,
  gateSignedSession,
  isRetryableRelayError,
  RelayRefusal,
} from "@/services/fleet-relay";

export function readFleetDeviceState(
  dbx: Dbx,
  call: SignedFleetCall,
): Promise<FleetReply<DeviceView>> {
  return deviceOperation(dbx, call);
}

export function acknowledgeFleetCapabilities(
  dbx: Dbx,
  call: SignedFleetCall & { capabilities: string[] },
): Promise<FleetReply<DeviceView>> {
  if (!validFleetCapabilities(call.capabilities))
    return Promise.resolve({ ok: false, code: "capability_required" });
  return deviceOperation(dbx, call, call.capabilities);
}

/** Setup remains usable without participation or roster evidence. All device
 * controls consume the existing shared read bucket and single revision. */
async function deviceOperation(
  dbx: Dbx,
  call: SignedFleetCall,
  capabilities?: string[],
): Promise<FleetReply<DeviceView>> {
  try {
    const value = await dbx.transaction(async (tx) => {
      const { device, session, now, featureEnabled } = await gateSignedSession(tx, {
        ...call,
        cadence: "read",
        invalidSessionCode: "unauthorized",
      });
      const [owner] = await tx
        .select({ tier: account.tier })
        .from(account)
        .where(eq(account.id, device.accountId));
      if (owner?.tier !== "member") throw new RelayRefusal("forbidden");
      if (capabilities !== undefined) {
        if (!featureEnabled) throw new RelayRefusal("feature_disabled");
        if (
          capabilities.some(
            (c) =>
              !device.approvedCapabilities.includes(c) ||
              !session.approvedCapabilities.includes(c),
          )
        )
          throw new RelayRefusal("capability_required");
        await tx
          .update(fleetDeviceSession)
          .set({ acknowledgedCapabilities: capabilities })
          .where(eq(fleetDeviceSession.id, session.id));
        if (
          JSON.stringify(session.acknowledgedCapabilities) !==
          JSON.stringify(capabilities)
        ) {
          await logAudit(tx, {
            actor: device.accountId,
            action: "fleet_device.capabilities_acknowledged",
            target: device.id,
            details: { capabilities },
          });
        }
      }
      await commitSessionCadence(tx, session.id, {
        revision: call.revision,
        now,
        cadence: "read",
      });
      return {
        deviceId: device.id,
        sessionExpiresAt: session.expiresAt,
        featureEnabled,
        approvedCapabilities: device.approvedCapabilities,
        sessionApprovedCapabilities: session.approvedCapabilities,
        acknowledgedCapabilities: capabilities ?? session.acknowledgedCapabilities,
        participation: {
          enabled: device.participationEnabled,
          generation: device.participationGeneration,
        },
      };
    });
    return { ok: true, value };
  } catch (err) {
    // gateSignedSession emits only these closed codes on this path.
    if (err instanceof RelayRefusal) return { ok: false, code: err.code as FleetCode };
    if (isRetryableRelayError(err)) return { ok: false, code: "service_unavailable" };
    throw err;
  }
}

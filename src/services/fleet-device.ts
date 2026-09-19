import { eq } from "drizzle-orm";
import type { Dbx } from "@/db";
import { account, fleetDeviceSession } from "@/db/schema";
import {
  validFleetCapabilities,
  type DeviceView,
  type FleetCode,
  type SignedFleetCall,
} from "@/core/fleet-sharing";
import { logAudit } from "@/services/audit";
import {
  API_VERSION,
  ControlDeviceSchema,
  FLEET_V2_BYTE_LIMITS,
} from "@/core/fleet-api-v2";
import { serializeFleetV2Json } from "@/lib/fleet-api-v2";

import {
  commitSessionCadence,
  gateSignedSession,
  isRetryableRelayError,
  RelayRefusal,
} from "@/services/fleet-relay";

type DeviceReply =
  { ok: true; value: DeviceView; json: string } | { ok: false; code: FleetCode };

export function readFleetDeviceState(
  dbx: Dbx,
  call: SignedFleetCall,
): Promise<DeviceReply> {
  return deviceOperation(dbx, call);
}

export function acknowledgeFleetCapabilities(
  dbx: Dbx,
  call: SignedFleetCall & { capabilities: string[] },
): Promise<DeviceReply> {
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
): Promise<DeviceReply> {
  try {
    const result = await dbx.transaction(async (tx) => {
      const { device, session, now, featureEnabled } = await gateSignedSession(tx, {
        sessionId: call.sessionId,
        revision: call.revision,
        get now() {
          return call.now;
        },
        cadence: "read",
        invalidSessionCode: "unauthorized",
        databaseClock: true,
      });
      const [owner] = await tx
        .select({ tier: account.tier })
        .from(account)
        .where(eq(account.id, device.accountId));
      if (owner?.tier !== "member") throw new RelayRefusal("forbidden");
      const value: DeviceView = {
        serverTimeMs: now.getTime(),
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
      // Validate every independent capability array and the full wire envelope
      // before acknowledging or consuming cadence. Never mask malformed grants.
      const output = serializeFleetV2Json(
        {
          protocol: API_VERSION,
          server_time_ms: value.serverTimeMs,
          device_id: value.deviceId,
          session_expires_at: Number.isFinite(value.sessionExpiresAt.getTime())
            ? value.sessionExpiresAt.toISOString()
            : null,
          feature_enabled: value.featureEnabled,
          approved_capabilities: value.approvedCapabilities,
          session_approved_capabilities: value.sessionApprovedCapabilities,
          acknowledged_capabilities: value.acknowledgedCapabilities,
          participation: value.participation,
        },
        ControlDeviceSchema,
        FLEET_V2_BYTE_LIMITS.deviceGet.successBytes,
      );
      if (!output.ok) throw new RelayRefusal(output.code);
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
      return { value, json: output.json };
    });
    return { ok: true, ...result };
  } catch (err) {
    // gateSignedSession emits only these closed codes on this path.
    if (err instanceof RelayRefusal) return { ok: false, code: err.code as FleetCode };
    if (isRetryableRelayError(err)) return { ok: false, code: "service_unavailable" };
    throw err;
  }
}

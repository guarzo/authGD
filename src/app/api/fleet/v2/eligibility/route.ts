import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { SessionRenewSchema, FLEET_V2_BYTE_LIMITS } from "@/core/fleet-api-v2";
import { authenticateFleetRequest } from "@/lib/fleet-route-auth";
import {
  fleetV2Error,
  fleetV2RequestBinding,
  fleetV2Success,
  readFleetV2SignedEnvelope,
} from "@/lib/fleet-api-v2";
import { readDeviceEligibility } from "@/services/fleet-eligibility";
export const dynamic = "force-dynamic";
const PATH = "/api/fleet/v2/eligibility";
export async function GET(req: NextRequest) {
  const envelope = await readFleetV2SignedEnvelope(
    req,
    "GET",
    SessionRenewSchema,
    FLEET_V2_BYTE_LIMITS.eligibilityGet.requestBytes,
    PATH,
  );
  if (!envelope.ok) return fleetV2Error(envelope.code);
  try {
    const db = getDb();
    const { headers, bytes } = envelope;
    const auth = await authenticateFleetRequest(db, headers, bytes, {
      method: "GET",
      path: PATH,
      now: new Date(),
    });
    if (!auth.ok) return fleetV2Error(auth.code);
    const result = await readDeviceEligibility(db, {
      sessionId: auth.auth.sessionId,
      revision: headers.revision,
    });
    if (!result.ok) return fleetV2Error(result.code);
    return fleetV2Success(
      result.json,
      fleetV2RequestBinding({ method: "GET", path: PATH, ...headers }),
    );
  } catch {
    return fleetV2Error("service_unavailable");
  }
}
export function POST() {
  return fleetV2Error("method_not_allowed", { allow: "GET" });
}
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = POST;
export function HEAD() {
  return fleetV2Error("method_not_allowed", { head: true, allow: "GET" });
}

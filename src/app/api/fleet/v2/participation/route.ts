import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { ParticipationPutSchema, FLEET_V2_BYTE_LIMITS } from "@/core/fleet-api-v2";
import { authenticateFleetRequest } from "@/lib/fleet-route-auth";
import {
  fleetV2Error,
  fleetV2RequestBinding,
  fleetV2Success,
  readFleetV2SignedEnvelope,
} from "@/lib/fleet-api-v2";
import { setFleetParticipation } from "@/services/fleet-participation";
export const dynamic = "force-dynamic";
const PATH = "/api/fleet/v2/participation";
export async function PUT(req: NextRequest) {
  const envelope = await readFleetV2SignedEnvelope(
    req,
    "PUT",
    ParticipationPutSchema,
    FLEET_V2_BYTE_LIMITS.participationPut.requestBytes,
    PATH,
  );
  if (!envelope.ok) return fleetV2Error(envelope.code);
  try {
    const db = getDb();
    const { headers, bytes, body } = envelope;
    const auth = await authenticateFleetRequest(db, headers, bytes, {
      method: "PUT",
      path: PATH,
      now: new Date(),
    });
    if (!auth.ok) return fleetV2Error(auth.code);
    const result = await setFleetParticipation(db, {
      sessionId: auth.auth.sessionId,
      revision: headers.revision,
      enabled: body!.enabled,
      expectedGeneration: body!.expected_generation,
    });
    if (!result.ok) return fleetV2Error(result.code);
    return fleetV2Success(
      result.json,
      fleetV2RequestBinding({ method: "PUT", path: PATH, ...headers }),
    );
  } catch {
    return fleetV2Error("service_unavailable");
  }
}
export function POST() {
  return fleetV2Error("method_not_allowed", { allow: "PUT" });
}
export const GET = POST;
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = POST;
export function HEAD() {
  return fleetV2Error("method_not_allowed", { head: true, allow: "PUT" });
}

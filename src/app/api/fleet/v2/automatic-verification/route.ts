import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { AutomaticCommandSchema } from "@/core/fleet-automatic";
import { FLEET_V2_BYTE_LIMITS } from "@/core/fleet-api-v2";
import { authenticateFleetRequest } from "@/lib/fleet-route-auth";
import {
  fleetV2Error,
  fleetV2RequestBinding,
  fleetV2Success,
  readFleetV2SignedEnvelope,
} from "@/lib/fleet-api-v2";
import { controlFleetAutomatic, readFleetAutomatic } from "@/services/fleet-automatic";

export const dynamic = "force-dynamic";
const PATH = "/api/fleet/v2/automatic-verification";
async function handle(req: NextRequest, method: "GET" | "PUT") {
  try {
    const envelope = await readFleetV2SignedEnvelope(
      req,
      method,
      AutomaticCommandSchema,
      FLEET_V2_BYTE_LIMITS.automaticPut.requestBytes,
      PATH,
    );
    if (!envelope.ok) return fleetV2Error(envelope.code);
    const { headers, bytes, body } = envelope;
    const db = getDb();
    const auth = await authenticateFleetRequest(db, headers, bytes, {
      method,
      path: PATH,
      now: new Date(),
    });
    if (!auth.ok) return fleetV2Error(auth.code);
    const call = { sessionId: auth.auth.sessionId, revision: headers.revision };
    const result =
      method === "GET"
        ? await readFleetAutomatic(db, call)
        : await controlFleetAutomatic(db, call, body!);
    if (!result.ok) return fleetV2Error(result.code);
    return fleetV2Success(
      result.json,
      fleetV2RequestBinding({ method, path: PATH, ...headers }),
    );
  } catch {
    return fleetV2Error("service_unavailable");
  }
}
export function GET(req: NextRequest) {
  return handle(req, "GET");
}
export function PUT(req: NextRequest) {
  return handle(req, "PUT");
}
export function POST() {
  return fleetV2Error("method_not_allowed", { allow: "GET, PUT" });
}
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = POST;
export function HEAD() {
  return fleetV2Error("method_not_allowed", { head: true, allow: "GET, PUT" });
}

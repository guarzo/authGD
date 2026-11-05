import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { AutomaticCommandSchema } from "@/core/fleet-automatic";
import { UuidV4Schema } from "@/core/fleet-api-v2";
import { safeParseFleetV2Dto } from "@/core/fleet-v2-validation";
import { authenticateFleetRequest } from "@/lib/fleet-route-auth";
import {
  fleetV2Error,
  fleetV2RequestBinding,
  fleetV2Success,
  readFleetV2SignedEnvelope,
} from "@/lib/fleet-api-v2";
import { readFleetAutomaticReceipt } from "@/services/fleet-automatic";

export const dynamic = "force-dynamic";
const PREFIX = "/api/fleet/v2/automatic-verification/receipts/";
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ request_id: string }> },
) {
  try {
    const selector = safeParseFleetV2Dto(UuidV4Schema, (await context.params).request_id);
    if (!selector.success) return fleetV2Error("bad_request");
    // The exact literal path, not a decoded alias or unsigned query selector,
    // binds the receipt. Shared framing refuses suffixes/encoding before DB work.
    const path = PREFIX + selector.data;
    const envelope = await readFleetV2SignedEnvelope(
      req,
      "GET",
      AutomaticCommandSchema,
      0,
      path,
    );
    if (!envelope.ok) return fleetV2Error(envelope.code);
    const { headers, bytes } = envelope;
    const db = getDb();
    const auth = await authenticateFleetRequest(db, headers, bytes, {
      method: "GET",
      path,
      now: new Date(),
    });
    if (!auth.ok) return fleetV2Error(auth.code);
    const result = await readFleetAutomaticReceipt(
      db,
      { sessionId: auth.auth.sessionId, revision: headers.revision },
      selector.data,
    );
    if (!result.ok) return fleetV2Error(result.code);
    return fleetV2Success(
      result.json,
      fleetV2RequestBinding({ method: "GET", path, ...headers }),
    );
  } catch {
    return fleetV2Error("service_unavailable");
  }
}
export function PUT() {
  return fleetV2Error("method_not_allowed", { allow: "GET" });
}
export const POST = PUT;
export const PATCH = PUT;
export const DELETE = PUT;
export const OPTIONS = PUT;
export function HEAD() {
  return fleetV2Error("method_not_allowed", { head: true, allow: "GET" });
}

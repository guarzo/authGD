import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { RecoveryBeginSchema } from "@/core/fleet-api-v2";
import { fleetV2Error, fleetV2Success } from "@/lib/fleet-api-v2";
import { readFleetV2PreSessionEnvelope } from "@/lib/fleet-recovery-http";
import { beginFleetRecovery } from "@/services/fleet-recovery";
import { RelayRefusal } from "@/services/fleet-relay";
export const dynamic = "force-dynamic";
const PATH = "/api/fleet/v2/recovery-challenges";
export async function POST(req: NextRequest) {
  const envelope = await readFleetV2PreSessionEnvelope(req, RecoveryBeginSchema, PATH);
  if ("response" in envelope) return envelope.response;
  try {
    const body = envelope.value;
    const result = await beginFleetRecovery(getDb(), {
      publicKeySpki: Buffer.from(body.public_key_spki_b64url, "base64url"),
      requestId: body.request_id,
      issuedAt: body.issued_at,
      initiationSignature: body.initiation_signature,
    });
    return fleetV2Success(result.json, envelope.binding);
  } catch (err) {
    if (
      err instanceof RelayRefusal &&
      (err.code === "unauthorized" ||
        err.code === "rate_limited" ||
        err.code === "feature_disabled")
    )
      return fleetV2Error(err.code);
    return fleetV2Error("service_unavailable");
  }
}
export function GET() {
  return fleetV2Error("method_not_allowed", { allow: "POST" });
}
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const OPTIONS = GET;
export function HEAD() {
  return fleetV2Error("method_not_allowed", { head: true, allow: "POST" });
}

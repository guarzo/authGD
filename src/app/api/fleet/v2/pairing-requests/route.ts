import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { PairingBeginSchema } from "@/core/fleet-api-v2";
import { fleetV2Error, fleetV2Success } from "@/lib/fleet-api-v2";
import { readFleetV2PreSessionEnvelope } from "@/lib/fleet-recovery-http";
import {
  beginPairing,
  InvalidDevicePublicKeyError,
  RevokedDeviceKeyError,
} from "@/services/fleet-pairing";
import { FleetDeviceKeyUnavailableError } from "@/services/fleet-key-identity";
import { FleetSharingDisabledError } from "@/services/fleet-sharing-mode";
export const dynamic = "force-dynamic";
const PATH = "/api/fleet/v2/pairing-requests";
export async function POST(req: NextRequest) {
  const envelope = await readFleetV2PreSessionEnvelope(req, PairingBeginSchema, PATH);
  if ("response" in envelope) return envelope.response;
  try {
    const result = await beginPairing(getDb(), {
      publicKeySpki: Buffer.from(envelope.value.public_key_spki_b64url, "base64url"),
      requestedCapabilities: envelope.value.requested_capabilities,
    });
    return fleetV2Success(result.json, envelope.binding);
  } catch (err) {
    if (err instanceof FleetSharingDisabledError) return fleetV2Error("feature_disabled");
    // Unknown/revoked/malformed keys remain indistinguishable before proof.
    if (
      err instanceof InvalidDevicePublicKeyError ||
      err instanceof RevokedDeviceKeyError ||
      err instanceof FleetDeviceKeyUnavailableError
    )
      return fleetV2Error("invalid_key");
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

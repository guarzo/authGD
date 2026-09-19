import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { PairingCompleteSchema } from "@/core/fleet-api-v2";
import { fleetV2Error, fleetV2Success } from "@/lib/fleet-api-v2";
import { readFleetV2PreSessionEnvelope } from "@/lib/fleet-recovery-http";
import {
  completePairing,
  DeviceBoundToAnotherAccountError,
  InvalidCompletionProofError,
  NonMemberApprovalError,
  PairingAlreadyConsumedError,
  PairingExpiredError,
  PairingNotApprovedError,
  PairingNotFoundError,
  RevokedDeviceKeyError,
} from "@/services/fleet-pairing";
import { FleetDeviceKeyUnavailableError } from "@/services/fleet-key-identity";
import { FleetSharingDisabledError } from "@/services/fleet-sharing-mode";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const path = `/api/fleet/v2/pairing-requests/${id}/complete`;
  const envelope = await readFleetV2PreSessionEnvelope(
    req,
    PairingCompleteSchema,
    path,
    id,
  );
  if ("response" in envelope) return envelope.response;
  try {
    const result = await completePairing(getDb(), {
      pairingId: id,
      completionSignature: envelope.value.completion_signature,
    });
    return fleetV2Success(result.json, envelope.binding);
  } catch (err) {
    if (err instanceof FleetSharingDisabledError) return fleetV2Error("feature_disabled");
    // A well-shaped selector conveys no existence, ownership or approval oracle.
    if (
      err instanceof PairingNotFoundError ||
      err instanceof PairingExpiredError ||
      err instanceof PairingAlreadyConsumedError ||
      err instanceof PairingNotApprovedError ||
      err instanceof InvalidCompletionProofError ||
      err instanceof NonMemberApprovalError ||
      err instanceof RevokedDeviceKeyError ||
      err instanceof DeviceBoundToAnotherAccountError ||
      err instanceof FleetDeviceKeyUnavailableError
    )
      return fleetV2Error("not_completable");
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

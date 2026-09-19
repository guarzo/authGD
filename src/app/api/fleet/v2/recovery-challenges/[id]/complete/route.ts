import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { RecoveryCompleteSchema } from "@/core/fleet-api-v2";
import { fleetV2Error, fleetV2Success } from "@/lib/fleet-api-v2";
import { readFleetV2PreSessionEnvelope } from "@/lib/fleet-recovery-http";
import { completeFleetRecovery } from "@/services/fleet-recovery";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const path = `/api/fleet/v2/recovery-challenges/${id}/complete`;
  const envelope = await readFleetV2PreSessionEnvelope(
    req,
    RecoveryCompleteSchema,
    path,
    id,
  );
  if ("response" in envelope) return envelope.response;
  try {
    const result = await completeFleetRecovery(getDb(), {
      challengeId: id,
      nonce: envelope.value.nonce,
      recoverySignature: envelope.value.recovery_signature,
    });
    if (!result.ok)
      return fleetV2Error(
        result.code === "feature_disabled" ? result.code : "unauthorized",
      );
    return fleetV2Success(result.json, envelope.binding);
  } catch {
    // Outer failure never claims a durable proof outcome or leaks driver details.
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
